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
 * program; if not, see <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.
 */
/**
 * What a command is doing while it runs: its output as it arrives, and whether it is alive.
 *
 * `busybox run` prints nothing of its own until the command has exited, which is right for
 * the model — one bounded, ordered view — and wrong for the person watching, who saw an
 * empty tool call for as long as the command took. And "no output for two minutes" was the
 * only evidence of a hang the wrapper had, which is no evidence at all about a compiler
 * that is working and has nothing to say.
 *
 * Two things are observable while a command runs, both measured:
 *
 * - the capture. `run` appends the child's bytes to `stdout` and `stderr` in its own
 *   folder as they arrive, so the person's view is read from there;
 * - the processor. The command's shell leads its own process group, and `ps` gives the
 *   CPU time of every process in it: a silent loop showed 1.02 s after one second and
 *   2.04 s after two. A command that is waiting — on a lock, a socket, a prompt — shows
 *   none.
 *
 * Finding the folder and the group is the one hard part: `run` only says which folder is
 * its own when it exits. The child knows both, though (`run` exports `BUSYBOX_RUN_DIR`,
 * and the shell knows its own pid), so one line at the front of the command writes them
 * into a file only this call knows about.
 *
 * Nothing here changes what the model is sent while the command runs. Pure: the hooks
 * module reads the files, runs `ps` and draws.
 */

/** The variable that names, to the command's shell, the file it reports itself in. */
export const LIVE_FILE_VAR = "PITIME_LIVE_FILE";

/**
 * The line at the front of the command: the run's folder and the shell's pid, on two lines.
 *
 * The braces matter: a redirect that cannot be opened is reported by the shell itself, on
 * the stderr in force *around* the command — which `2>/dev/null` on the same command does
 * not cover, and the message would land in the command's own stderr. In Claude Code's
 * sandbox the file cannot be written; then nothing is, and the call has no live view.
 */
export const LIVE_PRELUDE = `{ printf '%s\\n%s\\n' "$BUSYBOX_RUN_DIR" "$$" >"$${LIVE_FILE_VAR}"; } 2>/dev/null; `;

/** The folder, under the plugin's data folder, that holds one small file per running call. */
export function liveDir(dataDir: string): string {
	return `${dataDir.replace(/\/+$/, "")}/live`;
}

/** The file a call reports itself in: named by the call, so no two calls share one. */
export function liveFile(dataDir: string, callId: string): string {
	return `${liveDir(dataDir)}/${callId.replace(/[^A-Za-z0-9_-]/g, "_").slice(-80) || "call"}`;
}

export interface LivePointer {
	/** The run's own folder, where `stdout` and `stderr` grow as the command writes. */
	runDir: string;
	/** The command's shell, which leads its own process group. */
	pgid: number;
}

/**
 * Read what the command's shell wrote, or undefined while it is half-written or wrong.
 *
 * Both lines are checked for shape before either is used: the folder must be a run's
 * (`…/busybox-run/R<digits>`), and the group a number no smaller than 2 — a signal to
 * group 0 or 1 would reach this process's own group, or everything.
 */
export function parsePointer(text: string): LivePointer | undefined {
	const [dir = "", pid = ""] = text.split("\n");
	if (!/^\/.*\/busybox-run\/R\d+$/.test(dir) || dir.includes("/../")) return undefined;
	if (!/^\d{1,10}$/.test(pid) || Number(pid) < 2) return undefined;
	return { runDir: dir, pgid: Number(pid) };
}

/** How many of the newest lines a running call shows. */
export const LIVE_ROWS = 6;

/** How wide a shown line may be before it is cut. */
export const LIVE_COLUMNS = 160;

/**
 * The newest lines of what a command has printed, as a terminal would show them.
 *
 * `\r\n` is a line end, and a bare `\r` returns to the start of the line, so of a progress
 * bar redrawn fifty times only the last drawing is kept. Colour and cursor sequences are
 * taken out; an unfinished last line (a prompt, a progress bar) is shown as it stands.
 */
export class LiveTail {
	private lines: string[] = [];
	private partial = "";
	private readonly keep: number;

	constructor(keep: number = LIVE_ROWS) {
		this.keep = keep;
	}

	push(chunk: string): void {
		const text = (this.partial + chunk).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, "");
		const parts = text.split("\n");
		this.partial = parts.pop() ?? "";
		for (const part of parts) this.lines.push(afterReturns(part));
		if (this.lines.length > this.keep * 4) this.lines = this.lines.slice(-this.keep);
	}

	/** The last `rows` lines, the unfinished one included. */
	shown(rows: number = this.keep): string[] {
		const tail = afterReturns(this.partial);
		const all = tail === "" ? this.lines : [...this.lines, tail];
		return all.slice(-rows).map((line) => (line.length > LIVE_COLUMNS ? `${line.slice(0, LIVE_COLUMNS - 1)}…` : line));
	}
}

/** What is left of a line once its carriage returns have been obeyed. */
function afterReturns(line: string): string {
	const trimmed = line.replace(/\r+$/, "");
	const at = trimmed.lastIndexOf("\r");
	return at < 0 ? trimmed : trimmed.slice(at + 1);
}

/**
 * A CPU time as `ps -o time=` prints it, in seconds.
 *
 * macOS prints minutes, seconds and hundredths (`0:01.02`, `13:24.13`); Linux prints
 * hours, minutes and seconds, with days in front when there are any (`00:00:07`,
 * `1-02:03:04`).
 */
export function parseCpuTime(text: string): number | undefined {
	const match = /^(?:(\d+)-)?(\d+):(\d+)(?::(\d+))?(\.\d+)?$/.exec(text.trim());
	if (!match) return undefined;
	const [, days = "0", first = "0", second = "0", third, fraction = "0"] = match;
	const seconds = third === undefined ? Number(first) * 60 + Number(second) : Number(first) * 3600 + Number(second) * 60 + Number(third);
	return Number(days) * 86_400 + seconds + Number(fraction);
}

/** What `ps` is asked for: every process, its group and its CPU time. */
export const PS_ARGV: readonly string[] = ["ps", "-A", "-o", "pgid=,time="];

/**
 * The CPU time of one process group, summed from `ps -A -o pgid=,time=`.
 *
 * Undefined when no process of the group is listed (it has ended) or a line cannot be
 * read: "unknown" must not be mistaken for "idle".
 */
export function groupCpuSeconds(psOutput: string, pgid: number): number | undefined {
	let total: number | undefined;
	for (const line of psOutput.split("\n")) {
		const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
		if (!match || Number(match[1]) !== pgid) continue;
		const seconds = parseCpuTime(match[2] as string);
		if (seconds === undefined) return undefined;
		total = (total ?? 0) + seconds;
	}
	return total;
}

/**
 * How much of one processor counts as "doing something": a hundredth.
 *
 * A command that is blocked uses none; one that polls once a second with a `sleep` between
 * uses a few thousandths; a compiler, a test run or a loop uses most of a processor or
 * several. The line sits between the first two and the last, on the side of leaving a
 * command alone: one that is using the processor at all is not stopped for being quiet.
 */
export const BUSY_SHARE = 0.01;

/** CPU use as it has been sampled so far. */
export interface CpuReading {
	/** Processor seconds the group has used since sampling began. */
	total: number;
	/** The share of one processor it used between the last two samples (1 is a whole one). */
	recentShare: number;
	/** Processor seconds used since the command last printed anything. */
	sinceOutput: number;
}

/** A running tally of a group's CPU use, fed one `ps` sample at a time. */
export class CpuMeter {
	private last: { seconds: number; at: number } | undefined;
	private total = 0;
	private sinceOutput = 0;
	private recentShare = 0;
	private samples = 0;
	private first: number | undefined;

	/** Take one sample: the group's summed CPU time, and when it was read. */
	sample(seconds: number | undefined, at: number): void {
		if (seconds === undefined) return;
		if (this.last && at > this.last.at) {
			// A child that exits takes its time off the sum: never count a step backwards.
			const used = Math.max(0, seconds - this.last.seconds);
			this.total += used;
			this.sinceOutput += used;
			this.recentShare = used / ((at - this.last.at) / 1000);
		}
		if (!this.last) {
			// The group was made for this command, so what it has used by the first sample
			// is what the command used before anyone looked. (Met live: a command that ran
			// at a whole processor for eight seconds was said to have used 5.9.)
			this.total = seconds;
			this.sinceOutput += seconds;
		}
		this.last = { seconds, at };
		this.first ??= at;
		this.samples++;
	}

	/** The command printed something: the silence, and its CPU, start again from here. */
	sawOutput(): void {
		this.sinceOutput = 0;
	}

	/**
	 * Undefined until two samples have been taken (one sample is a number, not a rate),
	 * and again once the newest is older than `maxAgeMs`: a reading that has stopped being
	 * refreshed says nothing about now.
	 */
	reading(now?: number, maxAgeMs?: number): CpuReading | undefined {
		if (this.samples < 2 || !this.last) return undefined;
		if (now !== undefined && maxAgeMs !== undefined && now - this.last.at > maxAgeMs) return undefined;
		return { total: this.total, recentShare: this.recentShare, sinceOutput: this.sinceOutput };
	}

	/** When sampling began, for how much of a silence the samples cover. */
	since(): number | undefined {
		return this.first;
	}
}

/** Whether a reading shows the processor in use just now. */
export function isBusy(reading: CpuReading | undefined): boolean | undefined {
	return reading === undefined ? undefined : reading.recentShare >= BUSY_SHARE;
}

/**
 * Whether a silent command is to be stopped as stuck.
 *
 * Silence alone used to decide, and it stopped a quiet compile along with a hang. A sign
 * of life is now either of two things: a line on either stream, or processor time. A
 * command is stuck when it has had neither for the whole of the limit.
 *
 * Where the processor cannot be read at all (`ps` failed, or the samples cover less than
 * most of the silence), silence decides as it did before: an unknown must not let a hang
 * run on. `cpuWatchedMs` is how much of the silence the samples span.
 */
export function isStuck(input: { silentMs: number; idleMs: number; cpu: CpuReading | undefined; cpuWatchedMs: number }): boolean {
	if (input.idleMs <= 0 || input.silentMs < input.idleMs) return false;
	if (input.cpu === undefined || input.cpuWatchedMs < input.silentMs * 0.8) return true;
	return input.cpu.sinceOutput < BUSY_SHARE * (input.silentMs / 1000);
}

function span(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * The sign of life under a running call: how long, how long since it said anything, and
 * whether the processor is doing something.
 *
 *     running 47s · last output 31s ago · CPU busy (98% of a processor): working
 *     running 2m05s · no output yet · CPU idle: waiting on something
 */
export function lifeLine(input: { elapsedMs: number; silentMs: number; hasOutput: boolean; cpu: CpuReading | undefined; idleMs?: number }): string {
	const parts = [`running ${span(input.elapsedMs)}`];
	if (!input.hasOutput) parts.push("no output yet");
	else if (input.silentMs >= 3000) parts.push(`last output ${span(input.silentMs)} ago`);
	const busy = isBusy(input.cpu);
	if (busy === true) {
		const share = Math.round((input.cpu as CpuReading).recentShare * 100);
		parts.push(`CPU busy (${share}% of a processor): working`);
	} else if (busy === false) {
		const left = input.idleMs && input.idleMs > 0 && input.silentMs >= 10_000 ? input.idleMs - input.silentMs : undefined;
		parts.push(left !== undefined && left > 0 ? `CPU idle: waiting on something (stopped as stuck in ${span(left)} if it stays so)` : "CPU idle: waiting on something");
	}
	return parts.join(" · ");
}

/**
 * What a deadline's notice says about the processor, for the model.
 *
 * "It was still running" does not say whether more time would have helped. Processor time
 * does: a command that used most of its two minutes was working and needs longer; one
 * that used none was waiting, and would wait as long again.
 */
export function cpuSentence(cpu: CpuReading | undefined, wallSeconds: number | undefined): string | undefined {
	if (cpu === undefined) return undefined;
	const used = `${cpu.total.toFixed(1)}s of processor time${wallSeconds !== undefined ? ` in ${Math.round(wallSeconds)}s` : ""}`;
	return isBusy(cpu)
		? `CPU: it used ${used} and was still computing when it was stopped, so it was working, not stuck: more time (or \`run_in_background\`) is what it needs.`
		: `CPU: it used ${used} and none at the end, so it was waiting on something, not computing: more time alone will not help.`;
}
