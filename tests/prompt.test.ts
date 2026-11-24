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
		// The header as the model is shown it: one line, with only what says something.
		expect(text).toMatch(/A result opens with `run=R12 exit_code=0 duration_ms=328`, then `\[0\.012 out\] text` starts a burst/);
		expect(text).toMatch(/seconds since the command started, and the stream \(`out` or `err`\) it arrived on/);
		expect(text).toMatch(/stopped after 120s/);
		expect(text).toMatch(/A result that opens with `TIMEOUT` is that, not a failure of the command, and keeps what it printed/);
	});

	test("the example is what a result looks like: this build's header, the digits the model is shown", () => {
		// A header this build printed, slimmed the way every result's is.
		const measured = sectionText({ ...BASE, header: "run=R7 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=4" });
		expect(measured).toMatch(/opens with `run=R12 exit_code=0 duration_ms=328`/);
		expect(measured).not.toMatch(/timed_out=false|idle=false|--- timeline ---/);
		// The precision asked for…
		expect(sectionText({ ...BASE, stampDigits: 6 })).toMatch(/`\[0\.012345 out\] text`/);
		expect(sectionText({ ...BASE, stampDigits: 9 })).toMatch(/`\[0\.012345678 out\] text`/);
		// …or fewer, when the build prints fewer: no example promises digits a result will not have.
		expect(sectionText({ ...BASE, stampDigits: 9, stamp: { pad: "space", width: 4, digits: 6 } })).toMatch(/`\[0\.012345 out\] text`/);
		// Never padded: every result's offsets are written without padding.
		expect(sectionText({ ...BASE, stamp: { pad: "zero", width: 5, digits: 9 } })).toMatch(/`\[0\.012 out\] text`/);
	});

	test("one stamp per burst is explained while it is done, and a stamp per line when it is not", () => {
		const burst = sectionText(BASE);
		expect(burst).toMatch(/Lines under it with no stamp arrived at that same offset on that same stream; `\[= err\] text` is one at the same offset that needed a mark of its own/);
		const perLine = sectionText({ ...BASE, compactStamps: false });
		expect(perLine).toMatch(/then one line per record in arrival order, `\[0\.012 out\] text` or `\[0\.012 err\] text`/);
		expect(perLine).not.toMatch(/burst|\[= err\]/);
		// Either way the notes are told from the output by the line in front of them.
		for (const text of [burst, perLine, sectionText({ ...BASE, verbosity: "brief" })]) {
			expect(text).toMatch(/Lines after `--- pi-time ---` are the capture's own notes, not output\./);
		}
	});

	test("it is short: read on every request, it is a standing cost", () => {
		// 4,511 characters and 1,596 tokens before it was cut to what a model acts on.
		const full = sectionText({ ...BASE, busybox: "/Users/x/.claude/plugins/data/managed-tools-rob-c/bin/busybox", bang: true, idleSeconds: 120, logQuery: true, platform: "darwin" });
		expect(full.length < 3000).toBe(true);
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
		expect(sectionText(BASE)).toMatch(/stdout is a pseudo-terminal \(200 columns by 50 rows\) and stderr a pipe, so lines that share an offset were flushed together/);
		// The two commands whose output a terminal changes most are named, with the way out.
		expect(sectionText(BASE)).toMatch(/`ls` prints columns \(`ls -1` for one a line\)/);
		expect(sectionText(BASE)).toMatch(/`ps` cuts lines at the width \(`ps -ww`\)/);
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
			expect(text).toMatch(/A command's stdin is empty \(a read returns end-of-file at once\), so a prompt takes its default or fails: give the answer in the command/);
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
		expect(sectionText(BASE)).toMatch(/start what must keep running with `run_in_background: true`/);
		const unguarded = sectionText({ ...BASE, guard: false });
		expect(unguarded).toMatch(/never ends here, and runs until the deadline/);
		expect(unguarded).not.toMatch(/is refused before it runs/);
	});

	test("a truncated view is described as it is: head and tail, with the cut between", () => {
		const text = sectionText(BASE);
		expect(text).toMatch(/`truncated=true` shows the head and the tail with the cut marked between them/);
		expect(text).not.toMatch(/head only/);
		// The stderr count is only promised for a build whose `log` can give it.
		expect(text).not.toMatch(/how many are on stderr/);
		expect(sectionText({ ...BASE, logQuery: true })).toMatch(/names the omitted lines, how many are on stderr, and the command that reads them/);
		// No count of kept runs that another session could falsify.
		expect(text).not.toMatch(/last 20|runs are kept/);
	});

	test("brief promises no offsets, because that mode has none", () => {
		const brief = sectionText({ ...BASE, verbosity: "brief" });
		expect(brief).toMatch(/no per-line offsets/);
		expect(brief).not.toMatch(/0\.012|burst|\[= err\]/);
	});

	test("the deadline and cd sentences follow the settings", () => {
		expect(sectionText({ ...BASE, timeoutSeconds: 0 })).not.toMatch(/stopped after/);
		expect(sectionText(BASE)).not.toMatch(/does not carry/);
		expect(sectionText({ ...BASE, carryCwd: false })).toMatch(/`cd` does not carry to the next call/);
	});
});
