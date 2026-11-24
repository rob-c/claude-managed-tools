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
 * The timeline goes to the model; the human watching the screen gets the command's
 * own output.
 *
 * One `bash` call now produces two texts from the same result:
 *
 *     [   0.011354 out] ok 1          <- model: ordering, timing, stream per line
 *     [   0.066632 err] FAILED test_x
 *
 *     ok 1                            <- human: what the command said
 *     FAILED test_x
 *
 * The model needs the offsets; nobody reading a terminal needs `[   0.011354 out]`
 * repeated on every line. The split is done where the result is drawn (a `ui.render`
 * hook on the tool row), while the tool result itself — the bytes the model reads and
 * the session stores — keeps the timeline intact.
 */

/** A line the wrapper itself printed, rather than the command. */
const WRAPPER_LINE = new RegExp(
	[
		"^run=R\\d+ ", // run=R12 exit_code=0 timed_out=false ...
		"^timeline_lines=", // timeline_lines=3 shown=3 truncated=false
		"^captured_bytes=", // captured_bytes=... capture_complete=...
		"^(stdout|stderr)_artifact=", // artifact paths
		"^pgid=", // only with --pgid
		"^pty=\\S+ cols=\\d+ rows=\\d+ ", // the terminal's own record, in the sectioned view
		"^--- (timeline|stdout|stderr) ---$", // section markers
		"^\\[brief\\] ", // brief's own reduction marker
		"^pruned=\\d+ keep=\\d+$", // --prune's own report, from a capture made before it was dropped
		"^timing: ", // the model-facing digest appended to the result
		"^--- pi-time ---$", // what separates the command's lines from the capture's notes
	].join("|"),
);

/** `--- stdout ---` and `--- stderr ---`, under which an empty stream reads `(empty)`. */
const SECTION_MARKER = /^--- (?:stdout|stderr) ---$/;

/**
 * The per-line prefix in every shape it has had: padded (`[   0.011354 out] `,
 * `[00000.005868042 out] `), unpadded (`[0.005868042 out] `, `[1.225 out] `, busybox-static
 * 0.6.1 on), and `[= out] ` for a line at the same offset as the one above (compactStamps).
 */
const TIMELINE_PREFIX = /^\[(?:\s*\d+\.\d{1,9}|=) (?:out|err)\] /;

/** Whether this text carries a timeline at all, so callers can skip the work. */
export function hasTimeline(text: string): boolean {
	if (TIMELINE_PREFIX.test(text) || /^timeline_lines=/m.test(text) || /^--- timeline ---$/m.test(text)) return true;
	// The header as the model is shown it since 0.6.0: one line, and no marker after it.
	if (/^run=R\d+ exit_code=-?\d+ (?:[a-z_]+=\S+ )*duration_ms=\d+$/m.test(text)) return true;
	// The sectioned view (`brief`) has no per-line prefix, but it is still the wrapper's:
	// its header and its section markers are decoration a person should not have to read.
	return /^run=R\d+ exit_code=-?\d+ /m.test(text) && /^--- (?:stdout|stderr) ---$/m.test(text);
}

/**
 * Remove the wrapper's own lines and the per-line prefix, keeping the command's bytes.
 *
 * Nothing else is touched: indentation, blank lines, ANSI the command printed itself and
 * a truncated view's `... [N bytes] ...` marker all stay, because they are the command's
 * output and not the wrapper's decoration.
 */
export function stripTimeline(text: string): string {
	const kept: string[] = [];
	let isAfterMarker = false;
	for (const line of text.split("\n")) {
		// The sectioned view says `(empty)` under a stream that printed nothing; directly
		// under its marker that is the wrapper's word, anywhere else it is the command's.
		if (isAfterMarker && line === "(empty)") {
			isAfterMarker = false;
			continue;
		}
		isAfterMarker = SECTION_MARKER.test(line);
		if (WRAPPER_LINE.test(line)) continue;
		kept.push(line.replace(TIMELINE_PREFIX, ""));
	}
	// A wrapper whose command printed nothing still has to read as "no output", not as
	// a blank row that looks like a rendering bug.
	while (kept.length > 0 && kept[0] === "") kept.shift();
	while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
	return kept.length > 0 ? kept.join("\n") : "(no output)";
}

/**
 * Drop the lines only a log file wants from what the model reads.
 *
 * `--prune` reports `pruned=0 keep=20` after every run. It says nothing about the
 * command, and on a one-line result it is a third of the tokens.
 */
export function dropHousekeeping(text: string): string {
	return text
		.split("\n")
		.filter((line) => !/^pruned=\d+ keep=\d+$/.test(line))
		.join("\n");
}
