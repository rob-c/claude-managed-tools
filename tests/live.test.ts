/**
 * What can be known about a command while it runs: where its capture is, what it has
 * printed, and whether the processor is doing anything for it.
 */
import { describe, expect, test } from "claude-code/testing";
import { BUSY_SHARE, CpuMeter, cpuSentence, groupCpuSeconds, isBusy, isStuck, lifeLine, LIVE_PRELUDE, liveFile, LiveTail, parseCpuTime, parsePointer } from "../src/live";
import { outcomeNotice } from "../src/timing";
import { wrapCommand } from "../src/wrap";

describe("a command says where it is", () => {
	test("one line at its front writes its capture's folder and its own pid", () => {
		expect(LIVE_PRELUDE).toBe(`{ printf '%s\\n%s\\n' "$BUSYBOX_RUN_DIR" "$$" >"$PITIME_LIVE_FILE"; } 2>/dev/null; `);
		const wrapped = wrapCommand("make -j8", { busybox: "/b/busybox", shell: "/bin/zsh", verbosity: "normal", pty: "split", noEnv: true, report: true, liveFile: "/data dir/live/toolu_1" }) ?? "";
		// The file is named to the command's shell, and nothing else of the path is in the command.
		expect(wrapped).toMatch(/ --env 'PITIME_LIVE_FILE=\/data dir\/live\/toolu_1' /);
		// On the command's own first line, after stdin is taken off the terminal.
		expect(wrapped).toMatch(/-c 'exec <\/dev\/null; \{ printf '\\''%s\\n%s\\n'\\'' "\$BUSYBOX_RUN_DIR" "\$\$" >"\$PITIME_LIVE_FILE"; \} 2>\/dev\/null; trap /);
		expect(wrapped.split("\n")).toHaveLength(1);
		// And taken away by the same `rm` that tidies the rest, when the command ends.
		expect(wrapped).toMatch(/rm -f "\$__pt_f" "\$__pt_f\.f" '\/data dir\/live\/toolu_1'; \(exit "\$__pt_rc"\)$/);
		expect(wrapCommand("make", { busybox: "/b/busybox", shell: "/bin/zsh", verbosity: "normal", noEnv: true })).not.toMatch(/PITIME_LIVE_FILE/);
	});

	test("the file is the call's own", () => {
		expect(liveFile("/data/", "toolu_01AbC-9")).toBe("/data/live/toolu_01AbC-9");
		// Nothing of an id can climb out of the folder.
		expect(liveFile("/data", "../../etc/x y")).toBe("/data/live/______etc_x_y");
		expect(liveFile("/data", "")).toBe("/data/live/call");
	});

	test("what it wrote is believed only when both lines have the right shape", () => {
		expect(parsePointer("/var/T//busybox-run/R8039\n55946\n")).toEqual({ runDir: "/var/T//busybox-run/R8039", pgid: 55946 });
		// Half-written, empty (an older build has no BUSYBOX_RUN_DIR), or somewhere else.
		for (const text of ["", "/var/T/busybox-run/R1", "\n55946\n", "/tmp/elsewhere/R1\n55946\n", "/var/T/busybox-run/R1/../../x\n55946\n", "relative/busybox-run/R1\n5\n"]) {
			expect(parsePointer(text)).toBe(undefined);
		}
		// A group of 0 or 1 is this process's own group, or everything: never a target.
		for (const pid of ["0", "1", "-5", "12a", ""]) expect(parsePointer(`/var/T/busybox-run/R1\n${pid}\n`)).toBe(undefined);
	});
});

describe("the newest lines of a running command", () => {
	test("as a terminal would show them: line ends, carriage returns and all", () => {
		const tail = new LiveTail(3);
		tail.push("one\r\ntwo\r\nthr");
		// An unfinished line is shown as it stands: it may be the prompt the command waits at.
		expect(tail.shown()).toEqual(["one", "two", "thr"]);
		tail.push("ee\r\nfour\r\n");
		expect(tail.shown()).toEqual(["two", "three", "four"]);
		// A progress bar redrawn in place keeps only its last drawing.
		tail.push("10%\r50%\r100%\r\n");
		expect(tail.shown().at(-1)).toBe("100%");
		// Colour is taken out, and a very long line is cut.
		tail.push("\x1b[31mred\x1b[0m\n" + "x".repeat(400) + "\n");
		expect(tail.shown().at(-2)).toBe("red");
		expect(tail.shown().at(-1)?.length).toBe(160);
		expect(new LiveTail().shown()).toEqual([]);
	});
});

describe("the processor, read from ps", () => {
	test("a CPU time in either system's spelling", () => {
		expect(parseCpuTime("0:01.02")).toBe(1.02);
		expect(parseCpuTime("13:24.13")).toBe(804.13);
		expect(parseCpuTime("00:00:07")).toBe(7);
		expect(parseCpuTime("01:02:03")).toBe(3723);
		expect(parseCpuTime("1-02:03:04")).toBe(93784);
		expect(parseCpuTime("soon")).toBe(undefined);
	});

	test("a group's time is the sum of its processes, and unknown is not idle", () => {
		const ps = "    1  10:02.48\n55946   0:01.02\n55946   0:00.50\n  359   0:00.33\n";
		expect(groupCpuSeconds(ps, 55946)).toBe(1.52);
		// The group has ended, or `ps` printed something unreadable: no number, never zero.
		expect(groupCpuSeconds(ps, 4242)).toBe(undefined);
		expect(groupCpuSeconds("55946   ??\n", 55946)).toBe(undefined);
	});

	test("a rate needs two samples, and a stale one is no reading at all", () => {
		const meter = new CpuMeter();
		expect(meter.reading()).toBe(undefined);
		meter.sample(1.0, 1000);
		expect(meter.reading()).toBe(undefined);
		meter.sample(4.0, 4000);
		// What it had used before the first look counts too: the group is the command's own.
		expect(meter.reading()).toEqual({ total: 4, recentShare: 1, sinceOutput: 4 });
		// Output starts the silence, and its CPU, again.
		meter.sawOutput();
		meter.sample(4.03, 7000);
		expect(meter.reading(7000, 9000)?.sinceOutput.toFixed(2)).toBe("0.03");
		expect(isBusy(meter.reading())).toBe(true);
		// A child that exits takes its time off the sum: that is not negative work.
		meter.sample(2.0, 10_000);
		expect(meter.reading()?.recentShare).toBe(0);
		expect(isBusy(meter.reading())).toBe(false);
		// Not refreshed for too long: unknown, which is not the same as idle.
		expect(meter.reading(40_000, 9000)).toBe(undefined);
		expect(meter.since()).toBe(1000);
		// A sample that could not be taken changes nothing.
		meter.sample(undefined, 50_000);
		expect(meter.reading()?.total.toFixed(2)).toBe("4.03");
	});
});

describe("stuck is no sign of life: neither a line nor the processor", () => {
	const idleMs = 120_000;
	const cpu = (sinceOutput: number) => ({ total: sinceOutput, recentShare: 0, sinceOutput });

	test("silence alone no longer decides", () => {
		// Two minutes of nothing printed, and most of two minutes of processor: a compiler.
		expect(isStuck({ silentMs: 121_000, idleMs, cpu: cpu(118), cpuWatchedMs: 119_000 })).toBe(false);
		// The same silence with no processor time: a hang.
		expect(isStuck({ silentMs: 121_000, idleMs, cpu: cpu(0.02), cpuWatchedMs: 119_000 })).toBe(true);
		// Not yet at the limit: neither.
		expect(isStuck({ silentMs: 60_000, idleMs, cpu: cpu(0), cpuWatchedMs: 58_000 })).toBe(false);
	});

	test("the line between them is a hundredth of a processor over the silence", () => {
		expect(BUSY_SHARE).toBe(0.01);
		expect(isStuck({ silentMs: 120_000, idleMs, cpu: cpu(1.19), cpuWatchedMs: 120_000 })).toBe(true);
		expect(isStuck({ silentMs: 120_000, idleMs, cpu: cpu(1.2), cpuWatchedMs: 120_000 })).toBe(false);
	});

	test("where the processor could not be read, silence decides as it did before", () => {
		expect(isStuck({ silentMs: 121_000, idleMs, cpu: undefined, cpuWatchedMs: 0 })).toBe(true);
		// Samples that cover too little of the silence are not evidence about it.
		expect(isStuck({ silentMs: 121_000, idleMs, cpu: cpu(0), cpuWatchedMs: 30_000 })).toBe(true);
		// And with no limit there is nothing to be stuck against.
		expect(isStuck({ silentMs: 900_000, idleMs: 0, cpu: cpu(0), cpuWatchedMs: 900_000 })).toBe(false);
	});
});

describe("the sign of life a person reads under a running command", () => {
	test("how long, how long since it spoke, and what the processor is doing", () => {
		expect(lifeLine({ elapsedMs: 47_000, silentMs: 31_000, hasOutput: true, cpu: { total: 30, recentShare: 0.98, sinceOutput: 30 } })).toBe(
			"running 47s · last output 31s ago · CPU busy (98% of a processor): working",
		);
		// Several processors' worth is said as it is.
		expect(lifeLine({ elapsedMs: 125_000, silentMs: 1000, hasOutput: true, cpu: { total: 400, recentShare: 3.8, sinceOutput: 2 } })).toBe("running 2m05s · CPU busy (380% of a processor): working");
		expect(lifeLine({ elapsedMs: 9000, silentMs: 9000, hasOutput: false, cpu: { total: 0, recentShare: 0, sinceOutput: 0 } })).toBe("running 9s · no output yet · CPU idle: waiting on something");
	});

	test("an idle command is told how long it has before it is taken to be stuck", () => {
		const line = lifeLine({ elapsedMs: 80_000, silentMs: 75_000, hasOutput: true, cpu: { total: 0.1, recentShare: 0, sinceOutput: 0 }, idleMs: 120_000 });
		expect(line).toBe("running 1m20s · last output 1m15s ago · CPU idle: waiting on something (stopped as stuck in 45s if it stays so)");
	});

	test("with no reading it says nothing about the processor rather than guess", () => {
		expect(lifeLine({ elapsedMs: 4000, silentMs: 500, hasOutput: true, cpu: undefined })).toBe("running 4s");
	});
});

describe("what the processor adds to a result, for the model", () => {
	const timedOut = "Exit code 3\nrun=R14 exit_code=-1 timed_out=true cancelled=false idle=false duration_ms=120019\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n[0.010000000 out] starting";

	test("a deadline says whether more time would have helped", () => {
		const working = cpuSentence({ total: 117.3, recentShare: 0.99, sinceOutput: 117 }, 120.019);
		expect(working).toBe("CPU: it used 117.3s of processor time in 120s and was still computing when it was stopped, so it was working, not stuck: more time (or `run_in_background`) is what it needs.");
		const waiting = cpuSentence({ total: 0.2, recentShare: 0, sinceOutput: 0 }, 120.019);
		expect(waiting).toBe("CPU: it used 0.2s of processor time in 120s and none at the end, so it was waiting on something, not computing: more time alone will not help.");
		expect(cpuSentence(undefined, 120)).toBe(undefined);
		const notice = outcomeNotice(timedOut, 120, "/b/busybox", 120, false, false, { cpu: working }) ?? "";
		expect(notice.split("\n")[3]).toBe(working);
		// Unwatched, the notice is what it was.
		expect(outcomeNotice(timedOut, 120, "/b/busybox", 120)).not.toMatch(/CPU:/);
	});

	test("a command stopped for showing no sign of life is IDLE, whatever its own header says", () => {
		// The hooks module ended its group, so the run reports a signal and the host exit 1.
		const killed = "Exit code 1\nrun=R15 exit_code=-1 timed_out=false cancelled=false idle=false duration_ms=121800\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n[0.010000000 out] Password:";
		const notice = outcomeNotice(killed, 600, "/b/busybox", 120, false, false, { stuck: { seconds: 121, cpuSeconds: 0.04 } }) ?? "";
		expect(notice).toMatch(/^IDLE — not a failure of the command and not its deadline: for 121s it printed nothing and used no processor time to speak of \(0\.0s\), so it was waiting, not working, and was stopped as stuck\./);
		expect(notice).toMatch(/and the "Exit code 1" line are the kill status/);
		expect(notice).toMatch(/A larger `timeout` will not help a command that is waiting/);
		expect(notice).not.toMatch(/KILLED|If it was working quietly/);
		// Without that, the same header is a signal.
		expect(outcomeNotice(killed, 600, "/b/busybox", 120)).toMatch(/^KILLED/);
	});
});
