/**
 * The two-channel split: the model reads the timeline, the human reads the command.
 *
 * `stripTimeline` is what the bash renderer draws (TUI and HTML export). Anything it
 * removes must be the *wrapper's* decoration; anything the command printed — including
 * a truncated view's marker and the command's own indentation — has to survive.
 */
import { describe, expect, test } from "claude-code/testing";
import { dropHousekeeping, hasTimeline, stripTimeline } from "../src/display";

const WRAPPED = [
	"run=R134 exit_code=0 timed_out=false cancelled=false duration_ms=328",
	"timeline_lines=3 shown=3 truncated=false",
	"--- timeline ---",
	"[   0.007558 out] out1",
	"[   0.165429 err] err1",
	"[   0.319811 out] out2",
].join("\n");

describe("stripping the timeline for the human", () => {
	test("the wrapper's header, marker and prefixes go; the command's lines stay", () => {
		expect(stripTimeline(WRAPPED)).toBe(["out1", "err1", "out2"].join("\n"));
	});

	test("a real payload keeps indentation, blank lines and the command's own text", () => {
		const wrapped = [
			"run=R7 exit_code=1 timed_out=false cancelled=false duration_ms=12",
			"timeline_lines=4 shown=4 truncated=false",
			"--- timeline ---",
			"[   0.000912 out] \tindented with a tab",
			"[   0.001003 out] ",
			"[   0.001110 out]  two leading spaces",
			"[   0.001240 err] FAILED test_a",
		].join("\n");
		expect(stripTimeline(wrapped)).toBe("\tindented with a tab\n\n two leading spaces\nFAILED test_a");
	});

	test("a truncated view's marker survives, because the command produced it", () => {
		const wrapped = [
			"run=R9 exit_code=0 timed_out=false cancelled=false duration_ms=3",
			"timeline_lines=2 shown=2 truncated=false",
			"--- timeline ---",
			"[   0.000500 out] first",
			"[   0.000600 out] ... [310 bytes] ...",
		].join("\n");
		expect(stripTimeline(wrapped)).toMatch(/\.\.\. \[310 bytes\] \.\.\./);
	});

	test("stdout/stderr section output is cleaned too, for verbosity without timestamps", () => {
		const plain = [
			"run=R4 exit_code=0 timed_out=false cancelled=false duration_ms=9",
			"captured_bytes=12 stdout=6 stderr=6 capture_complete=true view_truncated=false",
			"stdout_artifact=/tmp/x/stdout",
			"stderr_artifact=/tmp/x/stderr",
			"--- stdout ---",
			"hello",
			"--- stderr ---",
			"warning",
		].join("\n");
		expect(stripTimeline(plain)).toBe("hello\nwarning");
	});

	test("brief's own marker line is decoration, not output", () => {
		const briefed = "[brief] lines_in=400 records=1 merged=399\n4x ok case 0";
		expect(stripTimeline(briefed)).toBe("4x ok case 0");
	});

	test("the timing digest is analysis, so the human does not see it twice", () => {
		const withDigest = `${WRAPPED}\ntiming: 8.42s total, 3 lines, output from 0.01s`;
		expect(stripTimeline(withDigest)).toBe(["out1", "err1", "out2"].join("\n"));
	});

	test("an empty command reads as no output, not as a blank row", () => {
		expect(stripTimeline(WRAPPED.split("\n").slice(0, 3).join("\n"))).toBe("(no output)");
		expect(stripTimeline("")).toBe("(no output)");
	});

	test("unwrapped text is returned unchanged, so the renderer is safe for both", () => {
		const plain = "line one\nline two";
		expect(hasTimeline(plain)).toBe(false);
		expect(stripTimeline(plain)).toBe(plain);
		expect(hasTimeline(WRAPPED)).toBe(true);
	});
});

describe("both spellings of the offset", () => {
	test("zero-padded prefixes and the longer header are decoration too", () => {
		const padded = [
			"run=R3135 exit_code=5 timed_out=false cancelled=false duration_ms=315",
			"timeline_lines=2 shown=2 truncated=false stamp=us res_ns=0",
			"--- timeline ---",
			"[00000.007143 out] rel-one",
			"[00000.315116 err]   indented warn",
			"pruned=18 keep=20",
		].join("\n");
		expect(hasTimeline(padded)).toBe(true);
		expect(stripTimeline(padded)).toBe("rel-one\n  indented warn");
		// What the model reads loses only the housekeeping line.
		expect(dropHousekeeping(padded)).toBe(padded.replace("\npruned=18 keep=20", ""));
	});

	test("a command that prints a line shaped like housekeeping in its own output keeps it", () => {
		const text = "--- timeline ---\n[   0.001000 out] pruned=3 keep=20";
		expect(dropHousekeeping(text)).toBe(text);
		expect(stripTimeline(text)).toBe("pruned=3 keep=20");
	});
});

describe("the sectioned view, when the mode has no timeline", () => {
	const brief = [
		"run=R3670 exit_code=0 timed_out=false cancelled=false duration_ms=12",
		"captured_bytes=604 stdout=604 stderr=0 capture_complete=true view_truncated=false",
		"stdout_artifact=/tmp/busybox-run/R3670/stdout",
		"stderr_artifact=/tmp/busybox-run/R3670/stderr",
		"pty=/dev/ttys077 cols=200 rows=50 raw=false stderr_merged=false",
		"--- stdout ---",
		"[brief] lines_in=61 records=2 kept=0 shown_lines=2 merged=59",
		"60x same line",
		"end",
		"--- stderr ---",
		"(empty)",
	].join("\n");

	test("it is recognised as the wrapper's, though no line carries an offset", () => {
		expect(hasTimeline(brief)).toBe(true);
		// A command that merely prints a section marker is not.
		expect(hasTimeline("--- stdout ---\nmine")).toBe(false);
	});

	test("header, artifacts, the terminal's record and an empty stream's placeholder all go", () => {
		expect(stripTimeline(brief)).toBe("60x same line\nend");
	});

	test("a command that prints the word (empty) itself keeps it", () => {
		const text = brief.replace("60x same line", "(empty)");
		expect(stripTimeline(text)).toBe("(empty)\nend");
	});
});
