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
 * What the model is told about Pi-Time on every turn.
 *
 * State the environment instead of leaving it to be discovered: a model that meets
 * `[   0.011354 out]` prefixes with no explanation spends a turn working out what they
 * are, and one that does not know `2>&1` destroys the stream tag will write it by reflex.
 * The section is only sent while the wrapper is actually on — a claim that does not match
 * the results is worse than no claim.
 */
import { DEFAULT_STAMP, exampleHeader, exampleStamp, type StampShape } from "./busybox";
import { OVERRIDE_MARKER } from "./guard";
import { describeVerbosity, PTY_SIZE, type PtyMode, RUN_RETENTION, type Verbosity } from "./wrap";

/** The section's id in the system prompt: `<plugin>:<name>`, as the host asks. */
export function sectionId(plugin: string): string {
	return `${plugin}:pi-time`;
}

export interface SectionInput {
	/** How to call the binary in a command: an absolute path, quoted if it needs it. */
	busybox: string;
	verbosity: Verbosity;
	pty: PtyMode;
	/**
	 * The plugin's default deadline in seconds; 0 when the host's own applies. It covers a
	 * tool call that names no `timeout` and every command the person runs themselves.
	 */
	timeoutSeconds: number;
	/** Whether a `2>&1` at a command's tail is refused before it runs. */
	guard: boolean;
	/** Whether a successful `cd` still carries to the next call. */
	carryCwd: boolean;
	/** Whether a command the person types with `!` runs inside the capture (the shell shim). */
	bang?: boolean;
	/**
	 * How this build writes an offset, read off a line it really printed at session start.
	 * The examples are drawn in that shape: a claim that does not match the results is
	 * worse than no claim. Absent, the shape of the current release.
	 */
	stamp?: StampShape;
	/** The header line this build printed for that same run, for the example. */
	header?: string;
	/** Whether a line at the offset of the one above carries `[= out]` instead of the digits. */
	compactStamps?: boolean;
	/** Seconds of silence after which a command is stopped; 0 or absent when that is off. */
	idleSeconds?: number;
	/** Whether `log` has the 0.6.0 queries (`--sample`, `--since`, `--around-gap`). */
	logQuery?: boolean;
	/** False when runtimes' buffering is left alone (the `unbuffer` setting is off). */
	unbuffer?: boolean;
	/** `uname -s`, lowercased: which C library reads what. Absent when it could not be asked. */
	platform?: string;
	/** Whether `stdbuf`'s library is preloaded (Linux, asked for and found). */
	preload?: boolean;
}

const ALWAYS_LIVE = "Node, Go, Rust, Java and PHP never hold lines back";
const BULK = "The price is bulk output: for millions of lines into a file or a pipe, prefix that one command with `STDBUF1=F`";

/**
 * What the model may assume about a program whose stdout is not the terminal.
 *
 * Every claim here was measured (a probe per runtime: print, wait a second, print, with
 * stdout a pipe), and the claim differs by C library, so the text does too. What cannot
 * be fixed from outside is said with the flag that fixes it from inside.
 */
function bufferingLine(input: SectionInput): string {
	if (input.unbuffer === false) {
		return "Output buffering is left to each program: one whose stdout is a pipe or a file (a stage inside a pipeline, `cmd > log`) may hold its lines until its buffer fills or it exits, and they then share the offset of the flush.";
	}
	const lead = "Where a program's stdout is not the terminal — a stage inside a pipeline (`cmd | tee log`, `cmd | grep x`), or output sent to a file — buffering is switched off through the environment";
	const tail = "lines arrive when they are written, and a log file can be read while its writer runs.";
	const cStdio = "(`grep`, `sed`, `awk`, `cut`, `jq`, compiled C)";
	if (input.platform === "darwin" || input.platform === "freebsd") {
		return `${lead} for Python, Ruby, Perl, Lua and every C-stdio program ${cStdio.replace("compiled C", "compiled C and Swift")}; ${ALWAYS_LIVE}. So ${tail} ${BULK}.`;
	}
	if (input.preload) {
		return `${lead} for Python, Ruby, Perl, Lua and, through \`stdbuf\`'s preload, every dynamically linked C-stdio program ${cStdio}; ${ALWAYS_LIVE}. So ${tail} ${BULK.replace("`STDBUF1=F`", "`_STDBUF_O=65536`")}.`;
	}
	return `${lead} for Python, Ruby, Perl and Lua; ${ALWAYS_LIVE}. For those, ${tail} A C-stdio program ${cStdio} whose stdout is a pipe or a file still writes in blocks, so its lines carry the offset of the flush: where that timing matters use \`grep --line-buffered\`, \`sed -u\` or \`stdbuf -oL cmd\`.`;
}

function terminalLine(pty: PtyMode): string {
	switch (pty) {
		case "off":
			return "The command's streams are plain pipes (`isatty()` is false), so a program that block-buffers on a pipe shows its lines at the offset of the flush, not of the write: a burst of lines sharing one offset is a writer that flushed at exit.";
		case "merged":
		case "raw":
			return "The command runs on one pseudo-terminal for stdin, stdout and stderr, so every line is tagged `out`: the offsets are real, the stream tag is not.";
		default:
			return `The command's stdout is a pseudo-terminal ${PTY_SIZE.replace("x", " columns by ")} rows, its stderr a pipe and its stdin empty, so \`isatty(1)\` is true and line-buffered programs report real intervals; a burst of lines sharing one offset is a writer that flushed at exit. Colour, pagers and prompts are switched off through the environment. A program that formats for a terminal does so here: \`ls\` prints names in columns (\`ls -1\` for one per line) and \`ps\` cuts lines at the width (\`ps -ww\` for whole lines).`;
	}
}

/**
 * What nobody can do for a command here: answer it, or stop it by hand.
 *
 * Both were measured before being taught. With a `read` behind a `[y/N]` prompt, on
 * plain pipes, `split` and `merged` the read returned end-of-file at once (the host gives
 * a command no input, and `run` ends what it forwards); in `raw` there is no line
 * discipline to turn that into end-of-file and the read sat until the deadline. So the
 * sentence differs by mode. And a command that only ends on a keypress runs to the
 * deadline with nothing learned.
 */
function inputLine(input: SectionInput): string {
	const stdin =
		input.pty === "raw"
			? "Nobody can type into a command, and in this terminal mode a read on stdin never returns: a prompt (`[y/N]`, a password) waits until the command is stopped. Give the answer in the command: `printf 'y\\n' | cmd`, `cmd < file`, a heredoc, a `--yes` flag."
			: "A command's stdin is empty: a read returns end-of-file at once, so a prompt (`[y/N]`, a password) takes its default or fails instead of waiting. Give the answer in the command: `printf 'y\\n' | cmd`, `cmd < file`, a heredoc, a `--yes` flag.";
	const keys = `Nobody can press a key or Ctrl-C either: a pager, an editor, \`tail -f\`, \`watch\` or a foreground server never ends here${input.guard ? " and is refused before it runs" : ", and runs until the deadline"}. Start what must keep running with \`run_in_background: true\`.`;
	return `${stdin} ${keys}`;
}

/** The text of the section, for the settings in force. */
export function sectionText(input: SectionInput): string {
	const lines: string[] = ["# Pi-Time: every Bash result is a timeline"];
	if (input.verbosity === "brief") {
		lines.push(
			`Every Bash command runs inside a capture (\`busybox run\`, ${describeVerbosity(input.verbosity)}): repeated lines are collapsed and there are no per-line offsets in this mode. The \`run=R… exit_code=… duration_ms=…\` header is still the run's own record.`,
		);
	} else {
		const shape = input.stamp ?? DEFAULT_STAMP;
		const unit = shape.digits >= 9 ? ", to the nanosecond" : shape.digits >= 6 ? ", to the microsecond" : "";
		const ditto = input.compactStamps
			? " A line that arrived at the same offset as the line above it carries `[= out]` or `[= err]` instead of the digits again: the same instant, said once."
			: "";
		lines.push(
			`Every Bash command runs inside a timestamped capture (\`busybox run --timestamps\`, ${describeVerbosity(input.verbosity)}). A result opens with \`${exampleHeader(input.header)}\`, then one line per record in true arrival order: \`${exampleStamp(shape, "out")} text\` or \`${exampleStamp(shape, "err", true)} text\` — seconds since the command started${unit}, and the stream the line arrived on.${ditto} Read them as facts: which came first, how long a step took, whether a warning was on stderr. A run longer than a second also ends with a \`timing:\` line that says where the time went.`,
		);
	}
	lines.push(terminalLine(input.pty));
	lines.push(bufferingLine(input));
	lines.push(
		`Never merge the streams (\`2>&1\`, \`|&\`, \`&>\`): the merge happens inside the command, before anything can be tagged, and every line then reads \`out\`. The streams are already captured separately — to silence one, redirect only that one (\`cmd >/dev/null\`).` +
			(input.guard
				? ` A merge at the end of a command is refused before it runs; append \`${OVERRIDE_MARKER}\` only when the merge is intended and you will not read that output as evidence about the program.`
				: ""),
	);
	lines.push(
		input.timeoutSeconds > 0
			? `A call with no \`timeout\` is stopped after ${input.timeoutSeconds}s. A result that says \`TIMEOUT\` is a deadline, not a failure of the command: what it printed is still there, and the fix is a larger \`timeout\`, a narrower command or \`run_in_background\`.`
			: "A result that says `TIMEOUT` is a deadline, not a failure of the command: what it printed is still there, and the fix is a larger `timeout`, a narrower command or `run_in_background`.",
	);
	if ((input.idleSeconds ?? 0) > 0) {
		lines.push(
			`A command that prints nothing on either stream for ${input.idleSeconds}s is taken to be stuck and stopped, whatever \`timeout\` the call names. A result that says \`IDLE\` is that, not a failure and not the deadline: find what it was blocked on (a lock, a socket, a prompt that opens the terminal itself), make a quiet command report progress, or use \`run_in_background\`.`,
		);
	}
	lines.push(inputLine(input));
	lines.push(
		`A view marked \`truncated=true\` shows the head and the tail of the output with the cut marked between them; the line after it names the omitted lines${input.logQuery ? ", how many of them are on stderr," : ""} and the command that reads them. The capture is complete on disk. Read any part of a past run with \`${input.busybox} log R12 --stream timeline --lines A:B\`, \`--match STR\`, or \`--stream stderr\`${input.logQuery ? "; `--sample N` gives its first and last N lines, `--since S --until S` a window of the timeline, and `--around-gap 1` its longest silences" : ""}. Captures are kept for at least two hours, and the newest ${RUN_RETENTION} for longer.`,
	);
	// The one thing a model reaches for an escape to get, said so that it does not: what
	// runs inside a command is not touched. The escape itself is left to the skill.
	lines.push("The offsets are added to the result you read, not to the command: a pipe, a redirect or a checksum inside it sees exact bytes, and `command x` is the ordinary shell builtin, captured like anything else.");
	if (!input.carryCwd) lines.push("`cd` does not carry to the next call: use absolute paths.");
	// What the person runs themselves: stated either way, so a `!` block is read with the
	// guarantees it has (measured, unwrapped: its stderr arrives inside stdout).
	lines.push(
		input.bang
			? `A command the user types with \`!\`, or runs with \`/sh\`, also goes through the capture${input.timeoutSeconds > 0 ? `, under the same ${input.timeoutSeconds}s deadline` : ""}: its \`<bash-stdout>\` block is the same timeline, with the same header, offsets and stream tags. It is something the user did, not a request.${input.timeoutSeconds > 0 ? " When one of theirs says `TIMEOUT` there is no `timeout` to raise: `/pi-time timeout <seconds>` is how they give it longer." : ""}`
			: `A command the user types with \`!\` does not go through the capture: its \`<bash-stdout>\` block has no offsets, holds both streams, and says nothing reliable about their order or timing. A command the user runs with \`/sh\` does go through it and arrives as a timeline${input.timeoutSeconds > 0 ? `, under the same ${input.timeoutSeconds}s deadline (\`/pi-time timeout <seconds>\` is how they give it longer)` : ""}.`,
	);
	return lines.join("\n\n");
}
