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
	/** The first line after the view's omission marker: the lines before it are not shown. */
	afterCut?: boolean;
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
	let cut = false;
	for (const line of text.split("\n")) {
		// What follows the view's omission marker comes after lines that are not shown: the
		// gap to it is the cut, not a pause (400 lines 10 ms apart, 75 shown, used to read
		// "longest pause 5.24s").
		if (OMISSION_MARKER.test(line)) cut = true;
		const match = TIMELINE_LINE.exec(line);
		if (!match) continue;
		// Every width lands in microseconds, so durations stay one unit everywhere. Padded
		// to nine first: a trimmed `.225` is 225 000 µs, not 225. `=` is the line above.
		const us = match[3] === "=" ? previous : Number(match[1]) * 1_000_000 + Number((match[2] as string).padEnd(9, "0")) / 1000;
		previous = us;
		samples.push({ us, stream: match[4] as "out" | "err", text: match[5] as string, ...(cut ? { afterCut: true } : {}) });
		cut = false;
	}
	return samples;
}

/** A full stamp at the start of a line: the offset, as printed, and the stream. */
const FULL_STAMP = /^\[(\s*\d+\.\d{1,9}) (out|err)\] /;

/**
 * The line that separates what the command printed from what the capture says about it.
 *
 * With one stamp per burst most output lines carry no mark of their own, so the lines the
 * hooks module appends — the digest, the pointer into a cut view, the notes — need one
 * line in front of them to be told from output.
 */
export const NOTES_MARKER = "--- pi-time ---";

/**
 * A line the wrapper itself prints or appends. A line of the command's own that looks
 * like one keeps an explicit mark, so no reader can take it for the wrapper's.
 */
const WRAPPER_SHAPED = /^(?:run=R\d+ |timeline_lines=|captured_bytes=|(?:stdout|stderr)_artifact=|pgid=|pty=\S+ cols=|--- |pruned=\d+ keep=|timing: |truncated: |\.\.\. \[timeline truncated)/;

/** The default precision of an offset the model is shown: milliseconds. */
export const DEFAULT_STAMP_DIGITS = 3;

/** An offset as printed, cut to `digits` decimals and without its padding. */
function shortOffset(printed: string, digits: number): string {
	const [whole = "0", fraction = ""] = printed.trim().split(".");
	if (digits >= 9 || fraction.length <= digits) return printed.trim().replace(/^0+(?=\d)/, "");
	return `${whole.replace(/^0+(?=\d)/, "")}.${fraction.slice(0, digits)}`;
}

export interface StampOptions {
	/**
	 * Decimals an offset keeps. The capture has nanoseconds; what a reader needs from an
	 * offset is how long a step took, and the order is the order of the lines. Cut, never
	 * rounded, so an offset is never later than the event.
	 */
	digits?: number;
	/**
	 * One stamp per burst: a line that arrived at the same offset and on the same stream
	 * as the line above it carries no stamp at all. False keeps a stamp on every line.
	 */
	burst?: boolean;
}

/**
 * Say each offset once, and no more precisely than it is read.
 *
 * Measured on this plugin's own results (416 of them, 13,616 stamped lines): the stamps
 * were 22% of the text and, digits being what they are to a tokenizer, a third again on
 * top of the output in tokens — 9.7 tokens a line for `[0.030555209 out] `. Output
 * arrives in bursts: 54% of lines share their offset with the line above to the
 * nanosecond, 86% to the millisecond. So:
 *
 *     [0.031 out] total 0              a stamp starts a burst
 *     drwxr-xr-x  3 me staff 96 .     same offset, same stream: no stamp
 *     [= err] ls: x: No such file      same offset, other stream
 *     [= out] [INFO] done              same again, but the text needs a mark
 *     [2.320 out] done                 a later offset
 *
 * A line keeps a mark whenever leaving it bare could mislead: when its own text begins
 * with `[`, or has the shape of a line the wrapper prints. Anything that is not a
 * timeline line — the header, the cut in a truncated view, the notes — ends a burst, so
 * the line after it is stamped in full again.
 *
 * Lossless but for the decimals: `expandStamps` gives every line its stamp back. A model
 * asked eight questions with known answers about one result in this spelling (which
 * stream, what offset, how long between two lines, is this line output or a note)
 * answered all of them, in every run tried.
 */
export function compactStamps(text: string, options: StampOptions = {}): string {
	const digits = options.digits ?? DEFAULT_STAMP_DIGITS;
	const burst = options.burst !== false;
	let lastOffset: string | undefined;
	let lastStream: string | undefined;
	return text
		.split("\n")
		.map((line) => {
			const match = FULL_STAMP.exec(line);
			if (!match) {
				lastOffset = lastStream = undefined;
				return line;
			}
			const offset = shortOffset(match[1] as string, digits);
			const stream = match[2] as string;
			const rest = line.slice(match[0].length);
			const isSameOffset = burst && offset === lastOffset;
			const isSameStream = stream === lastStream;
			lastOffset = offset;
			lastStream = stream;
			if (!isSameOffset) return `[${offset} ${stream}] ${rest}`;
			if (!isSameStream || rest.startsWith("[") || WRAPPER_SHAPED.test(rest)) return `[= ${stream}] ${rest}`;
			return rest;
		})
		.join("\n");
}

/**
 * Give every line of a compacted timeline its stamp back: `[offset stream] text`.
 *
 * A line with no stamp belongs to the burst above it. Before the first stamp there is no
 * burst (the header, a notice), and the notes or the cut in a truncated view end one.
 */
export function expandStamps(text: string): string {
	let offset: string | undefined;
	let stream: string | undefined;
	return text
		.split("\n")
		.map((line) => {
			// The notes, and the cut in a truncated view, end a burst.
			if (line === NOTES_MARKER || OMISSION_MARKER.test(line)) {
				offset = stream = undefined;
				return line;
			}
			const full = /^\[(\d+\.\d{1,9}) (out|err)\] /.exec(line);
			if (full) {
				[offset, stream] = [full[1], full[2]];
				return line;
			}
			if (offset === undefined) return line;
			const same = /^\[= (out|err)\] /.exec(line);
			if (same) {
				stream = same[1];
				return `[${offset} ${stream}] ${line.slice(same[0].length)}`;
			}
			return `[${offset} ${stream}] ${line}`;
		})
		.join("\n");
}

/**
 * The run's header, with only what says something.
 *
 *     run=R12 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=328
 *     timeline_lines=3 shown=3 truncated=false stamp=ns res_ns=41
 *     --- timeline ---
 *
 * becomes `run=R12 exit_code=0 duration_ms=328`. Measured: 76 tokens a call for the three
 * lines, 20 for the one — and four results in ten are under 600 characters, where the
 * header was half the text. A flag is printed only when it is true, the line counts only
 * when the view was cut, and `--- timeline ---` not at all: the first stamp says where the
 * timeline begins. The sectioned view (`brief`) keeps its section markers, which are its
 * only structure, and loses the two artifact paths: `busybox log` reads a run by its id.
 */
export function slimHeader(text: string): string {
	const lines = text.split("\n");
	const start = lines.findIndex((line) => /^run=R\d+ /.test(line));
	if (start < 0) return text;
	const out = lines.slice(0, start);
	const head = lines[start] as string;
	const kept = head.split(" ").filter((pair) => !/^(?:timed_out|cancelled|idle)=false$/.test(pair));
	out.push(kept.join(" "));
	let index = start + 1;
	for (; index < lines.length && index < start + 8; index++) {
		const line = lines[index] as string;
		if (/^timeline_lines=\d+ shown=\d+ truncated=/.test(line)) {
			const counts = /^timeline_lines=\d+ shown=\d+ truncated=true/.exec(line);
			if (counts) out.push(counts[0]);
		} else if (/^captured_bytes=/.test(line)) {
			if (/\bview_truncated=true\b/.test(line)) out.push(line);
		} else if (/^(?:stdout|stderr)_artifact=/.test(line)) {
			// Dropped: the run's id is what `log` takes.
		} else if (line === "--- timeline ---") {
			index++;
			break;
		} else break;
	}
	return [...out, ...lines.slice(index)].join("\n");
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
	// The first line that is not blank, and only that one: `run` prints its header before
	// anything of the command's. A command that prints such a line itself (a saved result,
	// a note quoting one) used to be taken for a run and given that old run's TIMEOUT notice;
	// `log R --summary` starts `run=R84 lines=…` and was taken for a run that was killed.
	// (The host may put its own `Exit code N` line first; nothing else comes before it.)
	const start = lines.findIndex((line) => line.trim() !== "" && !/^Exit code -?\d+\s*$/.test(line));
	if (start < 0 || !/^run=R\d+ exit_code=/.test(lines[start] as string)) return undefined;
	const head = lines[start] as string;
	const field = (name: string) => new RegExp(` ${name}=(\\S+)`).exec(head)?.[1];
	const number = (value: string | undefined) => (value !== undefined && /^-?\d+$/.test(value) ? Number(value) : undefined);
	// The lines between `run=` and the first section marker are the wrapper's own.
	let counts: RegExpExecArray | null = null;
	let isViewCut = false;
	for (const line of lines.slice(start + 1, start + 8)) {
		if (SECTION_START.test(line) || /^\[/.test(line)) break;
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
	if (samples.length === 0) return undefined;
	// One line is not a shape — unless the run then sat silent: `echo started; sleep 5` used
	// to say nothing about the five seconds.
	if (samples.length === 1 && (durationMs ?? 0) * 1_000 - (samples[0] as TimelineSample).us < (options.minGapUs ?? 1_000_000)) return undefined;
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
		if (current.afterCut) continue;
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
		samples.some((sample) => sample.afterCut) ? `${samples.length} lines shown` : `${samples.length} line${samples.length === 1 ? "" : "s"}`,
		`output from ${seconds(first.us)}`,
	];
	if (samples.some((sample) => sample.stream === "err")) {
		const firstErr = samples.find((sample) => sample.stream === "err") as TimelineSample;
		parts.push(`stderr from ${seconds(firstErr.us)}`);
	}
	if (gapUs >= minGapUs) parts.push(`longest pause ${seconds(gapUs)} (${seconds(gapFrom)} → ${seconds(gapFrom + gapUs)})`);
	if (totalUs - last.us >= minGapUs) parts.push(`silent ${seconds(totalUs - last.us)} after the last line (${seconds(last.us)} → ${seconds(totalUs)})`);
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
			hidden === undefined ? "it may hold stderr lines this view does not show" : hidden === 0 ? "none of them on stderr" : `${hidden} of them on stderr`;
		// The binary's path is long (twenty tokens here) and was said three times.
		return `truncated: ${scale} — the first ${head} and the last ${count - head}. Lines ${from}-${to} are omitted, ${errors}. The capture is complete: ${busybox} log ${runId} --stream timeline --lines ${from}:${Math.min(to, from + 39)} reads part of the gap; with --match STR in place of --stream and --lines it finds a literal anywhere${hidden ? ", and with --stream stderr alone it shows the stderr lines" : ""}`;
	}
	if (header.linesTotal === undefined) {
		// The sectioned view (`brief`): no line counts, each stream cut on its own.
		return `truncated: the view was cut to its budget — the capture is complete; ${busybox} log ${runId} --stream stdout --lines A:B reads a stream (or stderr), and --match STR in place of those finds a literal`;
	}
	// A build before 0.6.0 keeps the head only, so the useful thing to name is the tail:
	// that is where a test suite's verdict lives.
	const from = Math.max(1, total - 40);
	return `truncated: ${scale}, head only — the capture is complete; ${busybox} log ${runId} --stream timeline --lines ${from}:${total} reads the end, and --match STR in place of --stream and --lines finds a literal`;
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
export function describeTimeout(options: { seconds?: number; runId?: string; busybox?: string; isPersons?: boolean; cpu?: string } = {}): string {
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
	// Whether more time would have helped is what the processor says, when it was watched.
	if (options.cpu) lines.push(options.cpu);
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
	seen: { cpu?: string; stuck?: { seconds: number; cpuSeconds?: number } } = {},
): string | undefined {
	const header = parseHeader(text);
	if (!header) return undefined;
	// Stopped by the hooks module for showing no sign of life: the run's own header only
	// knows that its command was ended by a signal, so this is said first.
	if (seen.stuck && !header.timedOut) {
		return describeIdle({ seconds: seen.stuck.seconds, runId: header.runId, busybox, isPersons, stdinBlocks, quietCpuSeconds: seen.stuck.cpuSeconds, hostExit: 1 });
	}
	if (header.timedOut) {
		// Cite a budget only when the run's own duration says that budget is the one that
		// fired. A caller-supplied timeout beats the default, and a notice naming "the 120s
		// deadline" on a 599s kill would be a lie the model might act on.
		const budget = budgetThatFired(header.durationMs, seconds);
		return describeTimeout({ seconds: budget, runId: header.runId, busybox, isPersons, cpu: seen.cpu });
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
	options: {
		seconds?: number;
		runId?: string;
		busybox?: string;
		isPersons?: boolean;
		stdinBlocks?: boolean;
		/** Processor seconds used during the silence, when the processor was watched: then it was idle too. */
		quietCpuSeconds?: number;
		/** The status the host reports for the stopped call: 3 from the applet's own limit, 1 when the hooks module stopped it. */
		hostExit?: number;
	} = {},
): string {
	const busybox = options.busybox ?? "busybox";
	const silence = options.seconds ? `${options.seconds}s` : "the configured time";
	const wasWatched = options.quietCpuSeconds !== undefined;
	const lines = [
		wasWatched
			? `IDLE — not a failure of the command and not its deadline: for ${silence} it printed nothing and used no processor time to speak of (${(options.quietCpuSeconds as number).toFixed(1)}s), so it was waiting, not working, and was stopped as stuck.`
			: `IDLE — not a failure of the command and not its deadline: it printed nothing for ${silence}, so it was taken to be stuck and stopped.`,
		`\`exit_code=-1\` in the header below and the "Exit code ${options.hostExit ?? 3}" line are the kill status, not the command's own exit code.`,
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
				} what else blocks — a lock, a socket, a child process that never exits, or a prompt that opens the terminal itself (\`sudo\`, \`ssh\`), which needs a flag that answers it. ${
					wasWatched
						? "A larger `timeout` will not help a command that is waiting; one that is meant to wait (a `sleep`, a server) belongs in `run_in_background: true`."
						: "If it was working quietly, a larger `timeout` will not help: make it report progress (a verbose flag; output on either stream counts), or run it with `run_in_background: true`."
				}`,
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
