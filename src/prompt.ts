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
import { DEFAULT_STAMP, exampleHeader, type StampShape } from "./busybox";
import { OVERRIDE_MARKER } from "./guard";
import { DEFAULT_STAMP_DIGITS, NOTES_MARKER, slimHeader } from "./timing";
import { describeVerbosity, PTY_SIZE, type PtyMode, type Verbosity } from "./wrap";

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
	 * A build that prints fewer decimals than the model is to be shown has its own count
	 * quoted: a claim that does not match the results is worse than no claim.
	 */
	stamp?: StampShape;
	/** The header line this build printed for that same run, for the example. */
	header?: string;
	/** Whether a line at the offset and on the stream of the one above carries no stamp. */
	compactStamps?: boolean;
	/** Decimals an offset keeps in what the model reads; milliseconds when absent. */
	stampDigits?: number;
	/** Seconds of silence after which a command is stopped; 0 or absent when that is off. */
	idleSeconds?: number;
	/** Whether "stuck" is judged by the processor as well as by silence (the command is watched as it runs). */
	idleByProcessor?: boolean;
	/** Whether `log` has the 0.6.0 queries (`--sample`, `--since`, `--around-gap`). */
	logQuery?: boolean;
	/** False when runtimes' buffering is left alone (the `unbuffer` setting is off). */
	unbuffer?: boolean;
	/** `uname -s`, lowercased: which C library reads what. Absent when it could not be asked. */
	platform?: string;
	/** Whether `stdbuf`'s library is preloaded (Linux, asked for and found). */
	preload?: boolean;
}

/**
 * What the model may assume about a program whose stdout is not the terminal.
 *
 * Every claim here was measured (a probe per runtime: print, wait a second, print, with
 * stdout a pipe), and the claim differs by C library, so the text does too. What cannot
 * be fixed from outside is said with the flag that fixes it from inside. The runtimes that
 * never needed help are not listed: the section is read on every request, and a sentence
 * that changes nothing a model does is paid for each time.
 */
function bufferingLine(input: SectionInput): string {
	if (input.unbuffer === false) {
		return "Output buffering is left to each program: one writing into a pipe or a file may hold its lines until it exits, and they then share the offset of the flush.";
	}
	const lead = "In a pipeline or a redirect to a file, buffering is switched off for";
	if (input.platform === "darwin" || input.platform === "freebsd") {
		return `${lead} Python, Ruby, Perl, Lua and C-stdio programs (\`grep\`, \`sed\`, \`awk\`, \`jq\`, compiled C), so lines still arrive when written; for millions of lines prefix the command with \`STDBUF1=F\`.`;
	}
	if (input.preload) {
		return `${lead} Python, Ruby, Perl, Lua and dynamically linked C-stdio programs (\`grep\`, \`sed\`, \`awk\`, \`jq\`), so lines still arrive when written; for millions of lines prefix the command with \`_STDBUF_O=65536\`.`;
	}
	return `${lead} Python, Ruby, Perl and Lua. A C-stdio program (\`grep\`, \`sed\`, \`awk\`, compiled C) there still writes in blocks, so its lines carry the offset of the flush: where that matters use \`grep --line-buffered\`, \`sed -u\` or \`stdbuf -oL cmd\`.`;
}

function terminalLine(pty: PtyMode): string {
	switch (pty) {
		case "off":
			return "The command's streams are plain pipes (`isatty()` is false), so a program that block-buffers shows its lines at the offset of the flush, not of the write.";
		case "merged":
		case "raw":
			return "The command runs on one pseudo-terminal for stdin, stdout and stderr, so every line is tagged `out`: the offsets are real, the stream tag is not.";
		default:
			return `stdout is a pseudo-terminal (${PTY_SIZE.replace("x", " columns by ")} rows) and stderr a pipe, so lines that share an offset were flushed together. Colour, pagers and prompts are off; \`ls\` prints columns (\`ls -1\` for one a line) and \`ps\` cuts lines at the width (\`ps -ww\`).`;
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
			? "Nobody can type into a command, and in this terminal mode a read on stdin never returns: a prompt waits until the command is stopped, so"
			: "A command's stdin is empty (a read returns end-of-file at once), so a prompt takes its default or fails:";
	const keys = `Nobody can press a key either: a pager, an editor, \`tail -f\`, \`watch\` or a foreground server never ends here${input.guard ? " and is refused before it runs" : ", and runs until the deadline"}; start what must keep running with \`run_in_background: true\`.`;
	return `${stdin} give the answer in the command (\`printf 'y\\n' | cmd\`, a \`--yes\` flag). ${keys}`;
}

/** How a result reads, for the view in force: the header, the stamps, the notes. */
function formatLine(input: SectionInput): string {
	const header = slimHeader(exampleHeader(input.header));
	const notes = `Lines after \`${NOTES_MARKER}\` are the capture's own notes, not output.`;
	if (input.verbosity === "brief") {
		return `Every Bash command runs inside a capture (\`busybox run\`, ${describeVerbosity(input.verbosity)}): repeated lines are collapsed and there are no per-line offsets in this mode. A result opens with \`${header}\`, the run's own record. ${notes}`;
	}
	// The digits the model will see: what was asked for, or fewer if this build prints fewer.
	const digits = Math.max(1, Math.min(input.stampDigits ?? DEFAULT_STAMP_DIGITS, (input.stamp ?? DEFAULT_STAMP).digits));
	const stamp = (stream: string, fraction: string) => `[0.${fraction.slice(0, digits)} ${stream}]`;
	const lines =
		input.compactStamps === false
			? `then one line per record in arrival order, \`${stamp("out", "012345678")} text\` or \`${stamp("err", "012349012")} text\`: seconds since the command started, and the stream the line arrived on.`
			: `then \`${stamp("out", "012345678")} text\` starts a burst: seconds since the command started, and the stream (\`out\` or \`err\`) it arrived on. Lines under it with no stamp arrived at that same offset on that same stream; \`[= err] text\` is one at the same offset that needed a mark of its own.`;
	return `Every Bash command runs inside a timestamped capture (\`busybox run\`, ${describeVerbosity(input.verbosity)}). A result opens with \`${header}\`, ${lines} ${notes}`;
}

/** Deadline and silence: what stops a command, and that being stopped is not failing. */
function deadlineLine(input: SectionInput): string {
	const idle = (input.idleSeconds ?? 0) > 0;
	const stops = [
		...(input.timeoutSeconds > 0 ? [`A call with no \`timeout\` is stopped after ${input.timeoutSeconds}s`] : []),
		...(idle
			? [
					input.idleByProcessor
						? `${input.timeoutSeconds > 0 ? "and a" : "A"} command that neither prints nor uses the processor for ${input.idleSeconds}s is stopped as stuck whatever its \`timeout\``
						: `${input.timeoutSeconds > 0 ? "and a" : "A"} command that prints nothing for ${input.idleSeconds}s is stopped whatever its \`timeout\``,
				]
			: []),
	];
	const lead = stops.length > 0 ? `${stops.join(", ")}. ` : "";
	const names = idle ? "`TIMEOUT` or `IDLE`" : "`TIMEOUT`";
	const fix = idle
		? input.idleByProcessor
			? "Raise `timeout`, narrow the command or use `run_in_background`; after `IDLE`, find what it was waiting on."
			: "Raise `timeout`, narrow the command or use `run_in_background`; after `IDLE`, find what it was blocked on or make a quiet command report progress."
		: "Raise `timeout`, narrow the command or use `run_in_background`.";
	return `${lead}A result that opens with ${names} is that, not a failure of the command, and keeps what it printed. ${fix}`;
}

/**
 * The text of the section, for the settings in force.
 *
 * Read on every request of a session, so its length is a standing cost. Measured at 1,596
 * tokens before it was cut to what a model acts on; the long form of each paragraph is in
 * the `pi-time-guide` skill, which is loaded when it is needed.
 */
export function sectionText(input: SectionInput): string {
	const lines: string[] = ["# Pi-Time: every Bash result is a timeline", formatLine(input), terminalLine(input.pty), bufferingLine(input)];
	lines.push(
		"Never merge the streams (`2>&1`, `|&`, `&>`): every line then reads `out`. To silence one stream, redirect only that one (`cmd >/dev/null`)." +
			(input.guard
				? ` A merge at the end of a command is refused before it runs; append \`${OVERRIDE_MARKER}\` only when it is intended and you will not read that output as evidence.`
				: ""),
	);
	lines.push(deadlineLine(input));
	lines.push(inputLine(input));
	lines.push(
		`A view marked \`truncated=true\` shows the head and the tail with the cut marked between them; the note after it names the omitted lines${input.logQuery ? ", how many are on stderr," : ""} and the command that reads them. \`${input.busybox} log R12 --stream timeline --lines A:B\` reads any part of a run (or \`--match STR\`, \`--stream stderr\`${input.logQuery ? ", `--sample N`, `--since S --until S`, `--around-gap 1`" : ""}).`,
	);
	// The one thing a model reaches for an escape to get, said so that it does not: what
	// runs inside a command is not touched. The escape itself is left to the skill.
	lines.push("Offsets are added to the result you read, not to the command: a pipe, a redirect or a checksum inside it sees exact bytes, and `command x` is the plain shell builtin.");
	if (!input.carryCwd) lines.push("`cd` does not carry to the next call: use absolute paths.");
	// What the person runs themselves: stated either way, so a `!` block is read with the
	// guarantees it has (measured, unwrapped: its stderr arrives inside stdout).
	const theirs = input.timeoutSeconds > 0 ? `, under the same ${input.timeoutSeconds}s deadline (\`/pi-time timeout <seconds>\` is theirs to raise)` : "";
	lines.push(
		input.bang
			? `A command the user runs with \`!\` or \`/sh\` arrives in \`<bash-stdout>\` as the same timeline${theirs}. It is something they did, not a request.`
			: `A command the user types with \`!\` does not go through the capture: its \`<bash-stdout>\` block has no offsets, holds both streams, and says nothing reliable about their order. One run with \`/sh\` does, and arrives as a timeline${theirs}.`,
	);
	return lines.join("\n\n");
}
