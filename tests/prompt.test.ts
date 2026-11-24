/**
 * What the model is told: every claim in the section has to match the settings in force.
 */
import { describe, expect, test } from "claude-code/testing";
import { sectionId, sectionText } from "../src/prompt";

const BASE = {
	busybox: "/data/bin/busybox",
	verbosity: "normal",
	pty: "split",
	timeoutSeconds: 120,
	guard: true,
	carryCwd: true,
} as const;

describe("the Pi-Time section", () => {
	test("its id is the plugin's own, as the host asks", () => {
		expect(sectionId("managed-tools")).toBe("managed-tools:pi-time");
	});

	test("names the three facts: stream, offset, deadline", () => {
		const text = sectionText(BASE);
		// With no line of the build's to go by, the examples are the current release's shape.
		expect(text).toMatch(/`\[0\.012345678 out\] text`/);
		expect(text).toMatch(/`\[0\.012349012 err\] text`/);
		expect(text).toMatch(/seconds since the command started, to the nanosecond/);
		// A build that was run at session start gets its own shape and its own header: an
		// example cut from a real line cannot go stale when a release changes the padding.
		const older = sectionText({
			...BASE,
			stamp: { pad: "space", width: 4, digits: 6 },
			header: "run=R7 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=4",
		});
		expect(older).toMatch(/`\[ {3}0\.012345 out\] text` or `\[ {3}0\.012349 err\] text`/);
		expect(older).toMatch(/opens with `run=R12 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=328`/);
		expect(older).toMatch(/to the microsecond/);
		expect(older).not.toMatch(/0\.012345678/);
		expect(text).toMatch(/`timing:` line/);
		expect(text).toMatch(/stopped after 120s/);
		expect(text).toMatch(/`TIMEOUT` is a deadline, not a failure of the command/);
	});

	test("forbids the merge, explains why, and names the override only while the guard is on", () => {
		const guarded = sectionText(BASE);
		expect(guarded).toMatch(/Never merge the streams \(`2>&1`, `\|&`, `&>`\)/);
		expect(guarded).toMatch(/refused before it runs/);
		expect(guarded).toMatch(/# pitime-safe/);
		const unguarded = sectionText({ ...BASE, guard: false });
		expect(unguarded).toMatch(/Never merge the streams/);
		expect(unguarded).not.toMatch(/refused before it runs/);
		expect(unguarded).not.toMatch(/pitime-safe/);
	});

	test("names the binary by the path it was given, since it is not on PATH", () => {
		expect(sectionText(BASE)).toMatch(/`\/data\/bin\/busybox log R12 --stream timeline --lines A:B`/);
	});

	test("says what the terminal is, mode by mode", () => {
		expect(sectionText(BASE)).toMatch(/stdout is a pseudo-terminal 200 columns by 50 rows, its stderr a pipe and its stdin empty/);
		// The two commands whose output a terminal changes most are named, with the way out.
		expect(sectionText(BASE)).toMatch(/`ls -1` for one per line/);
		expect(sectionText(BASE)).toMatch(/`ps -ww` for whole lines/);
		expect(sectionText({ ...BASE, pty: "off" })).toMatch(/plain pipes/);
		expect(sectionText({ ...BASE, pty: "merged" })).toMatch(/every line is tagged `out`/);
	});

	test("says what a read on stdin gets, mode by mode, as measured", () => {
		// pi's first wording warned of a hang, which was false here and was dropped. What
		// is true was then measured with a `read` behind a prompt: end-of-file at once on
		// pipes, `split` and `merged` — so a prompt takes its default — and a read that
		// never returns in `raw`, which has no line discipline to end it.
		for (const pty of ["split", "off", "merged"] as const) {
			const text = sectionText({ ...BASE, pty });
			expect(text).toMatch(/A command's stdin is empty: a read returns end-of-file at once, so a prompt \(`\[y\/N\]`, a password\) takes its default or fails/);
			expect(text).not.toMatch(/never returns/);
		}
		const raw = sectionText({ ...BASE, pty: "raw" });
		expect(raw).toMatch(/in this terminal mode a read on stdin never returns/);
		expect(raw).not.toMatch(/end-of-file at once/);
		// Either way the answer goes in the command.
		expect(raw).toMatch(/`printf 'y\\n' \| cmd`/);
	});

	test("names what cannot end here, and says it is refused only while the guard is on", () => {
		expect(sectionText(BASE)).toMatch(/a pager, an editor, `tail -f`, `watch` or a foreground server never ends here and is refused before it runs/);
		expect(sectionText(BASE)).toMatch(/Start what must keep running with `run_in_background: true`/);
		const unguarded = sectionText({ ...BASE, guard: false });
		expect(unguarded).toMatch(/never ends here, and runs until the deadline/);
		expect(unguarded).not.toMatch(/is refused before it runs/);
	});

	test("a truncated view is described as it is: head and tail, with the cut between", () => {
		const text = sectionText(BASE);
		expect(text).toMatch(/`truncated=true` shows the head and the tail of the output with the cut marked between them/);
		expect(text).not.toMatch(/head only/);
		// The stderr count is only promised for a build whose `log` can give it.
		expect(text).not.toMatch(/how many of them are on stderr/);
		expect(sectionText({ ...BASE, logQuery: true })).toMatch(/names the omitted lines, how many of them are on stderr, and the command that reads them/);
		// No count of kept runs that another session could falsify.
		expect(text).toMatch(/Captures are kept for at least two hours, and the newest 200 for longer/);
	});

	test("an offset said once per burst is explained only while it is done", () => {
		expect(sectionText(BASE)).not.toMatch(/\[= out\]/);
		expect(sectionText({ ...BASE, compactStamps: true })).toMatch(/carries `\[= out\]` or `\[= err\]` instead of the digits again/);
		// `brief` has no offsets at all.
		expect(sectionText({ ...BASE, compactStamps: true, verbosity: "brief" })).not.toMatch(/\[= out\]/);
	});

	test("brief promises no offsets, because that mode has none", () => {
		const brief = sectionText({ ...BASE, verbosity: "brief" });
		expect(brief).toMatch(/no per-line offsets/);
		expect(brief).not.toMatch(/0\.012345/);
	});

	test("the deadline and cd sentences follow the settings", () => {
		expect(sectionText({ ...BASE, timeoutSeconds: 0 })).not.toMatch(/stopped after/);
		expect(sectionText(BASE)).not.toMatch(/does not carry/);
		expect(sectionText({ ...BASE, carryCwd: false })).toMatch(/`cd` does not carry to the next call/);
	});
});
