import { describe, expect, test } from "claude-code/testing";

import {
	OVERRIDE_MARKER,
	blockReason,
	detectTailMerge,
	guardEnabled,
	hasOverride,
	resultNotes,
} from "../src/guard";

describe("the tail-zone merge guard", () => {
	test("catches the reflex shapes at the command's tail", () => {
		for (const command of [
			"cmd >srv.log 2>&1 &",
			"cmd >/dev/null 2>&1",
			"make -j8 2>&1",
			"python3 app.py |& grep ERROR",
			"cmd &> out.txt",
			"cmd &>> out.txt",
		]) {
			const hit = detectTailMerge(command);
			expect(Boolean(hit)).toBe(true);
			expect((hit?.excerpt.length ?? 0) > 0).toBe(true);
		}
	});

	test("catches a merge on the second-to-last line", () => {
		// The server-and-echo shape the benchmark caught: the merge is not on the final line.
		const command = "python3 -m http.server 8731 >/tmp/serve.log 2>&1 &\necho started";
		expect(detectTailMerge(command)?.label).toBe("2>&1");
	});

	test("leaves a merge buried deep in a script alone", () => {
		// First-order scripting from memory: the whole point is not to nag inside this.
		const command = [
			"busybox sh -c '",
			"for d in a b c d e; do",
			"  python3 analyze.py \"$d\" 2>&1 | head -5 > report-$d.txt",
			"  if [ -s report-$d.txt ]; then echo \"$d ok\"; else echo \"$d empty\"; fi",
			"done'",
			"",
		].join("\n");
		expect(detectTailMerge(command)).toBe(undefined);
	});

	test("the zone is the last ~24 chars of each of the last two lines", () => {
		// Same merge, but far from the tail of a long line: out of scope by design.
		const command = "python3 analyze.py 2>&1 | long_filter --with many --flags --options --more";
		expect(detectTailMerge(command)).toBe(undefined);
	});

	test("the override marker declares a merge intentional", () => {
		expect(Boolean(hasOverride(`cmd >log 2>&1 & ${OVERRIDE_MARKER}`))).toBe(true);
		expect(Boolean(hasOverride("cmd 2>&1 # pitime-safe"))).toBe(true);
		expect(hasOverride("cmd 2>&1")).toBe(false);
		expect(hasOverride("cmd 2>&1 # pitime-safety pins")).toBe(false);
	});

	test("guardEnabled: on by default, off when asked", () => {
		expect(guardEnabled({})).toBe(true);
		expect(guardEnabled({ CLAUDE_MANAGED_TOOLS_GUARD: "off" })).toBe(false);
		expect(guardEnabled({ CLAUDE_MANAGED_TOOLS_GUARD: "0" })).toBe(false);
		expect(guardEnabled({ CLAUDE_MANAGED_TOOLS_GUARD: "yes" })).toBe(true);
		// Unset, the plugin's own option decides; set, the environment wins over it.
		expect(guardEnabled({}, false)).toBe(false);
		expect(guardEnabled({ CLAUDE_MANAGED_TOOLS_GUARD: "on" }, false)).toBe(true);
		expect(guardEnabled({ CLAUDE_MANAGED_TOOLS_GUARD: "off" }, true)).toBe(false);
	});

	test("the refusal asks for a rewrite and names the marker", () => {
		const reason = blockReason({ label: "2>&1", excerpt: ">srv.log 2>&1 &" });
		expect(reason).toMatch(/Blocked before running/);
		expect(reason).toMatch(/merges stderr into stdout/);
		expect(reason).toMatch(/Rewrite instead/);
		expect(reason).toMatch(new RegExp(OVERRIDE_MARKER));
	});
});

describe("what the result must state about its own holes", () => {
	test("a discarded stream is named as unknown", () => {
		expect(Boolean(resultNotes("cmd 2>/dev/null").some((note) => /stderr was discarded/.test(note)))).toBe(true);
		expect(Boolean(resultNotes("cmd >/dev/null").some((note) => /stdout was discarded/.test(note)))).toBe(true);
		// 2>/dev/null must not also count as a stdout discard.
		expect(resultNotes("cmd 2>/dev/null").some((note) => /stdout was discarded/.test(note))).toBe(false);
		expect(resultNotes("cmd > out.txt").length).toBe(0);
	});

	test("a backgrounded process warns that the timeline stops", () => {
		const notes = resultNotes("python3 -m http.server 8731 >srv.log 2>srv.err &");
		expect(Boolean(notes.some((note) => /background/.test(note)))).toBe(true);
		// Polled or waited for: no warning needed.
		expect(resultNotes("server &; waitfor --tcp 127.0.0.1:8731").some((note) => /background/.test(note))).toBe(false);
	});

	test("a declared merge warns the tags are not evidence", () => {
		const notes = resultNotes(`cmd >log 2>&1 & ${OVERRIDE_MARKER}`);
		expect(Boolean(notes.some((note) => /by design/.test(note)))).toBe(true);
	});

	test("the pipeline's exit-status owner is named when it lies", () => {
		const piped = resultNotes("pytest -q | head -20");
		expect(Boolean(piped.some((note) => /pipeline ends in `head`/.test(note) && /if `head` closed the pipe early/.test(note)))).toBe(true);
		// `tail` reads to the end: it replaces the status but never ends the command early.
		const tailed = resultNotes("make test | tail -20");
		expect(tailed.some((note) => /pipeline ends in `tail`/.test(note) && /ran to its end/.test(note))).toBe(true);
		expect(tailed.some((note) => /SIGPIPE/.test(note))).toBe(false);
		const grepped = resultNotes("ls -la | grep -i todo");
		expect(Boolean(grepped.some((note) => /exit_code 1 means no match/.test(note)))).toBe(true);
		const masked = resultNotes("flakey-step || true");
		expect(Boolean(masked.some((note) => /hidden by `\|\| true`/.test(note)))).toBe(true);
		// A stage that is not last does not own the exit code, so it does not earn a note.
		expect(resultNotes("cat f | grep x | wc -l").some((note) => /grep/.test(note))).toBe(false);
		expect(resultNotes("ls -la").length).toBe(0);
	});

	test("a top-level cd warns that it is call-local", () => {
		const cd = resultNotes("cd build && make");
		expect(Boolean(cd.some((note) => /affects this call only/.test(note)))).toBe(true);
		const cdMid = resultNotes("ls -la; cd test && python3 -m pytest");
		expect(Boolean(cdMid.some((note) => /absolute paths/.test(note)))).toBe(true);
		// With the carry on, `cd` behaves as it does unwrapped: there is nothing to warn about.
		expect(resultNotes("cd build && make", { cwdCarried: true }).length).toBe(0);
		// The escape runs in the host's own shell, where `cd` carries anyway.
		expect(resultNotes("cd build && make # pitime-raw", { escaped: true }).some((note) => /affects this call only/.test(note))).toBe(false);
		// Not this call's shell: a cd inside a heredoc body or a nested command does not warn.
		expect(resultNotes(["busybox sh -c 'cd x && ls'", ""].join("\n")).length).toBe(0);
		const heredoc = ["python3 - <<'EOF'", "import os", "os.chdir('x')", "EOF", ""].join("\n");
		expect(resultNotes(heredoc).length).toBe(0);
	});

	test("an escaped call says exactly what it did not capture", () => {
		const notes = resultNotes("jq -r .a f.json # pitime-raw", { escaped: true });
		expect(Boolean(notes.some((note) => /no timeline, no stream tags/.test(note)))).toBe(true);
		expect(Boolean(notes.some((note) => /`# pitime-raw`/.test(note)))).toBe(true);
	});
});
