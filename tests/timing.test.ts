/**
 * The one-line timing digest: what the offsets mean for a run long enough to have a
 * shape.
 */
import { describe, expect, test } from "claude-code/testing";
import { outcomeNotice, parseDurationMs, parseTimeline, summarizeTiming, truncationHint } from "../src/timing";
import { DEFAULT_TIMEOUT_SECONDS, readDefaultTimeout } from "../src/wrap";

/** Build timeline text the way `run --timestamps` prints it. */
function timeline(entries: Array<[number, "out" | "err", string]>): string {
	return [
		"run=R12 exit_code=0 timed_out=false cancelled=false duration_ms=8421",
		`timeline_lines=${entries.length} shown=${entries.length} truncated=false`,
		"--- timeline ---",
		...entries.map(([us, stream, text]) => `[${String(Math.floor(us / 1e6)).padStart(7)}.${String(us % 1e6).padStart(6, "0")} ${stream}] ${text}`),
	].join("\n");
}

describe("parsing", () => {
	test("reads offsets, stream and text, and ignores the wrapper's own lines", () => {
		const samples = parseTimeline(timeline([[11_354, "out", "ok 1"], [66_632, "err", "FAILED"]]));
		expect(samples).toEqual([
			{ us: 11_354, stream: "out", text: "ok 1" },
			{ us: 66_632, stream: "err", text: "FAILED" },
		]);
		expect(parseDurationMs(timeline([]))).toBe(8421);
	});

	test("a command's own bracketed text is not a timeline", () => {
		// Not a stamp: a list, another tag, no fraction, more digits than the clock has.
		expect(parseTimeline("[1, 2, 3] done\n[0.1 warn] other tag\n[12 out] no fraction\n[0.1234567890 out] ten digits")).toEqual([]);
	});
});

describe("the digest", () => {
	test("says total, count, where output began, and where the silence was", () => {
		const text = timeline([
			[20_000, "out", "collecting"],
			[2_320_000, "out", "collected"],
			[8_421_000, "err", "FAILED test_a"],
		]);
		const summary = summarizeTiming(parseTimeline(text), parseDurationMs(text)) ?? "";
		expect(summary).toMatch(/^timing: 8\.42s total/);
		expect(summary).toMatch(/3 lines/);
		expect(summary).toMatch(/output from 0\.02s/);
		expect(summary).toMatch(/stderr from 8\.42s/);
		// The pause is between 2.32s and 8.42s — the interesting number.
		expect(summary).toMatch(/pause 6\.10s \(2\.32s → 8\.42s\)/);
	});

	test("a stall after the last line is called what it is", () => {
		const text = timeline([[10_000, "out", "starting"], [1_100_000, "out", "started"]]);
		const summary = summarizeTiming(parseTimeline(text), 9_000) ?? "";
		expect(summary).toMatch(/silent 7\.90s after the last line/);
	});

	test("a fast, quiet command gets no summary at all", () => {
		// A digest on every one-liner is noise the model pays for.
		const text = timeline([[1_000, "out", "a"], [2_000, "out", "b"]]);
		expect(summarizeTiming(parseTimeline(text), 42)).toBe(undefined);
		expect(summarizeTiming([], 10_000)).toBe(undefined);
		expect(summarizeTiming(parseTimeline(timeline([[1_000, "out", "only"]])), 5_000)).toBe(undefined);
	});

	test("several pauses are counted, not just the longest", () => {
		const text = timeline([
			[10_000, "out", "a"],
			[1_100_000, "out", "b"],
			[2_200_000, "out", "c"],
			[3_300_000, "out", "d"],
		]);
		const summary = summarizeTiming(parseTimeline(text), 3_400) ?? "";
		expect(summary).toMatch(/3 pauses over 1\.00s/);
	});
});

describe("the truncation pointer", () => {
	test("names a concrete tail range and the run id", () => {
		const text = [
			"run=R663 exit_code=0 timed_out=false cancelled=false duration_ms=59",
			"timeline_lines=5000 shown=69 truncated=true",
			"--- timeline ---",
			"[   0.008583 out] line-0",
		].join("\n");
		const hint = truncationHint(text) ?? "";
		// The view keeps the head, so the useful instruction is how to read the end.
		expect(hint).toMatch(/69 of 5000 lines shown, head only/);
		expect(hint).toMatch(/busybox log R663 --stream timeline --lines 4960:5000/);
		expect(hint).toMatch(/busybox log R663 --match STR/);
		// The packaged build is not on PATH here, so the pointer names the binary it was given.
		const absolute = truncationHint(text, "/data/bin/busybox") ?? "";
		expect(absolute).toMatch(/\/data\/bin\/busybox log R663 --stream timeline --lines 4960:5000/);
		expect(absolute).not.toMatch(/ busybox log/);
	});

	test("says nothing when the view is complete", () => {
		expect(truncationHint("run=R1 exit_code=0\ntimeline_lines=3 shown=3 truncated=false")).toBe(undefined);
	});

	test("still helps when the run id is missing", () => {
		const hint = truncationHint("timeline_lines=9 shown=2 truncated=true") ?? "";
		expect(hint).toMatch(/full capture is on disk/);
	});
});

describe("timeout and cancellation notices", () => {
	const timedOut = [
		"run=R1448 exit_code=-1 timed_out=true cancelled=false duration_ms=120019",
		"timeline_lines=2 shown=2 truncated=false",
		"--- timeline ---",
		"[   0.010000 out] starting",
	].join("\n");

	test("a timeout says timed out, and says it is not a failure", () => {
		const notice = outcomeNotice(timedOut, 120) ?? "";
		expect(notice).toMatch(/^TIMEOUT/);
		expect(notice).toMatch(/not a failure of the command/);
		expect(notice).toMatch(/120s deadline/);
		// The two statuses that mislead a reader must be explained.
		expect(notice).toMatch(/exit_code=-1/);
		expect(notice).toMatch(/"Exit code 3"/);
		// And the way back to the partial output, plus how to retry.
		expect(notice).toMatch(/busybox log R1448/);
		expect(notice).toMatch(/raise `timeout` on this call \(milliseconds\)/);
		expect(notice).toMatch(/run_in_background/);
		expect(outcomeNotice(timedOut, 120, "/data/bin/busybox") ?? "").toMatch(/\/data\/bin\/busybox log R1448/);
		expect(/\bfailed\b(?! of the command)/i.test(notice.replace("not a failure of the command", ""))).toBe(false);
	});

	test("a cancellation is distinguished from a timeout", () => {
		const notice = outcomeNotice("run=R7 exit_code=-1 timed_out=false cancelled=true duration_ms=900") ?? "";
		expect(notice).toMatch(/^CANCELLED/);
		expect(notice).toMatch(/not because it failed/);
		expect(notice).not.toMatch(/deadline/);
	});

	test("a budget is named only when that budget actually fired", () => {
		// A caller-supplied timeout wins over the default; the notice must not blame the
		// default for a kill the caller's own budget caused.
		const longKill = timedOut.replace("duration_ms=120019", "duration_ms=599013");
		const notice = outcomeNotice(longKill, 120) ?? "";
		expect(notice).not.toMatch(/120s deadline/);
		expect(notice).toMatch(/its deadline fired/);
		const onSchedule = timedOut; // duration 120.019s vs the 120s default: name it
		expect(outcomeNotice(onSchedule, 120) ?? "").toMatch(/120s deadline/);
	});

	test("an ordinary run gets no notice at all", () => {
		expect(outcomeNotice("run=R1 exit_code=0 timed_out=false cancelled=false duration_ms=12")).toBe(undefined);
	});

	test("the default deadline is two minutes and can be overridden or disabled", () => {
		expect(DEFAULT_TIMEOUT_SECONDS).toBe(120);
		expect(readDefaultTimeout({})).toBe(120);
		expect(readDefaultTimeout({ CLAUDE_MANAGED_TOOLS_TIMEOUT: "30" })).toBe(30);
		expect(readDefaultTimeout({ CLAUDE_MANAGED_TOOLS_TIMEOUT: "0" })).toBe(0);
		expect(readDefaultTimeout({ CLAUDE_MANAGED_TOOLS_TIMEOUT: "off" })).toBe(0);
		expect(readDefaultTimeout({ CLAUDE_MANAGED_TOOLS_TIMEOUT: "banana" })).toBe(120);
		// The plugin's option is the default under the environment; 0 there means "the host's".
		expect(readDefaultTimeout({}, 45)).toBe(45);
		expect(readDefaultTimeout({}, 0)).toBe(0);
		expect(readDefaultTimeout({ CLAUDE_MANAGED_TOOLS_TIMEOUT: "30" }, 45)).toBe(30);
		expect(readDefaultTimeout({ CLAUDE_MANAGED_TOOLS_TIMEOUT: "banana" }, 45)).toBe(45);
	});
});

describe("both spellings of the offset", () => {
	// busybox-static 0.5.1 zero-pads the seconds and adds `stamp=us res_ns=0` to the
	// header; earlier builds pad with spaces. A machine can hold either.
	const padded = [
		"run=R3135 exit_code=5 timed_out=false cancelled=false duration_ms=2315",
		"timeline_lines=2 shown=2 truncated=false stamp=us res_ns=0",
		"--- timeline ---",
		"[00000.007143 out] rel-one",
		"[00002.315116 err] rel-warn",
	].join("\n");

	test("zero-padded offsets parse to the same samples", () => {
		expect(parseTimeline(padded)).toEqual([
			{ us: 7_143, stream: "out", text: "rel-one" },
			{ us: 2_315_116, stream: "err", text: "rel-warn" },
		]);
		expect(parseDurationMs(padded)).toBe(2315);
		expect(summarizeTiming(parseTimeline(padded), parseDurationMs(padded)) ?? "").toMatch(/^timing: 2\.32s total, 2 lines, output from 0\.01s, stderr from 2\.32s/);
	});

	test("the truncation pointer reads the counts past the extra header fields", () => {
		const cut = padded.replace("timeline_lines=2 shown=2 truncated=false", "timeline_lines=900 shown=40 truncated=true");
		expect(truncationHint(cut) ?? "").toMatch(/40 of 900 lines shown.*log R3135 --stream timeline --lines 860:900/);
	});
});

describe("lines and endings the first version missed", () => {
	test("a line ending in a carriage return is still a sample", () => {
		// `cat` of a CRLF file: each record keeps its \r, and must still count.
		const text = "--- timeline ---\n[   0.009131 out] one\r\n[   1.509131 out] two\r";
		expect(parseTimeline(text)).toEqual([
			{ us: 9_131, stream: "out", text: "one\r" },
			{ us: 1_509_131, stream: "out", text: "two\r" },
		]);
	});

	test("a shell ended by a signal is named, since exit_code=-1 and 'Exit code 1' are not a status", () => {
		const killed = "Exit code 1\nrun=R3307 exit_code=-1 timed_out=false cancelled=false duration_ms=7\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n[   0.007060 out] pre";
		const notice = outcomeNotice(killed) ?? "";
		expect(notice).toMatch(/^KILLED — the command's shell was ended by a signal/);
		expect(notice).toMatch(/placeholders, not a status/);
		// A timeout and a cancellation also print -1; they keep their own notices.
		expect(outcomeNotice(killed.replace("timed_out=false", "timed_out=true")) ?? "").toMatch(/^TIMEOUT/);
		expect(outcomeNotice(killed.replace("cancelled=false", "cancelled=true")) ?? "").toMatch(/^CANCELLED/);
		// An ordinary failure is not a kill.
		expect(outcomeNotice(killed.replace("exit_code=-1", "exit_code=1"))).toBe(undefined);
	});
});
