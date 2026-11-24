/**
 * The pure rules behind the 0.6.0 work: when to ask for a release, what counts as a
 * different binary, what a feature list earns, and how the wider stamps are read.
 */
import { describe, expect, test } from "claude-code/testing";
import { abilitiesOf, isCheckDue, needsInstall, readInstallState, stampShape, UPDATE_INTERVAL_MS } from "../src/busybox";
import { hasTimeline, stripTimeline } from "../src/display";
import { sectionText } from "../src/prompt";
import { outcomeLine } from "../src/shell";
import { outcomeNotice, parseTimeline, summarizeTiming } from "../src/timing";
import { DEFAULT_IDLE_SECONDS, readIdleSeconds, runPrefix } from "../src/wrap";

const SHA = "a".repeat(64);
const LATEST = { tag: "v0.6.0", name: "busybox-static-1.39.0-aac079e-darwin-universal", url: "https://github.com/rob-c/busybox-static/releases/download/v0.6.0/x", sha256: SHA };

describe("when GitHub is asked", () => {
	const now = 1_000_000_000_000;

	test("at once when the plugin has no copy of its own, whatever was checked", () => {
		expect(isCheckDue({ now, checkedAt: now, hasBinary: false })).toBe(true);
	});

	test("once a day when it has one", () => {
		expect(isCheckDue({ now, checkedAt: now - 60_000, hasBinary: true })).toBe(false);
		expect(isCheckDue({ now, checkedAt: now - UPDATE_INTERVAL_MS, hasBinary: true })).toBe(true);
		expect(isCheckDue({ now, hasBinary: true })).toBe(true);
	});

	test("a timestamp from the future cannot switch the check off", () => {
		expect(isCheckDue({ now, checkedAt: now + 5 * UPDATE_INTERVAL_MS, hasBinary: true })).toBe(true);
		expect(isCheckDue({ now, checkedAt: Number.NaN, hasBinary: true })).toBe(true);
	});
});

describe("what counts as a different binary", () => {
	const installed = { tag: "v0.6.0", asset: LATEST.name, sha256: SHA, installedAt: 1 };

	test("the same tag and checksum is the same binary", () => {
		expect(needsInstall({ latest: LATEST, installed, hasBinary: true })).toBe(false);
	});

	test("another tag, or the same tag re-cut, is not", () => {
		expect(needsInstall({ latest: LATEST, installed: { ...installed, tag: "v0.5.1" }, hasBinary: true })).toBe(true);
		expect(needsInstall({ latest: LATEST, installed: { ...installed, sha256: "b".repeat(64) }, hasBinary: true })).toBe(true);
	});

	test("an older tag on offer still replaces: latest is what GitHub calls latest", () => {
		// No version ordering is attempted, so a yanked release is followed back down.
		expect(needsInstall({ latest: { ...LATEST, tag: "v0.5.9" }, installed, hasBinary: true })).toBe(true);
	});

	test("a missing file or a missing record always installs", () => {
		expect(needsInstall({ latest: LATEST, installed, hasBinary: false })).toBe(true);
		expect(needsInstall({ latest: LATEST, hasBinary: true })).toBe(true);
	});

	test("the record is read defensively: anything malformed is no record", () => {
		expect(readInstallState({ tag: "v0.6.0", asset: "a", sha256: SHA, installedAt: 5 })).toEqual({ tag: "v0.6.0", asset: "a", sha256: SHA, installedAt: 5 });
		expect(readInstallState({ tag: "v0.6.0", asset: "a", sha256: SHA })?.installedAt).toBe(0);
		expect(readInstallState({ tag: "v0.6.0" })).toBe(undefined);
		expect(readInstallState("v0.6.0")).toBe(undefined);
		expect(readInstallState(undefined)).toBe(undefined);
	});
});

describe("what a feature list earns", () => {
	test("each newer flag is tied to the feature that declares it", () => {
		expect(abilitiesOf(["run", "log", "stamp-ns", "idle-timeout", "log-query"])).toEqual({ stampNs: true, idleTimeout: true, logQuery: true });
		expect(abilitiesOf(["run", "log", "stamp-ns"])).toEqual({ stampNs: true, idleTimeout: false, logQuery: false });
		expect(abilitiesOf(["run", "log"])).toEqual({ stampNs: false, idleTimeout: false, logQuery: false });
	});

	test("the wrapper emits a newer flag only when told the build has it", () => {
		const base = { busybox: "/b/busybox", verbosity: "normal" as const, noEnv: true };
		expect(runPrefix(base).join(" ")).toBe("'/b/busybox' run --timestamps --max-bytes 24000");
		expect(runPrefix({ ...base, stampNs: true }).join(" ")).toBe("'/b/busybox' run --timestamps --stamp-ns --max-bytes 24000");
		expect(runPrefix({ ...base, idleSeconds: 30, timeoutSeconds: 120 }).join(" ")).toMatch(/--timeout 120 --idle-timeout 30$/);
		expect(runPrefix({ ...base, idleSeconds: 0 }).join(" ")).not.toMatch(/idle/);
		// Brief has no timeline, so it has no stamps to widen.
		expect(runPrefix({ ...base, verbosity: "brief", stampNs: true }).join(" ")).not.toMatch(/stamp-ns/);
	});

	test("the silence limit is 120s unless set, as pi has it, and 0 or off removes it", () => {
		expect(DEFAULT_IDLE_SECONDS).toBe(120);
		expect(readIdleSeconds({})).toBe(120);
		expect(readIdleSeconds({}, 45)).toBe(45);
		expect(readIdleSeconds({}, 0)).toBe(0);
		expect(readIdleSeconds({ CLAUDE_MANAGED_TOOLS_IDLE: "20" }, 45)).toBe(20);
		expect(readIdleSeconds({ CLAUDE_MANAGED_TOOLS_IDLE: "off" }, 45)).toBe(0);
		expect(readIdleSeconds({ CLAUDE_MANAGED_TOOLS_IDLE: "0" })).toBe(0);
		// A value that is not a setting at all falls back, never to "off" by accident.
		expect(readIdleSeconds({ CLAUDE_MANAGED_TOOLS_IDLE: "banana" }, 45)).toBe(45);
		expect(readIdleSeconds({ CLAUDE_MANAGED_TOOLS_IDLE: "banana" })).toBe(120);
		expect(readIdleSeconds({}, -3)).toBe(120);
	});
});

describe("nanosecond stamps", () => {
	const ns = [
		"run=R4561 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=1224",
		"timeline_lines=3 shown=3 truncated=false stamp=ns res_ns=41",
		"--- timeline ---",
		"[00000.006785709 out] a",
		"[00000.006808917 err] b",
		"[00001.214464084 err] late",
	].join("\n");

	test("land in the same microsecond unit as the older stamps", () => {
		const samples = parseTimeline(ns);
		expect(samples.map((sample) => sample.stream)).toEqual(["out", "err", "err"]);
		expect(samples[0]?.us).toBe(6785.709);
		expect(samples[2]?.us).toBe(1_214_464.084);
		expect(summarizeTiming(samples, 1224) ?? "").toMatch(/^timing: 1\.22s total, 3 lines, output from 0\.01s, stderr from 0\.01s, longest pause 1\.21s/);
	});

	test("two events in the same microsecond keep their order", () => {
		const [first, second] = parseTimeline(ns);
		expect((second?.us ?? 0) > (first?.us ?? 0)).toBe(true);
	});

	test("are decoration to the person, like the older ones", () => {
		expect(hasTimeline(ns)).toBe(true);
		expect(stripTimeline(ns)).toBe("a\nb\nlate");
	});

	test("a bracket that is not a stamp is left alone: no fraction, ten digits, another tag", () => {
		const own = "[12 out] no fraction\n[0.1234567890 out] ten digits\n[0.5 warn] another tag";
		expect(parseTimeline(own)).toEqual([]);
		expect(stripTimeline(own)).toBe(own);
	});
});

describe("compact stamps (0.6.1): unpadded seconds, fewer decimals as the offset grows", () => {
	// As `run --timestamps` (no `-n`) printed it from the v0.6.1 darwin-universal build:
	// six decimals below one second, about four significant figures after it.
	const us = [
		"run=R5327 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=1237",
		"timeline_lines=4 shown=4 truncated=false stamp=us res_ns=0",
		"--- timeline ---",
		"[0.007224 out] a",
		"[0.007252 err] b",
		"[0.115849 out] c",
		"[1.225 out] d",
	].join("\n");

	test("the fraction is a decimal fraction, however many digits it has left", () => {
		expect(parseTimeline(us).map((sample) => sample.us)).toEqual([7224, 7252, 115_849, 1_225_000]);
		// Past ten seconds that build printed two decimals; one is read the same way.
		expect(parseTimeline("[10.23 out] x\n[100.2 err] y").map((sample) => sample.us)).toEqual([10_230_000, 100_200_000]);
	});

	test("a trimmed line stays in the digest", () => {
		// Read as six-or-nine digits only, `[1.225 out]` dropped out and the pause with it.
		expect(summarizeTiming(parseTimeline(us), 1237)).toBe(
			"timing: 1.24s total, 4 lines, output from 0.01s, stderr from 0.01s, longest pause 1.11s (0.12s → 1.23s)",
		);
	});

	test("nanosecond stamps stay nine digits at any offset, unpadded", () => {
		// As `run --timestamps --stamp-ns` printed it: what the wrapper actually asks for.
		const ns = "[0.008471208 out] a\n[0.008513666 err] b\n[10.222315084 out] c";
		expect(parseTimeline(ns).map((sample) => sample.us)).toEqual([8471.208, 8513.666, 10_222_315.084]);
		expect(stripTimeline(ns)).toBe("a\nb\nc");
	});

	test("every shape is decoration to the person", () => {
		expect(hasTimeline(us)).toBe(true);
		expect(stripTimeline(us)).toBe("a\nb\nc\nd");
		// A command's own bracket after the stamp is the command's: only the stamp goes.
		expect(stripTimeline("[0.5 out] [1.5 out] kept")).toBe("[1.5 out] kept");
	});
});

describe("how a run ended, from its header alone", () => {
	const header = (fields: string) => `run=R9 ${fields} duration_ms=2025\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n[00000.005950 out] start`;

	test("silence is IDLE, with the seconds when they are known", () => {
		const idle = header("exit_code=-1 timed_out=false cancelled=false idle=true");
		expect(outcomeNotice(idle, 120, "/b/busybox", 2) ?? "").toMatch(/^IDLE — not a failure of the command and not its deadline: it printed nothing for 2s/);
		expect(outcomeNotice(idle) ?? "").toMatch(/printed nothing for the configured time/);
		expect(outcomeNotice(idle, 120, "/b/busybox", 2) ?? "").toMatch(/\/b\/busybox log R9 --stream timeline/);
		// A larger timeout is the reflex, and the one thing that cannot help.
		expect(outcomeNotice(idle, 120, "/b/busybox", 2) ?? "").toMatch(/a larger `timeout` will not help: make it report progress .* or run it with `run_in_background: true`/);
		expect(outcomeLine(idle)).toBe(
			"went silent · 2.02s — stopped for printing nothing, not a failure of the command (`/pi-time idle <seconds|off>` changes the limit)",
		);
	});

	test("silence on the person's own command names their switch", () => {
		const idle = header("exit_code=-1 timed_out=false cancelled=false idle=true");
		const theirs = outcomeNotice(idle, 120, "/b/busybox", 120, true) ?? "";
		expect(theirs).toMatch(/^IDLE — not a failure of the command and not its deadline: it printed nothing for 120s/);
		expect(theirs).toMatch(/The user ran this themselves\. If it was working quietly rather than stuck, `\/pi-time idle <seconds>` allows their commands a longer silence/);
		expect(theirs).not.toMatch(/run_in_background/);
	});

	test("a signal is still KILLED when the header has the idle field and it is false", () => {
		expect(outcomeNotice(header("exit_code=-1 timed_out=false cancelled=false idle=false")) ?? "").toMatch(/^KILLED/);
		expect(outcomeNotice(header("exit_code=-1 timed_out=false cancelled=false")) ?? "").toMatch(/^KILLED/);
	});

	test("a deadline wins over everything, and an ordinary exit gets nothing", () => {
		expect(outcomeNotice(header("exit_code=-1 timed_out=true cancelled=false idle=false")) ?? "").toMatch(/^TIMEOUT/);
		expect(outcomeNotice(header("exit_code=2 timed_out=false cancelled=false idle=false"))).toBe(undefined);
	});

	test("a deadline on the person's own command names their switch, not a call's timeout", () => {
		const text = header("exit_code=-1 timed_out=true cancelled=false idle=false").replace("duration_ms=2025", "duration_ms=120014");
		const theirs = outcomeNotice(text, 120, "/b/busybox", undefined, true) ?? "";
		expect(theirs).toMatch(/^TIMEOUT — not a failure of the command: it was still running when the 120s deadline fired/);
		expect(theirs).toMatch(/The user ran this themselves, so there is no `timeout` to raise on a call/);
		expect(theirs).toMatch(/`\/pi-time timeout <seconds>` gives their commands longer for this session \(`off` removes the deadline\)/);
		expect(theirs).not.toMatch(/run_in_background/);
		// A tool call's notice is unchanged.
		expect(outcomeNotice(text, 120, "/b/busybox") ?? "").toMatch(/Recovery: raise `timeout` on this call/);
		expect(outcomeLine(text)).toBe(
			"timed out · 120.01s — stopped at the deadline, not a failure of the command (`/pi-time timeout <seconds>` gives your commands longer)",
		);
	});

	test("a command that prints those words has not timed out", () => {
		const text = `${header("exit_code=0 timed_out=false cancelled=false idle=false")}\n[00000.006000 out] status: timed_out=true cancelled=true idle=true`;
		expect(outcomeNotice(text)).toBe(undefined);
	});
});

describe("what the model is told about this build", () => {
	const base = { busybox: "/b/busybox", verbosity: "normal", pty: "split", timeoutSeconds: 120, guard: true, carryCwd: true } as const;

	test("the example offsets are what a result shows, whatever shape the build printed", () => {
		// Every shape a release has had is respelled the same way before the model reads
		// it — unpadded, to the digits asked for — so the example is the same for each.
		for (const line of ["[   0.006244 out] pi-time-probe", "[00000.005868042 out] pi-time-probe", "[0.005868042 out] pi-time-probe"]) {
			expect(sectionText({ ...base, stamp: stampShape(line) })).toMatch(/`\[0\.012 out\] text`/);
			expect(sectionText({ ...base, stamp: stampShape(line), stampDigits: 6 })).toMatch(/`\[0\.012345 out\] text`/);
		}
		// A build that prints six digits cannot be shown with nine.
		expect(sectionText({ ...base, stamp: stampShape("[   0.006244 out] x"), stampDigits: 9 })).toMatch(/`\[0\.012345 out\] text`/);
		expect(sectionText({ ...base, stamp: stampShape("[0.005868042 out] x"), stampDigits: 9 })).toMatch(/`\[0\.012345678 out\] text`/);
		expect(sectionText(base)).not.toMatch(/zero-pads/);
	});

	test("the person's own commands are said to share the deadline, and how they lift it", () => {
		expect(sectionText({ ...base, bang: true })).toMatch(/runs with `!` or `\/sh` arrives in `<bash-stdout>` as the same timeline, under the same 120s deadline \(`\/pi-time timeout <seconds>` is theirs to raise\)/);
		expect(sectionText({ ...base, bang: false })).toMatch(/arrives as a timeline, under the same 120s deadline/);
		// With no default of ours there is no such deadline to describe.
		expect(sectionText({ ...base, bang: true, timeoutSeconds: 0 })).not.toMatch(/same \d+s deadline|pi-time timeout/);
	});

	test("IDLE is explained only while a silence limit is in force", () => {
		expect(sectionText(base)).not.toMatch(/IDLE/);
		expect(sectionText({ ...base, idleSeconds: 30 })).toMatch(/and a command that prints nothing for 30s is stopped whatever its `timeout`/);
		expect(sectionText({ ...base, idleSeconds: 30 })).toMatch(/opens with `TIMEOUT` or `IDLE` is that, not a failure of the command/);
		expect(sectionText({ ...base, idleSeconds: 30 })).toMatch(/after `IDLE`, find what it was blocked on or make a quiet command report progress/);
		// With no deadline of ours the silence limit is still said, as its own sentence.
		expect(sectionText({ ...base, timeoutSeconds: 0, idleSeconds: 30 })).toMatch(/\n\nA command that prints nothing for 30s is stopped whatever its `timeout`\. /);
	});

	test("the newer log queries are named only for a build that has them", () => {
		expect(sectionText(base)).not.toMatch(/--around-gap/);
		expect(sectionText({ ...base, logQuery: true })).toMatch(/\(or `--match STR`, `--stream stderr`, `--sample N`, `--since S --until S`, `--around-gap 1`\)/);
	});
});
