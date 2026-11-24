/**
 * `/sh`: what the person sees and what the model reads, from one captured run.
 */
import { describe, expect, test } from "claude-code/testing";
import { fenced, isPersonsOwn, modelContext, outcomeLine, personText } from "../src/shell";

const OK = [
	"run=R12 exit_code=0 timed_out=false cancelled=false duration_ms=1214",
	"timeline_lines=3 shown=3 truncated=false",
	"--- timeline ---",
	"[   0.006010 out] one",
	"[   1.213626 err] warn",
	"[   1.213659 out] two",
].join("\n");

describe("how the run ended, in a line", () => {
	test("exit status and duration", () => {
		expect(outcomeLine(OK)).toBe("exit 0 · 1.21s");
		expect(outcomeLine(OK.replace("exit_code=0", "exit_code=4"))).toBe("exit 4 · 1.21s");
	});

	test("a deadline, a cancellation and a signal are named, not shown as a status", () => {
		const base = OK.replace("exit_code=0", "exit_code=-1");
		expect(outcomeLine(base.replace("timed_out=false", "timed_out=true"))).toMatch(/^timed out · 1\.21s — stopped at the deadline, not a failure/);
		expect(outcomeLine(base.replace("cancelled=false", "cancelled=true"))).toBe("cancelled · 1.21s");
		expect(outcomeLine(base)).toBe("killed by a signal · 1.21s");
	});

	test("a command that ran unwrapped says so instead of inventing a status", () => {
		expect(outcomeLine("raw-bytes")).toBe("ran outside the capture");
	});
});

describe("the person's row", () => {
	test("is the command's own lines, fenced, under the outcome", () => {
		expect(personText(OK)).toBe("exit 0 · 1.21s\n```\none\nwarn\ntwo\n```");
	});

	test("never opens with the fence, because the host leads the row with the plugin's name", () => {
		expect(personText(OK).startsWith("`")).toBe(false);
	});

	test("the host's own 'Exit code N' line is not said twice", () => {
		const failed = `Exit code 4\n${OK.replace("exit_code=0", "exit_code=4")}`;
		expect(personText(failed)).toBe("exit 4 · 1.21s\n```\none\nwarn\ntwo\n```");
	});

	test("a truncated view says how much of it is shown", () => {
		const cut = OK.replace("timeline_lines=3 shown=3 truncated=false", "timeline_lines=3000 shown=547 truncated=true");
		expect(personText(cut).split("\n")[0]).toBe("exit 0 · 1.21s · first 547 of 3000 lines shown");
	});

	test("output that contains a fence cannot close the row's own", () => {
		const text = "before\n```\ncode\n```\nafter";
		expect(fenced(text)).toBe(`\`\`\`\`\n${text}\n\`\`\`\``);
		expect(fenced("plain")).toBe("```\nplain\n```");
	});

	test("no output reads as no output", () => {
		const silent = "run=R1 exit_code=0 timed_out=false cancelled=false duration_ms=8\ntimeline_lines=0 shown=0 truncated=false\n--- timeline ---";
		expect(personText(silent)).toBe("exit 0 · 0.01s\n```\n(no output)\n```");
	});
});

describe("what the model reads", () => {
	test("the command and its whole timeline, framed as the user's own act", () => {
		const context = modelContext("make test", OK);
		expect(context).toMatch(/^The user ran the following shell command themselves with `\/sh`/);
		expect(context).toMatch(/it is not a request\.\n<bash-input>make test<\/bash-input>\n<bash-stdout>\nrun=R12 /);
		expect(context).toMatch(/\[ {3}1\.213626 err\] warn/);
		expect(context.endsWith("\n</bash-stdout>")).toBe(true);
	});
});

describe("who may run it", () => {
	test("the person's own three doors, and nothing else", () => {
		for (const kind of ["composer", "bridge", "sdk"]) expect(isPersonsOwn(kind)).toBe(true);
		for (const kind of ["peer", "peer-send-message", "channel", "scheduled-trigger", "task-notification", "coordinator", "observer", "plugin", "unclassified", "a-kind-added-later", undefined]) {
			expect(isPersonsOwn(kind)).toBe(false);
		}
	});
});
