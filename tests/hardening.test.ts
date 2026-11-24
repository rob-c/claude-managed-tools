/**
 * The pure rules behind 0.5.0: what pi-managed-tools' hardening pass found, applied here.
 *
 * Each group is one thing that was wrong and is now measured instead of assumed: where a
 * truncated view was cut, what a build's lines look like, how a pipeline's stages ended,
 * which commands cannot end, and which captures may be removed.
 */
import { describe, expect, test } from "claude-code/testing";
import {
	abilitiesOf,
	DEFAULT_STAMP,
	defaultRunRoot,
	exampleHeader,
	exampleStamp,
	excessRuns,
	isRunRoot,
	isStale,
	probeArgv,
	readProbe,
	runRootOf,
	stampShape,
} from "../src/busybox";
import { hasTimeline, stripTimeline } from "../src/display";
import { describePipestatus, detectEndless, endlessReason, maskQuotes, resultNotes, takeFacts } from "../src/guard";
import { compactStamps, expandStamps, NOTES_MARKER, outcomeNotice, parseHeader, slimHeader, truncationHint } from "../src/timing";
import { exitTrap, wrapCommand } from "../src/wrap";

const HEADER = "run=R30 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=900";

/** A view as `run` prints a long timeline since 0.6.0: head, the cut, tail. */
function cutView(head: string[], tail: string[], total: number): string {
	const shown = head.length + tail.length;
	return [
		HEADER,
		`timeline_lines=${total} shown=${shown} truncated=true stamp=ns res_ns=41`,
		"--- timeline ---",
		...head,
		`... [timeline truncated: ${shown} of ${total} lines shown (${total - shown} omitted); \`log R30 --stream timeline' has them] ...`,
		...tail,
	].join("\n");
}

describe("the header, read field by field and nowhere else", () => {
	test("every field of both lines, whatever order a build prints them in", () => {
		const header = parseHeader(`${HEADER}\ntimeline_lines=762 shown=282 truncated=true stamp=ns res_ns=41\n--- timeline ---\n[0.1 out] x`);
		expect(header).toEqual({ runId: "R30", exitCode: 0, timedOut: false, cancelled: false, idle: false, durationMs: 900, linesTotal: 762, linesShown: 282, truncated: true });
		// A build before 0.6.0 has no `idle=` field: absent is false.
		expect(parseHeader("run=R1 exit_code=-1 timed_out=true cancelled=false duration_ms=120019\ntimeline_lines=1 shown=1 truncated=false")?.timedOut).toBe(true);
		expect(parseHeader("run=R1 exit_code=-1 timed_out=true cancelled=false duration_ms=120019")?.idle).toBe(false);
		expect(parseHeader("plain output")).toBe(undefined);
	});

	test("the host's own first line does not hide it", () => {
		expect(parseHeader(`Exit code 4\n${HEADER}\ntimeline_lines=1 shown=1 truncated=false`)?.runId).toBe("R30");
	});

	test("what the command printed is not the header, even when it prints the header's words", () => {
		const text = `${HEADER}\ntimeline_lines=2 shown=2 truncated=false\n--- timeline ---\n[0.01 out] timeline_lines=9 shown=1 truncated=true\n[0.02 out] timed_out=true`;
		expect(parseHeader(text)?.truncated).toBe(false);
		expect(parseHeader(text)?.timedOut).toBe(false);
		expect(truncationHint(text, "/b/busybox")).toBe(undefined);
		// The sectioned view carries no stamps, so a counts line below the first section
		// marker is the command's own and must not be read either.
		const sectioned = "run=R2 exit_code=0 timed_out=false cancelled=false duration_ms=5\ncaptured_bytes=40 capture_complete=true\n--- stdout ---\ntimeline_lines=9 shown=1 truncated=true";
		expect(parseHeader(sectioned)?.truncated).toBe(false);
		expect(parseHeader(sectioned.replace("capture_complete=true", "capture_complete=true view_truncated=true"))?.truncated).toBe(true);
	});
});

describe("the pointer into a truncated view", () => {
	const head = ["[0.010000000 out] a", "[0.010000000 out] b", "[0.011000000 err] warn"];
	const tail = ["[0.890000000 out] y", "[0.890000000 out] z"];
	const view = cutView(head, tail, 762);

	test("names the omitted range and reads from inside it", () => {
		const hint = truncationHint(view, "/b/busybox") ?? "";
		expect(hint).toMatch(/^truncated: 5 of 762 lines shown — the first 3 and the last 2\. Lines 4-760 are omitted/);
		expect(hint).toMatch(/\/b\/busybox log R30 --stream timeline --lines 4:43 reads part of the gap; with --match STR in place of --stream and --lines it finds a literal anywhere$/);
		expect(hint).not.toMatch(/head only|read the end/);
		// The binary's path is long and used to be said three times in this one line.
		expect(hint.split("/b/busybox")).toHaveLength(2);
	});

	test("says how many of the missing lines are on stderr, when that could be asked", () => {
		// Unknown: said as unknown, not as none.
		expect(truncationHint(view, "/b/busybox")).toMatch(/omitted, it may hold stderr lines this view does not show\./);
		// One stderr line is on screen, so 41 in all leaves 40 unseen.
		const some = truncationHint(view, "/b/busybox", { stderrTotal: 41 }) ?? "";
		expect(some).toMatch(/omitted, 40 of them on stderr\./);
		// How to see those alone is only said when there are some.
		expect(some).toMatch(/, and with --stream stderr alone it shows the stderr lines$/);
		expect(truncationHint(view, "/b/busybox", { stderrTotal: 1 })).not.toMatch(/--stream stderr/);
		// The one that matters most: a view with no errors in the gap can say so.
		expect(truncationHint(view, "/b/busybox", { stderrTotal: 1 })).toMatch(/omitted, none of them on stderr\./);
	});

	test("a short gap is not read past its end", () => {
		const hint = truncationHint(cutView(head, tail, 12), "/b/busybox") ?? "";
		expect(hint).toMatch(/Lines 4-10 are omitted/);
		expect(hint).toMatch(/--lines 4:10 reads part of the gap/);
	});

	test("the pointer is worked out on the capture as `run` printed it, before any line loses its stamp", () => {
		// One stamp per burst leaves most lines bare, and a bare line cannot be counted.
		// The hooks module therefore reads first and compacts last; this is why.
		expect(truncationHint(view, "/b/busybox", { stderrTotal: 1 })).toMatch(/the first 3 and the last 2\. Lines 4-760 are omitted, none of them on stderr/);
		expect(compactStamps(view).split("\n").filter((line) => /^\[/.test(line))).toHaveLength(3);
	});

	test("a build that keeps the head only is still sent to the end", () => {
		const old = "run=R15 exit_code=0 timed_out=false cancelled=false duration_ms=25\ntimeline_lines=3000 shown=547 truncated=true\n--- timeline ---\n[   0.009921 out] line 1";
		expect(truncationHint(old, "/b/busybox")).toMatch(/547 of 3000 lines shown, head only .* --lines 2960:3000/);
	});

	test("the sectioned view has no line numbers to offer, and does not invent any", () => {
		const brief = "run=R2 exit_code=0 timed_out=false cancelled=false duration_ms=5\ncaptured_bytes=90000 capture_complete=true view_truncated=true\n--- stdout ---\nx";
		const hint = truncationHint(brief, "/b/busybox") ?? "";
		expect(hint).toMatch(/^truncated: the view was cut to its budget/);
		expect(hint).toMatch(/\/b\/busybox log R2 --stream stdout --lines A:B reads a stream/);
		expect(hint).not.toMatch(/undefined|NaN| 0 of 0 /);
	});
});

describe("each offset said once, and no more precisely than it is read", () => {
	const lines = [
		"[0.010000111 out] a",
		"[0.010000999 out] b",
		"[0.010500000 err] c",
		"[0.010900000 err] d",
		"[0.250000000 out] e",
		"[0.250000000 out] [INFO] f",
		"[0.250000000 out] timing: is what I print",
		"[0.250000000 out] ",
		"[0.250000000 out] g",
	];
	const text = [HEADER, "timeline_lines=9 shown=9 truncated=false", "--- timeline ---", ...lines].join("\n");

	test("a stamp starts a burst, and the lines under it carry none", () => {
		expect(compactStamps(text).split("\n").slice(3)).toEqual([
			"[0.010 out] a",
			"b",
			// The same millisecond on the other stream: marked, so the change is never missed.
			"[= err] c",
			"d",
			"[0.250 out] e",
			// A line whose own text could be taken for a stamp or for the wrapper keeps a mark.
			"[= out] [INFO] f",
			"[= out] timing: is what I print",
			"",
			"g",
		]);
	});

	test("offsets are cut to the digits asked for, never rounded up, and never padded", () => {
		const one = (line: string, digits?: number) => compactStamps(line, { digits });
		expect(one("[0.038778666 out] x")).toBe("[0.038 out] x");
		// Cut, not rounded: an offset is never later than the event.
		expect(one("[0.038999999 out] x")).toBe("[0.038 out] x");
		expect(one("[0.038778666 out] x", 6)).toBe("[0.038778 out] x");
		expect(one("[0.038778666 out] x", 9)).toBe("[0.038778666 out] x");
		expect(one("[125.004211000 err] x")).toBe("[125.004 err] x");
		// Every shape a build has printed comes out the same way.
		expect(one("[   0.011354 out] x")).toBe("[0.011 out] x");
		expect(one("[00000.005868042 out] x")).toBe("[0.005 out] x");
		// A build that printed fewer digits than asked for keeps what it printed.
		expect(one("[10.23 out] x")).toBe("[10.23 out] x");
	});

	test("with bursts off every line keeps a stamp, still at the precision asked for", () => {
		expect(compactStamps(text, { burst: false }).split("\n").slice(3, 6)).toEqual(["[0.010 out] a", "[0.010 out] b", "[0.010 err] c"]);
		expect(compactStamps(text, { burst: false, digits: 9 }).split("\n").slice(3)).toEqual(lines);
	});

	test("it loses nothing but the decimals: every line can be given its stamp back", () => {
		const millis = lines.map((line) => line.replace(/^\[(\d+\.\d{3})\d* /, "[$1 "));
		expect(expandStamps(compactStamps(text)).split("\n").slice(3)).toEqual(millis);
		// And the person's row is the same lines either way.
		expect(stripTimeline(compactStamps(text))).toBe(stripTimeline(text));
		expect(hasTimeline(compactStamps(slimHeader(text)))).toBe(true);
		// Done twice it changes nothing more.
		expect(compactStamps(compactStamps(text))).toBe(compactStamps(text));
	});

	test("anything that is not a timeline line ends the burst", () => {
		const cut = compactStamps(cutView(["[0.5 out] a", "[0.5 out] b"], ["[0.5 out] y", "[0.5 out] z"], 900)).split("\n");
		// After the cut the offset is said again, even though it is the same number.
		expect(cut.slice(3)).toEqual(["[0.5 out] a", "b", cut[5] as string, "[0.5 out] y", "z"]);
		expect(cut[5]).toMatch(/^\.\.\. \[timeline truncated/);
		// So are the notes: nothing after them is given a stamp back.
		const noted = `${compactStamps(text)}\n${NOTES_MARKER}\ntiming: 0.25s total\nexit_code is \`head\`'s, not the command's.`;
		expect(expandStamps(noted).split("\n").slice(-3)).toEqual([NOTES_MARKER, "timing: 0.25s total", "exit_code is `head`'s, not the command's."]);
	});
});

describe("the header, with only what says something", () => {
	test("three lines become one when nothing happened but the command", () => {
		const raw = "run=R12 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=328\ntimeline_lines=3 shown=3 truncated=false stamp=ns res_ns=41\n--- timeline ---\n[0.011354208 out] ok 1";
		expect(slimHeader(raw)).toBe("run=R12 exit_code=0 duration_ms=328\n[0.011354208 out] ok 1");
		// A build before 0.6.0, whose header has no `idle=` field.
		expect(slimHeader("run=R1 exit_code=4 timed_out=false cancelled=false duration_ms=7\ntimeline_lines=0 shown=0 truncated=false\n--- timeline ---")).toBe("run=R1 exit_code=4 duration_ms=7");
	});

	test("a flag is kept when it is true, and the counts when the view was cut", () => {
		expect(slimHeader("run=R14 exit_code=-1 timed_out=true cancelled=false idle=false duration_ms=120019\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n[0.01 out] x")).toBe(
			"run=R14 exit_code=-1 timed_out=true duration_ms=120019\n[0.01 out] x",
		);
		expect(slimHeader("run=R14 exit_code=-1 timed_out=false cancelled=false idle=true duration_ms=2025\ntimeline_lines=0 shown=0 truncated=false\n--- timeline ---")).toBe("run=R14 exit_code=-1 idle=true duration_ms=2025");
		expect(slimHeader(cutView(["[0.5 out] a"], ["[0.5 out] z"], 900)).split("\n").slice(0, 3)).toEqual([
			"run=R30 exit_code=0 duration_ms=900",
			"timeline_lines=900 shown=2 truncated=true",
			"[0.5 out] a",
		]);
	});

	test("what stands before the header stays, and a result that is not a capture is left alone", () => {
		expect(slimHeader(`TIMEOUT — not a failure\nExit code 3\n${HEADER}\ntimeline_lines=0 shown=0 truncated=false\n--- timeline ---`)).toBe("TIMEOUT — not a failure\nExit code 3\nrun=R30 exit_code=0 duration_ms=900");
		expect(slimHeader("just output\nmore")).toBe("just output\nmore");
	});

	test("the sectioned view keeps its section markers and loses its two paths", () => {
		const brief = [
			"run=R2 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=5",
			"captured_bytes=17 stdout=17 stderr=0 capture_complete=true view_truncated=false",
			"stdout_artifact=/var/folders/9z/T//busybox-run/R2/stdout",
			"stderr_artifact=/var/folders/9z/T//busybox-run/R2/stderr",
			"--- stdout ---",
			"[brief] lines_in=1 records=1",
			"hello",
			"--- stderr ---",
			"(empty)",
		].join("\n");
		expect(slimHeader(brief).split("\n")).toEqual(["run=R2 exit_code=0 duration_ms=5", "--- stdout ---", "[brief] lines_in=1 records=1", "hello", "--- stderr ---", "(empty)"]);
		// A cut view keeps the line that says so.
		expect(slimHeader(brief.replace("view_truncated=false", "view_truncated=true")).split("\n")[1]).toMatch(/^captured_bytes=17 .* view_truncated=true$/);
	});

	test("every reader still reads the one-line header", () => {
		const slim = slimHeader("Exit code 3\nrun=R14 exit_code=-1 timed_out=true cancelled=false idle=false duration_ms=120019\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n[0.01 out] starting");
		expect(parseHeader(slim)).toEqual({ runId: "R14", exitCode: -1, timedOut: true, cancelled: false, idle: false, durationMs: 120019, linesTotal: undefined, linesShown: undefined, truncated: false });
		expect(hasTimeline(slim)).toBe(true);
		expect(stripTimeline(slim)).toBe("Exit code 3\nstarting");
		// A command with no output at all is still recognised as the wrapper's result.
		expect(hasTimeline("run=R9 exit_code=0 duration_ms=3")).toBe(true);
		expect(stripTimeline("run=R9 exit_code=0 duration_ms=3")).toBe("(no output)");
		expect(hasTimeline("the run=R9 exit_code=0 duration_ms=3 was fine")).toBe(false);
	});
});

describe("how a run ended, said first and said truly", () => {
	const idle = "Exit code 3\nrun=R14 exit_code=-1 timed_out=false cancelled=false idle=true duration_ms=120031\ntimeline_lines=0 shown=0 truncated=false\n--- timeline ---";

	test("each notice points at the output that follows it, not at one above", () => {
		const timeout = outcomeNotice(idle.replace("timed_out=false", "timed_out=true").replace("idle=true", "idle=false"), 120, "/b/busybox") ?? "";
		expect(timeout).toMatch(/`exit_code=-1` in the header below/);
		expect(timeout).toMatch(/Everything it printed before the kill follows/);
		expect(outcomeNotice(idle, 120, "/b/busybox", 120)).toMatch(/What it printed before the silence follows/);
		for (const notice of [timeout, outcomeNotice(idle, 120, "/b/busybox", 120) ?? ""]) expect(notice).not.toMatch(/\babove\b/);
	});

	test("a silent command was not waiting on stdin, except in the one mode where a read waits", () => {
		// Measured with a `read` behind a prompt: end-of-file at once on pipes, split and merged.
		const usual = outcomeNotice(idle, 120, "/b/busybox", 120) ?? "";
		expect(usual).toMatch(/it was not on standard input: stdin is empty here and a read returns end-of-file at once/);
		expect(usual).toMatch(/a lock, a socket, a child process that never exits, or a prompt that opens the terminal itself \(`sudo`, `ssh`\)/);
		expect(usual).not.toMatch(/input it was waiting for|cmd < file/);
		// In `raw` the same read sat until the deadline.
		const raw = outcomeNotice(idle, 120, "/b/busybox", 120, false, true) ?? "";
		expect(raw).toMatch(/it may have been reading standard input: in this terminal mode a read there never returns/);
		expect(raw).not.toMatch(/it was not on standard input/);
	});
});

describe("what the guest shell reports about how it ended", () => {
	test("the trap reads the statuses first, in the spelling its shell has", () => {
		// Measured: zsh keeps them in `pipestatus`; `${PIPESTATUS[*]}` is empty there.
		expect(exitTrap("/bin/zsh", { report: true })).toMatch(/^trap '\{ __pt_ps="\$\{pipestatus\[\*\]\}"; \} 2>\/dev\/null; printf /);
		expect(exitTrap("/opt/homebrew/bin/bash", { report: true })).toMatch(/^trap '\{ __pt_ps="\$\{PIPESTATUS\[\*\]\}"; \} 2>\/dev\/null; printf /);
		// Any other shell has neither: the run's folder is reported alone.
		expect(exitTrap("/bin/sh", { report: true })).toBe(`trap 'printf "%s\\n%s\\n" "" "\${BUSYBOX_RUN_DIR:-}" >"$PITIME_FACTS_FILE" 2>/dev/null' EXIT; `);
		// With the carry, the directory is written after the statuses are safe.
		expect(exitTrap("/bin/zsh", { report: true, carryCwd: true })).toMatch(/^trap '\{ __pt_ps="[^"]+"; \} 2>\/dev\/null; pwd -P >"\$PITIME_CWD_FILE" 2>\/dev\/null; printf /);
		expect(exitTrap("/bin/zsh", {})).toBe("");
	});

	test("the wrapper stays one line, and the facts leave on stderr after the capture", () => {
		const wrapped = wrapCommand("make | head -3", { busybox: "/b/busybox", shell: "/bin/zsh", verbosity: "normal", noEnv: true, report: true }) ?? "";
		expect(wrapped.split("\n")).toHaveLength(1);
		expect(wrapped).toMatch(/--env "PITIME_FACTS_FILE=\$__pt_f\.f" -- '\/bin\/zsh' -c 'trap /);
		expect(wrapped).toMatch(/; __pt_rc=\$\?; if \[ -s "\$__pt_f\.f" \]; then \{ IFS= read -r __pt_ps; IFS= read -r __pt_rd; \} <"\$__pt_f\.f"; printf 'pitime_facts ps=\[%s\] dir=%s\\n' "\$__pt_ps" "\$__pt_rd" >&2; fi; rm -f "\$__pt_f" "\$__pt_f\.f"; \(exit "\$__pt_rc"\)$/);
		// No carry was asked for, so the outer shell does not move.
		expect(wrapped).not.toMatch(/cd -- /);
	});

	test("the facts line is taken out of whatever text holds it", () => {
		expect(takeFacts("pitime_facts ps=[1 141 0] dir=/t/busybox-run/R7\n")).toEqual({ text: "", facts: { pipestatus: [1, 141, 0], runDir: "/t/busybox-run/R7" } });
		// A shell with no statuses to give, and a folder with a space in it.
		expect(takeFacts("warn\npitime_facts ps=[] dir=/t x/busybox-run/R7\nmore")).toEqual({ text: "warn\nmore", facts: { runDir: "/t x/busybox-run/R7" } });
		// Nothing to take: the text is handed back as it came.
		expect(takeFacts("just stderr")).toEqual({ text: "just stderr" });
		// Inside a timeline it is the command's own line, with a stamp in front, and stays.
		expect(takeFacts("[0.1 out] pitime_facts ps=[9] dir=/x").facts).toBe(undefined);
		// Where the host folds stderr into stdout the line follows the view; only the last
		// one is the wrapper's, so a command's own line of that shape (`brief` has no
		// stamps to tell them apart) is left where it was.
		expect(takeFacts("--- stdout ---\npitime_facts ps=[7] dir=/mine\n--- stderr ---\n(empty)\npitime_facts ps=[0 1] dir=/t/busybox-run/R9")).toEqual({
			text: "--- stdout ---\npitime_facts ps=[7] dir=/mine\n--- stderr ---\n(empty)",
			facts: { pipestatus: [0, 1], runDir: "/t/busybox-run/R9" },
		});
	});

	test("the statuses are stated only when they say something the header does not", () => {
		expect(describePipestatus([1, 141, 0], 0)).toMatch(/^pipeline stage statuses: 1 141 0 — the exit_code shown is the last stage's; 141 is a stage ended by SIGPIPE/);
		expect(describePipestatus([141, 0], 0)).not.toMatch(/an earlier stage failed/);
		expect(describePipestatus([2, 0], 0)).toMatch(/an earlier stage failed \(2\) and the header does not show it\.$/);
		// All zero, or not a pipeline at all: nothing to add.
		expect(describePipestatus([0, 0, 0], 0)).toBe(undefined);
		expect(describePipestatus([1], 1)).toBe(undefined);
		// `a | b; exit 7`: these are not the statuses behind the header's code.
		expect(describePipestatus([1, 0], 7)).toBe(undefined);
	});

	test("a fact replaces the guess, and silence replaces a caveat that does not apply", () => {
		expect(resultNotes("make | head -3", { cwdCarried: true })).toHaveLength(1);
		expect(resultNotes("make | head -3", { cwdCarried: true, facts: { pipestatus: [0, 0] }, exitCode: 0 })).toEqual([]);
		expect(resultNotes("make | head -3", { cwdCarried: true, facts: { pipestatus: [2, 0] }, exitCode: 0 })[0]).toMatch(/^pipeline stage statuses: 2 0 /);
		// The statuses are those of the last pipeline run, so a line that only *looks* like
		// it ends in `head` no longer earns the caveat.
		expect(resultNotes("make | head -3; echo done", { cwdCarried: true, facts: { pipestatus: [0] }, exitCode: 0 })).toEqual([]);
		// Facts without statuses (a plain `sh`) leave the caveat standing.
		expect(resultNotes("make | tail -3", { cwdCarried: true, facts: { runDir: "/t/busybox-run/R1" }, exitCode: 0 })[0]).toMatch(/pipeline ends in `tail`/);
	});
});

describe("notes are about this call's shell, and are said in full once", () => {
	test("a heredoc's body is data, and a quoted `|` separates nothing", () => {
		// Met in use: a script written through a heredoc that mentioned `|| true`.
		const script = "python3 - <<'EOF'\nprint('x || true')\nsubprocess.run('make 2>/dev/null | head -1 &')\nEOF";
		expect(resultNotes(script, { cwdCarried: true })).toEqual([]);
		expect(resultNotes('grep -n "a\\|head -3" notes.md', { cwdCarried: true, exitCode: 0 })).toEqual([]);
		expect(resultNotes("echo 'a || true'", { cwdCarried: true })).toEqual([]);
		// What a nested shell discards is still discarded.
		expect(resultNotes("sh -c 'make 2>/dev/null'", { cwdCarried: true })[0]).toMatch(/stderr was discarded/);
		// And the real thing still earns its note.
		expect(resultNotes("make || true", { cwdCarried: true })[0]).toMatch(/hidden by `\|\| true`/);
	});

	test("a note seen before comes back in a few words", () => {
		const seen = new Set<string>();
		const command = "lint || true\nmake 2>/dev/null | tail -5";
		const first = resultNotes(command, { cwdCarried: true, seen });
		const again = resultNotes(command, { cwdCarried: true, seen });
		expect(first).toHaveLength(3);
		expect(again).toEqual(["stderr was discarded (`2>/dev/null`): unknown.", "exit_code is `tail`'s, not the command's.", "`|| true` may hide a failure."]);
		for (const [index, note] of again.entries()) expect(note.length < (first[index] as string).length).toBe(true);
		expect(again.join("\n").length < first.join("\n").length / 2).toBe(true);
		// A note of another kind is still new, and full.
		expect(resultNotes("cd build && make", { seen })[0]).toMatch(/`cd` affects this call only; the next Bash call starts back where this one began/);
		expect(resultNotes("cd build && make", { seen })).toEqual(["`cd` does not carry to the next call."]);
	});
});

describe("commands that cannot end here", () => {
	const hit = (command: string) => detectEndless(command)?.label;

	test("what waits for a key, follows for ever, or serves until stopped", () => {
		expect(hit("watch -n 2 kubectl get pods")).toMatch(/`watch` repeats/);
		expect(hit("sudo vim /etc/hosts")).toMatch(/an editor/);
		expect(hit("git log --oneline | less")).toMatch(/a pager/);
		expect(hit("cd logs && tail -f app.log")).toMatch(/`tail -f` follows/);
		expect(hit("tail -100f app.log")).toMatch(/`tail -f` follows/);
		expect(hit("top")).toMatch(/`top` redraws/);
		expect(hit("sleep infinity")).toMatch(/never returns/);
		expect(hit("git rebase -i HEAD~3")).toMatch(/opens an editor/);
		expect(hit("git add -p")).toMatch(/asks questions/);
		expect(hit("docker compose up")).toMatch(/stays attached/);
		expect(hit("kubectl logs -f deploy/api")).toMatch(/follows until interrupted/);
		expect(hit("PORT=3000 npm start")).toMatch(/runs until stopped/);
		expect(hit("env FLASK_APP=app flask run")).toMatch(/development server/);
	});

	test("only the command word of a statement is judged, and only where it can hang", () => {
		for (const command of [
			"tail -n 100 app.log",
			"tail -f app.log | grep -m1 listening",
			"timeout 30 tail -f app.log",
			"tail -f app.log --pid 4242",
			"less --version",
			"cat notes.md | less | head -5",
			"top -l 1 | head -20",
			"docker compose up -d",
			"git rebase main",
			"npm run build",
			"npm run dev &",
			"emacs --batch -l build.el",
			"yes | apt-get install foo",
			"echo 'then run vim'",
			"man less > less.txt",
			"cat > NOTES <<EOF\nwatch the logs with tail -f\nEOF",
			'python3 -c "\nimport os\nos.system(\'less x\')\n"',
		]) {
			expect(detectEndless(command)).toBe(undefined);
		}
	});

	test("quoted text is blanked before anything is split, and keeps its length and lines", () => {
		expect(maskQuotes(`grep "a|b" 'c;d' e\\|f`)).toBe("grep _____ _____ e__f");
		expect(maskQuotes('echo "one\ntwo" three')).toBe("echo ____\n____ three");
		expect(maskQuotes("say 'it''s'")).toBe("say _______");
	});

	test("the refusal carries what to write, and the way to say it does end", () => {
		const reason = endlessReason(detectEndless("npm run dev") as NonNullable<ReturnType<typeof detectEndless>>);
		expect(reason).toMatch(/^Blocked before running: `npm run dev` does not end on its own here/);
		expect(reason).toMatch(/\nInstead: run the call with `run_in_background: true` and read its output as it arrives/);
		expect(reason).toMatch(/append `# pitime-safe` to the command\.$/);
		// Nothing here names a tool this host does not have.
		for (const command of ["watch ls", "vim x", "less x", "tail -f x", "sleep infinity", "npm start", "htop"]) {
			expect(endlessReason(detectEndless(command) as NonNullable<ReturnType<typeof detectEndless>>)).not.toMatch(/busybox_job|waitfor|busybox replace|read tool|edit tool/);
		}
	});
});

describe("asking the build what it is, by running it", () => {
	test("the self-test carries the flags a command will get, and only those the build has", () => {
		expect(probeArgv("/b/busybox", abilitiesOf(["run", "log", "stamp-ns", "idle-timeout"]))).toEqual([
			"/b/busybox", "run", "--timestamps", "--stamp-ns", "--max-bytes", "4000", "--timeout", "10", "--idle-timeout", "10", "--", "/bin/sh", "-c", "echo pi-time-probe",
		]);
		const older = probeArgv("/b/busybox", abilitiesOf(["run", "log"]));
		expect(older).not.toContain("--stamp-ns");
		expect(older).not.toContain("--idle-timeout");
		// Never a terminal: this process is outside the sandbox a command may run in.
		expect(older.join(" ")).not.toMatch(/--pty/);
		expect(older.join(" ")).not.toMatch(/--prune/);
	});

	test("a timeline with the probe's word is a pass; anything else is a reason", () => {
		const stdout = "run=R9 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=4\ntimeline_lines=1 shown=1 truncated=false stamp=ns res_ns=41\n--- timeline ---\n[0.004211000 out] pi-time-probe\n";
		expect(readProbe({ exitCode: 0, stdout, stderr: "" })).toEqual({
			ok: true,
			stamp: { pad: "none", width: 1, digits: 9 },
			header: "run=R9 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=4",
		});
		expect(readProbe({ exitCode: 1, stdout: "", stderr: "run: unrecognized option: stamp-ns\nUsage: run" })).toEqual({ ok: false, stamp: DEFAULT_STAMP, reason: "run: unrecognized option: stamp-ns" });
		// It ran, and printed no timeline.
		expect(readProbe({ exitCode: 0, stdout: "pi-time-probe\n", stderr: "" })).toEqual({ ok: false, stamp: DEFAULT_STAMP, reason: "pi-time-probe" });
		expect(readProbe({ exitCode: 0, stdout: "", stderr: "" }).reason).toBe("it printed no timeline for a wrapped `echo`");
	});

	test("the stamp's shape is read off a real line and drawn back the same way", () => {
		expect(stampShape("[   0.006244 out] x")).toEqual({ pad: "space", width: 4, digits: 6 });
		expect(stampShape("[00000.005868042 out] x")).toEqual({ pad: "zero", width: 5, digits: 9 });
		expect(stampShape("[0.005868042 err] x")).toEqual({ pad: "none", width: 1, digits: 9 });
		expect(stampShape("[10.23 out] x")).toEqual({ pad: "none", width: 2, digits: 2 });
		expect(stampShape("no stamp")).toBe(undefined);
		expect(exampleStamp({ pad: "space", width: 4, digits: 6 }, "out")).toBe("[   0.012345 out]");
		expect(exampleStamp({ pad: "zero", width: 5, digits: 9 }, "err", true)).toBe("[00000.012349012 err]");
		expect(exampleStamp(DEFAULT_STAMP, "out")).toBe("[0.012345678 out]");
	});

	test("the example header is the build's own, with round numbers in it", () => {
		expect(exampleHeader("run=R7193 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=98")).toBe(
			"run=R12 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=328",
		);
		expect(exampleHeader(undefined)).toBe("run=R12 exit_code=0 timed_out=false cancelled=false duration_ms=328");
		expect(exampleHeader("garbage")).toBe("run=R12 exit_code=0 timed_out=false cancelled=false duration_ms=328");
	});
});

describe("which captures may be removed", () => {
	test("the root is `$TMPDIR/busybox-run`, as the applet has it", () => {
		expect(defaultRunRoot("/var/folders/9z/T/")).toBe("/var/folders/9z/T/busybox-run");
		expect(defaultRunRoot(undefined)).toBe("/tmp/busybox-run");
		expect(defaultRunRoot("  ")).toBe("/tmp/busybox-run");
		expect(runRootOf("/var/folders/9z/T//busybox-run/R7186")).toBe("/var/folders/9z/T//busybox-run");
		expect(runRootOf("/tmp/elsewhere/R7")).toBe(undefined);
		expect(runRootOf(undefined)).toBe(undefined);
	});

	test("only a folder named busybox-run is ever swept", () => {
		expect(isRunRoot("/tmp/busybox-run")).toBe(true);
		expect(isRunRoot("/var/folders/9z/T//busybox-run")).toBe(true);
		for (const root of ["/tmp", "/", "", "busybox-run", "/tmp/busybox-run/", "/tmp/busybox-run-old", "/tmp/x/../busybox-run", "/home/me"]) {
			expect(isRunRoot(root)).toBe(false);
		}
	});

	test("the newest are kept whatever their age, and only run folders are candidates", () => {
		const listing = ["R9", "notes.txt", "R8", "R7x", "R7", "", ".", "R6", "r5", "R4"];
		expect(excessRuns(listing, 2)).toEqual(["R7", "R6", "R4"]);
		expect(excessRuns(listing, 200)).toEqual([]);
		expect(excessRuns(listing, 0)).toEqual(["R9", "R8", "R7", "R6", "R4"]);
	});

	test("beyond the count a run still has to be hours old", () => {
		const now = 1_800_000_000_000;
		const twoHours = 120 * 60_000;
		expect(isStale(now - twoHours, now, twoHours)).toBe(true);
		expect(isStale(now - twoHours + 1, now, twoHours)).toBe(false);
		// A time that cannot be read, a clock that ran backwards, an age limit of nothing:
		// none of them is "old enough".
		expect(isStale(0, now, twoHours)).toBe(false);
		expect(isStale(Number.NaN, now, twoHours)).toBe(false);
		expect(isStale(now + 60_000, now, twoHours)).toBe(false);
		expect(isStale(now - 5, now, 0)).toBe(false);
	});
});
