/**
 * What a result says, and what a guard refuses: the cases a bug hunt in pi-managed-tools
 * reproduced, ported here with the fixes. Two lists came out of that hunt — statements to
 * the model that were false, and harmless commands a guard turned away. A new note, notice
 * or refusal should arrive with its counter-example in this file.
 */
import { describe, expect, test } from "claude-code/testing";
import { detectEndless, detectTailMerge, hasOverride, resultNotes } from "../src/guard";
import { planDeadline } from "../src/policy";
import { parseHeader, parseTimeline, summarizeTiming } from "../src/timing";
import { exitTrap, isWrapped } from "../src/wrap";

const notes = (command: string) => resultNotes(command).join("\n");

describe("statements that must be true", () => {
	test("a header is the first line of a result (after the host's own), and has an exit code", () => {
		const quoted = "notes on yesterday:\nrun=R1 exit_code=-1 timed_out=true cancelled=false idle=false duration_ms=120004\ntimeline_lines=9000 shown=20 truncated=true\n";
		expect(parseHeader(quoted)).toBe(undefined);
		// `busybox log R --summary` starts `run=R84 lines=…`: not a run that ended.
		expect(parseHeader("run=R84 lines=3 stdout_bytes=12 stderr_bytes=0\n")).toBe(undefined);
		// The host's own first line does not hide the real one.
		expect(parseHeader("Exit code 3\nrun=R14 exit_code=-1 timed_out=true cancelled=false idle=false duration_ms=120019\n")?.runId).toBe("R14");
	});

	test("the digest does not invent a pause across a cut view, and keeps both silences", () => {
		const stamp = (us: number, text: string) => `[${(us / 1e6).toFixed(9)} out] ${text}`;
		const cut = ["run=R1 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=6190", "timeline_lines=400 shown=4 truncated=true", "--- timeline ---", stamp(10_000, "a"), stamp(20_000, "b"), "... [timeline truncated: 4 of 400 lines shown (396 omitted); `log R1 --stream timeline' has them] ...", stamp(6_100_000, "y"), stamp(6_110_000, "z")].join("\n");
		const digest = summarizeTiming(parseTimeline(cut), 6190) ?? "";
		expect(digest).toMatch(/4 lines shown/);
		expect(/longest pause/.test(digest)).toBe(false);
		const both = ["run=R1 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=5520", "--- timeline ---", stamp(10_000, "a"), stamp(4_010_000, "b")].join("\n");
		const two = summarizeTiming(parseTimeline(both), 5520) ?? "";
		expect(two).toMatch(/longest pause 4\.00s/);
		expect(two).toMatch(/silent 1\.51s after the last line/);
	});

	test("notes are about what the shell ran", () => {
		expect(/left running|left in the background/.test(notes("sleep 30 &\nPID=$!\nsleep 1; kill $PID"))).toBe(false);
		expect(notes("sleep 20 & echo started")).toMatch(/left running/);
		expect(/left running/.test(notes("make && make test"))).toBe(false);
		// A string that mentions a redirect is not one; a nested shell's string is.
		expect(/discarded/.test(notes("echo ' >/dev/null is how you silence it'"))).toBe(false);
		expect(notes("sh -c 'make 2>/dev/null'")).toMatch(/stderr was discarded/);
		// Both streams thrown away: said once, as both.
		expect(notes("cmd >/dev/null 2>&1")).toMatch(/stdout and stderr were both discarded/);
		expect(/^stdout was discarded/m.test(notes("cmd >/dev/null 2>&1"))).toBe(false);
		// "The pipeline ends in …" needs a pipeline.
		for (const command of ["tail -n 2 notes.txt", "make || tail -5 build.log", 'grep -c "a|tail" f']) expect(/pipeline ends in/.test(notes(command))).toBe(false);
		expect(notes('grep -c "a|tail" f')).toMatch(/this is a `grep`: exit_code 1 means no match/);
		expect(notes("make | grep error")).toMatch(/the pipeline ends in `grep`/);
		expect(notes("make | tail -5")).toMatch(/the pipeline ends in `tail`/);
	});

	test("a default deadline under a second is a deadline of one, not of none", () => {
		expect(planDeadline({ defaultSeconds: 0.5 }).budgetSeconds).toBe(1);
	});

	test("the exit trap says nothing under set -x", () => {
		expect(exitTrap("/bin/bash", { report: true })).toMatch(/\{ __pt_ps="\$\{PIPESTATUS\[\*\]\}"; \} 2>\/dev\/null/);
	});
});

describe("commands a guard must let through", () => {
	test("the merge guard: nothing reaches the view, or nothing is merged", () => {
		for (const command of [
			"make >/dev/null 2>&1",
			"which gdb lldb > /dev/null 2>&1 && echo found",
			"python3 -c 'x=1' >/dev/null 2>&1; python3 -c 'print(2)'",
			"make &>/dev/null",
			"make &>> /dev/null",
			'grep -n "2>&1" src/guard.ts',
			'git commit -m "ban 2>&1"',
			"ls # was: ls 2>&1",
			"rg -n '\\|&' src",
			["cat > notes.md <<'EOF'", "never end a command with 2>&1", "EOF"].join("\n"),
		]) {
			expect(detectTailMerge(command)).toBe(undefined);
		}
	});

	test("and what it must still refuse", () => {
		for (const command of ["make -j8 2>&1", "make 2>&1 | tail -5", "python3 app.py |& grep ERROR", "cmd >srv.log 2>&1 &", "cmd 2>&1 >/dev/null", "cmd &> out.txt"]) {
			expect(Boolean(detectTailMerge(command))).toBe(true);
		}
		expect(hasOverride('git commit -m "explain the # pitime-safe marker"')).toBe(false);
		expect(hasOverride("make 2>&1 # pitime-safe")).toBe(true);
	});

	test("the endless guard: words that are data, and commands that end", () => {
		for (const command of [
			"python3 -m http.server 8000 & sleep 1; curl -s localhost:8000; kill %1",
			"tail -f app.log & sleep 2; kill $!",
			"# run the tests; watch for failures\nnpm test",
			"# Don't run yet\ngit commit -m 'fix guard; watch for regressions'",
			"GIT_SEQUENCE_EDITOR=true git rebase -i HEAD~3",
			"git -c sequence.editor=true rebase -i HEAD~3",
			"vim -es -c '%s/a/b/' -c wq notes.txt",
			"nvim --headless -c q",
			"rails dev:cache",
			"editors=(\n  vim\n  nano\n  less\n)\necho ${#editors[@]}",
			'case "$EDITOR" in\n  vi|vim|nvim) echo modal ;;\n  nano|pico) echo simple ;;\nesac',
			"tail -f app.log | grep -m1 ready",
			"timeout 5 tail -f app.log",
			'grep foo <<< "$text"',
		]) {
			expect(detectEndless(command)).toBe(undefined);
		}
	});

	test("and what it must still refuse, quoted as written", () => {
		for (const command of ["tail -f app.log", "tail -fn 5 app.log", "watch date", "vim notes.txt", "rails server", "git rebase -i HEAD~3", "# don't wait\ntail -f app.log", "less README.md", 'grep foo <<< "$text"\ntail -f app.log']) {
			expect(Boolean(detectEndless(command))).toBe(true);
		}
		expect(detectEndless("tail -f 'my app.log'")?.excerpt).toBe("tail -f 'my app.log'");
	});

	test("a compound command that starts with busybox is the model's own script", () => {
		expect(isWrapped("busybox waitfor --tcp 127.0.0.1:3000 && npm test")).toBe(false);
		expect(isWrapped("busybox true; tail -f /var/log/system.log")).toBe(false);
		expect(isWrapped("busybox run -t -- ls")).toBe(true);
		expect(isWrapped("busybox peek 'a;b.txt'")).toBe(true);
	});
});
