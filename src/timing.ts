/*
 * claude-managed-tools — Pi-Time for Claude Code: every Bash call comes back as a timeline.
 * Copyright (C) 2026 Robert Currie
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; version 2 of the License only.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
 * PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with this
 * program; if not, see <https://www.gnu.org/licenses/gpl-2.0.html>.
 */
/**
 * One line that says what the offsets mean.
 *
 * A timeline answers "in what order", but the useful question about a slow command is
 * usually "where did the time go": three seconds after the last line? A stall between
 * two phases? Eight minutes of silence before the failure? A model reading 300 timestamped
 * lines can work that out, and pays attention for it every time; a summary costs one line.
 *
 * Only the shape is summarised — total, where output started, the longest silence — so a
 * caller can still read the offsets when the summary is not the question.
 */

export interface TimelineSample {
	/** Microseconds from process start, as the timeline prints them. */
	us: number;
	stream: "out" | "err";
	text: string;
}

/**
 * A timeline line, in every shape a build has printed it:
 *
 *     [   0.011354 out] ok 1        padded, six digits                  (to 0.5.x)
 *     [00000.005868042 out] ok 1    zero-padded, nine with -n           (0.6.0)
 *     [0.005868042 out] ok 1        unpadded, always nine with -n       (0.6.1 on)
 *     [0.011354 out] ok 1           unpadded, six below one second      (0.6.1 on, no -n)
 *     [1.225 out], [10.23 out]      and fewer as the offset grows       (0.6.1 on, no -n)
 *     [= out] ok 2                  the offset of the line above        (compactStamps)
 *
 * The unpadded short shapes were measured, not documented: without `-n` that build keeps
 * about four significant figures past the first second. The wrapper asks for `-n` whenever
 * a build has it, so it meets the nine-digit shapes; the others are read for a build that
 * does not, and for text a person pastes.
 *
 * So the fraction is one to nine digits and is read as a decimal fraction, never as a
 * count of a fixed unit: `.225` is 225 ms whether six digits or nine were on offer. The
 * `s` flag matters: a line from a CRLF file ends in a carriage return, which `.` does not
 * match without it, and such a line would silently drop out of the digest.
 */
const TIMELINE_LINE = /^\[(?:\s*(\d+)\.(\d{1,9})|(=)) (out|err)\] (.*)$/s;

/** The wrapper's own summary line: `run=R12 exit_code=0 … duration_ms=328`. */
const RUN_HEADER = /^run=R\d+ .*duration_ms=(\d+)/;

/** Parse the text-mode timeline the bash wrapper produces. */
export function parseTimeline(text: string): TimelineSample[] {
	const samples: TimelineSample[] = [];
	let previous = 0;
	for (const line of text.split("\n")) {
		const match = TIMELINE_LINE.exec(line);
		if (!match) continue;
		// Every width lands in microseconds, so durations stay one unit everywhere. Padded
		// to nine first: a trimmed `.225` is 225 000 µs, not 225. `=` is the line above.
		const us = match[3] === "=" ? previous : Number(match[1]) * 1_000_000 + Number((match[2] as string).padEnd(9, "0")) / 1000;
		previous = us;
		samples.push({ us, stream: match[4] as "out" | "err", text: match[5] as string });
	}
	return samples;
}

/** A full stamp at the start of a line, and the offset inside it. */
const FULL_STAMP = /^\[(\s*\d+\.\d{1,9}) (out|err)\] /;

/**
 * Print an offset once per burst: a line that arrived at the same offset as the line
 * above it carries `[= out]` instead of the digits again.
 *
 * Measured in pi-managed-tools on thirteen sessions: stamps were a quarter of all
 * bash-result bytes, and most output arrives in bursts — a listing, a file, a test summary
 * flushed at once — where every line repeats the same eighteen characters. The stream tag
 * stays on every line; only the repeated number goes. Lossless: `parseTimeline` reads `=`
 * back as the offset above.
 *
 * Only timeline lines are touched; the header, the truncation marker and anything
 * appended after the timeline end a burst and are left as they are.
 */
export function compactStamps(text: string): string {
	let last: string | undefined;
	return text
		.split("\n")
		.map((line) => {
			const match = FULL_STAMP.exec(line);
			if (!match) {
				last = undefined;
				return line;
			}
			const offset = (match[1] as string).trim();
			if (offset === last) return `[= ${match[2]}] ${line.slice(match[0].length)}`;
			last = offset;
			return line;
		})
		.join("\n");
}

/** What the run's own header lines say, field by field. */
export interface RunHeader {
	runId: string;
	exitCode?: number;
	timedOut: boolean;
	cancelled: boolean;
	idle: boolean;
	durationMs?: number;
	/** Lines the command printed in all, and how many of them the view shows. */
	linesTotal?: number;
	linesShown?: number;
	truncated: boolean;
}

/** Where the wrapper's header ends and the command's own output begins. */
const SECTION_START = /^--- (?:timeline|stdout|stderr) ---$/;

/**
 * Read the header of a wrapped result, or undefined when the text is not one.
 *
 * Field by field off the header lines and nowhere else: the header gains fields between
 * builds (`idle=` arrived in 0.6.0), and a command that prints `timed_out=true` or
 * `truncated=true` in its own output has neither timed out nor been truncated. That last
 * one was met in use: a diff that quoted the words `truncated=true` came back with
 * "137 of 137 lines shown, head only".
 */
export function parseHeader(text: string): RunHeader | undefined {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => /^run=R\d+ /.test(line));
	if (start < 0) return undefined;
	const head = lines[start] as string;
	const field = (name: string) => new RegExp(` ${name}=(\\S+)`).exec(head)?.[1];
	const number = (value: string | undefined) => (value !== undefined && /^-?\d+$/.test(value) ? Number(value) : undefined);
	// The lines between `run=` and the first section marker are the wrapper's own.
	let counts: RegExpExecArray | null = null;
	let isViewCut = false;
	for (const line of lines.slice(start + 1, start + 8)) {
		if (SECTION_START.test(line)) break;
		counts ??= /^timeline_lines=(\d+) shown=(\d+) truncated=(true|false)/.exec(line);
		if (/^captured_bytes=.*\bview_truncated=true\b/.test(line)) isViewCut = true;
	}
	return {
		runId: /^run=(R\d+) /.exec(head)?.[1] as string,
		exitCode: number(field("exit_code")),
		timedOut: field("timed_out") === "true",
		cancelled: field("cancelled") === "true",
		idle: field("idle") === "true",
		durationMs: number(field("duration_ms")),
		linesTotal: counts ? Number(counts[1]) : undefined,
		linesShown: counts ? Number(counts[2]) : undefined,
		truncated: counts ? counts[3] === "true" : isViewCut,
	};
}

/** Total wall time the wrapper reported, in milliseconds. */
export function parseDurationMs(text: string): number | undefined {
	for (const line of text.split("\n")) {
		const match = RUN_HEADER.exec(line);
		if (match) return Number(match[1]);
	}
	return undefined;
}

function seconds(us: number): string {
	return `${(us / 1_000_000).toFixed(2)}s`;
}

/**
 * The one-line shape of a run: `timing: 8.42s total, 412 lines, output from 0.02s,
 * silent 6.10s (2.32s → 8.42s)`, or undefined when there is nothing worth saying.
 *
 * "Nothing worth saying" is deliberate: a command that finished in 40 ms with five lines
 * gets no line, because a summary on every call is noise the model pays for.
 */
export function summarizeTiming(
	samples: TimelineSample[],
	durationMs?: number,
	options: { minDurationMs?: number; minGapUs?: number } = {},
): string | undefined {
	if (samples.length < 2) return undefined;
	const minDurationMs = options.minDurationMs ?? 1_000;
	const minGapUs = options.minGapUs ?? 1_000_000;

	const first = samples[0] as TimelineSample;
	const last = samples[samples.length - 1] as TimelineSample;
	const totalUs = (durationMs ?? 0) * 1_000 > last.us ? (durationMs as number) * 1_000 : last.us;

	let gapUs = 0;
	let gapFrom = 0;
	let gaps = 0;
	for (let i = 1; i < samples.length; i++) {
		const previous = samples[i - 1] as TimelineSample;
		const current = samples[i] as TimelineSample;
		const delta = current.us - previous.us;
		if (delta > gapUs) {
			gapUs = delta;
			gapFrom = previous.us;
		}
		if (delta >= minGapUs) gaps++;
	}

	if (totalUs < minDurationMs * 1_000) return undefined;

	const parts = [
		`${seconds(totalUs)} total`,
		`${samples.length} lines`,
		`output from ${seconds(first.us)}`,
	];
	if (samples.some((sample) => sample.stream === "err")) {
		const firstErr = samples.find((sample) => sample.stream === "err") as TimelineSample;
		parts.push(`stderr from ${seconds(firstErr.us)}`);
	}
	if (gapUs >= minGapUs) {
		const endsWithGap = totalUs - last.us >= minGapUs;
		parts.push(
			endsWithGap
				? `silent ${seconds(totalUs - last.us)} after the last line (${seconds(last.us)} → ${seconds(totalUs)})`
				: `longest pause ${seconds(gapUs)} (${seconds(gapFrom)} → ${seconds(gapFrom + gapUs)})`,
		);
	}
	if (gaps > 1) parts.push(`${gaps} pauses over ${seconds(minGapUs)}`);
	return `timing: ${parts.join(", ")}`;
}

/** `run=R12 …`, or undefined when the text is not a wrapped run. */
export function parseRunId(text: string): string | undefined {
	return text.match(/^run=(R\d+)\b/m)?.[1];
}

/** `... [timeline truncated: 183 of 6000 lines shown (5817 omitted); …] ...`, as `run` prints it. */
const OMISSION_MARKER = /^\.\.\. \[timeline truncated: \d+ of \d+ lines shown \((\d+) omitted\)/;

/**
 * The pointer a truncated wrapper view needs.
 *
 * The wrapper's budget sits under the host's own inline limit, so the host never sees a
 * truncation and never offers a file — the model is left with `truncated=true` and no way
 * to say "get me the middle". The capture is complete on disk, so name the command that
 * reads it. `busybox` is how to call the binary: an absolute path here, because the
 * packaged build is not on `PATH` and a host `busybox` has no `log` applet.
 *
 * Since 0.6.0 `run` keeps the head *and* the tail of a long timeline and marks the cut
 * between them. The hint used to say "head only … read the end" regardless, and sent the
 * model to the last forty lines — which it already had. What it lacks is the middle, so
 * the hint names that range, and how many of the omitted lines are on stderr when the
 * caller could ask (`log --summary`): a view with no `[err]` line reads as "no errors"
 * when the errors are in the part that was cut.
 */
export function truncationHint(text: string, busybox = "busybox", options: { stderrTotal?: number } = {}): string | undefined {
	const header = parseHeader(text);
	if (!header) {
		// No header to read: only the counts line itself, at the start of a line, counts.
		if (!/^timeline_lines=\d+ shown=\d+ truncated=true/m.test(text)) return undefined;
		const lost = /^timeline_lines=(\d+) shown=(\d+)/m.exec(text);
		return `truncated: ${lost?.[2]} of ${lost?.[1]} lines shown — the full capture is on disk (${busybox} log needs a run id, which this view did not carry)`;
	}
	if (!header.truncated) return undefined;
	const runId = header.runId;
	const total = header.linesTotal ?? 0;
	const count = header.linesShown ?? 0;
	const scale = header.linesTotal !== undefined ? `${count} of ${total} lines shown` : "the view was truncated";

	const lines = text.split("\n");
	const cut = lines.findIndex((line) => OMISSION_MARKER.test(line));
	if (cut >= 0) {
		let head = 0;
		let errShown = 0;
		for (const [index, line] of lines.entries()) {
			const match = TIMELINE_LINE.exec(line);
			if (!match) continue;
			if (index < cut) head++;
			if (match[4] === "err") errShown++;
		}
		const omitted = Number(OMISSION_MARKER.exec(lines[cut] as string)?.[1] ?? total - count);
		const from = head + 1;
		const to = head + omitted;
		const hidden = options.stderrTotal !== undefined ? Math.max(0, options.stderrTotal - errShown) : undefined;
		const errors =
			hidden === undefined
				? "it may hold stderr lines this view does not show"
				: hidden === 0
					? "none of them on stderr"
					: `${hidden} of them on stderr (${busybox} log ${runId} --stream stderr shows those alone)`;
		return `truncated: ${scale} — the first ${head} and the last ${count - head}. Lines ${from}-${to} are omitted, ${errors}. The capture is complete: read part of the gap with ${busybox} log ${runId} --stream timeline --lines ${from}:${Math.min(to, from + 39)}, or find a literal anywhere in it with ${busybox} log ${runId} --match STR`;
	}
	if (header.linesTotal === undefined) {
		// The sectioned view (`brief`): no line counts, each stream cut on its own.
		return `truncated: the view was cut to its budget — the capture is complete; read a stream with ${busybox} log ${runId} --stream stdout --lines A:B (or stderr), or a pattern with ${busybox} log ${runId} --match STR`;
	}
	// A build before 0.6.0 keeps the head only, so the useful thing to name is the tail:
	// that is where a test suite's verdict lives.
	const from = Math.max(1, total - 40);
	return `truncated: ${scale}, head only — the capture is complete; read the end with ${busybox} log ${runId} --stream timeline --lines ${from}:${total}, or a pattern with ${busybox} log ${runId} --match STR`;
}

/**
 * The sentence a timeout needs, and never a euphemism.
 *
 * The wrapper exits 3 and prints `exit_code=-1 timed_out=true`; the host then leads the
 * result with "Exit code 3". Read together those look like the *command* failed, which
 * sends a model down a debugging path when the right move is to retry with more time or
 * narrow the command. So the result says plainly what happened, what the statuses mean, and
 * what to do next — including that the kill was deliberate.
 *
 * Every notice here is written to stand *before* the output it is about: a result used to
 * open with `exit_code=-1`, then up to 24 KB of timeline, and only then say that nothing
 * had failed.
 */
export function describeTimeout(options: { seconds?: number; runId?: string; busybox?: string; isPersons?: boolean } = {}): string {
	const busybox = options.busybox ?? "busybox";
	const budget = options.seconds ? `the ${options.seconds}s deadline` : "its deadline";
	const lines = [
		`TIMEOUT — not a failure of the command: it was still running when ${budget} fired, so it was killed.`,
		'`exit_code=-1` in the header below and the "Exit code 3" line are the kill status, not the command\'s own exit code.',
	];
	if (options.runId) {
		lines.push(
			`Everything it printed before the kill follows and the capture is complete: ${busybox} log ${options.runId} --stream timeline --lines 1:40 reads it again.`,
		);
	}
	lines.push(
		options.isPersons
			? // A command the person typed has no `timeout` parameter to raise: the deadline
				// that stopped it is the plugin's default, and the switch for it is theirs.
				"The user ran this themselves, so there is no `timeout` to raise on a call: it was stopped by Pi-Time's default deadline for every command. `/pi-time timeout <seconds>` gives their commands longer for this session (`off` removes the deadline); the `timeoutSeconds` option or `CLAUDE_MANAGED_TOOLS_TIMEOUT` sets it for good."
			: "Recovery: raise `timeout` on this call (milliseconds) if the work is genuinely long, narrow the command, or run it with `run_in_background: true` and check on it later.",
	);
	return lines.join("\n");
}

/** The sentence for a cancelled run, which is a different situation from a timeout. */
export function describeCancellation(runId?: string, busybox = "busybox"): string {
	const lines = [
		"CANCELLED — the command was stopped on request (interrupt or abort), not because it failed.",
		"The capture so far is complete" + (runId ? `: ${busybox} log ${runId} reads it again.` : "."),
	];
	return lines.join("\n");
}

/**
 * Which notice a wrapper result needs, if any: a deadline, a silence, a cancellation or
 * a signal.
 *
 * Read off the run's own header line and nowhere else — a command that prints
 * `timed_out=true` in its output has not timed out.
 *
 * `isPersons` marks a command the person ran themselves (`!`, `/sh`): a deadline's notice
 * then names the switch they have, since there is no call whose `timeout` could be raised.
 * `stdinBlocks` is true in the one terminal mode (`raw`) where a read on stdin waits.
 */
export function outcomeNotice(
	text: string,
	seconds?: number,
	busybox = "busybox",
	idleSeconds?: number,
	isPersons = false,
	stdinBlocks = false,
): string | undefined {
	const header = parseHeader(text);
	if (!header) return undefined;
	if (header.timedOut) {
		// Cite a budget only when the run's own duration says that budget is the one that
		// fired. A caller-supplied timeout beats the default, and a notice naming "the 120s
		// deadline" on a 599s kill would be a lie the model might act on.
		const budget = budgetThatFired(header.durationMs, seconds);
		return describeTimeout({ seconds: budget, runId: header.runId, busybox, isPersons });
	}
	// Before the signal check: a run stopped for silence also prints `exit_code=-1`.
	if (header.idle) return describeIdle({ seconds: idleSeconds, runId: header.runId, busybox, isPersons, stdinBlocks });
	if (header.cancelled) return describeCancellation(header.runId, busybox);
	if (header.exitCode === -1) return describeSignal();
	return undefined;
}

/**
 * The sentence for a command stopped because it went silent (`--idle-timeout`).
 *
 * Not a deadline and not a failure: the command printed nothing for the configured time
 * and was taken to be stuck. The notice used to offer "give it the input it was waiting
 * for" first; measured, that is the one thing it cannot have been waiting for — a
 * command's stdin is at end-of-file here, so a read returns at once (on plain pipes and
 * in the `split` and `merged` terminal modes; in `raw` a read does wait, and the notice
 * says so instead). What blocks otherwise is a lock, a socket, a child that never exits,
 * or a prompt that opens the terminal itself.
 */
export function describeIdle(
	options: { seconds?: number; runId?: string; busybox?: string; isPersons?: boolean; stdinBlocks?: boolean } = {},
): string {
	const busybox = options.busybox ?? "busybox";
	const silence = options.seconds ? `${options.seconds}s` : "the configured time";
	const lines = [
		`IDLE — not a failure of the command and not its deadline: it printed nothing for ${silence}, so it was taken to be stuck and stopped.`,
		'`exit_code=-1` in the header below and the "Exit code 3" line are the kill status, not the command\'s own exit code.',
	];
	if (options.runId) {
		lines.push(`What it printed before the silence follows and the capture is complete: ${busybox} log ${options.runId} --stream timeline --lines 1:40 reads it again.`);
	}
	lines.push(
		options.isPersons
			? // Their command, their switch: no call was made whose shape could be changed.
				"The user ran this themselves. If it was working quietly rather than stuck, `/pi-time idle <seconds>` allows their commands a longer silence for this session (`off` removes the limit); the `idleSeconds` option or `CLAUDE_MANAGED_TOOLS_IDLE` sets it for good."
			: `${
					options.stdinBlocks
						? "If it was stuck, it may have been reading standard input: in this terminal mode a read there never returns, so give the answer in the command (`printf 'y\\n' | cmd`, `cmd < file`, a flag). Otherwise look at"
						: "If it was stuck, it was not on standard input: stdin is empty here and a read returns end-of-file at once. Look at"
				} what else blocks — a lock, a socket, a child process that never exits, or a prompt that opens the terminal itself (\`sudo\`, \`ssh\`), which needs a flag that answers it. If it was working quietly, a larger \`timeout\` will not help: make it report progress (a verbose flag; output on either stream counts), or run it with \`run_in_background: true\`.`,
	);
	return lines.join("\n");
}

/**
 * The sentence for a command whose own shell was ended by a signal.
 *
 * The wrapper has no exit status to report, prints `exit_code=-1` and exits 1, and the
 * host then says "Exit code 1" — which reads like an ordinary failure with status 1.
 */
export function describeSignal(): string {
	return [
		"KILLED — the command's shell was ended by a signal; it did not exit on its own.",
		'`exit_code=-1` in the header below and the "Exit code 1" line are placeholders, not a status the command returned.',
	].join("\n");
}

/** The budget, when the run died within ~2s of it — i.e. when that budget is the one that killed it. */
function budgetThatFired(durationMs: number | undefined, seconds?: number): number | undefined {
	if (!seconds) return undefined;
	if (durationMs === undefined) return seconds;
	return Math.abs(durationMs / 1000 - seconds) <= 2 ? seconds : undefined;
}
