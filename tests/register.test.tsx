/**
 * The hooks themselves, against the engine: what is re-issued, what is passed on
 * untouched, and what the model reads back.
 *
 * Nothing sits beneath the plugin here, so each `on` in a test stands for the engine.
 * The one `tool.run` hook is Bash itself, and `next.origin` says whose call reached it:
 * the plugin's own (its re-issued, wrapped call) or the model's, as written.
 */
import { expect, mock, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";

const BUSYBOX = "/home/t/.pi/agent/bin/busybox";
/** Where `run` keeps its captures in this world: `$TMPDIR/busybox-run`. */
const RUN_ROOT = "/tmp/t/busybox-run";
const CAPS = JSON.stringify({ schema: 1, version: "1.39.0.git", features: ["peek", "run", "log", "json"] });

const OK = [
	"run=R12 exit_code=0 timed_out=false cancelled=false duration_ms=8421",
	"timeline_lines=3 shown=3 truncated=false",
	"--- timeline ---",
	"[   0.020000 out] collecting",
	"[   2.320000 out] collected",
	"[   8.421000 err] warning: slow",
	"pruned=0 keep=20",
].join("\n");

interface World {
	/** Calls the plugin re-issued, as the engine's Bash would receive them. */
	issued: Array<Record<string, unknown>>;
	/** Calls that reached the tool as the model wrote them. */
	passed: Array<Record<string, unknown>>;
	written: string[];
	/** What was written, by path: the last text for each. */
	files: Record<string, string>;
	/** Variables the plugin set for the process. */
	setEnv: Record<string, string | undefined>;
	/** Every command the plugin ran on the host itself, by argument vector. */
	ran: string[][];
}

interface WorldOptions {
	env?: Record<string, string>;
	/** False: no busybox anywhere. */
	hasBusybox?: boolean;
	/** What the re-issued call answers. */
	inner?: () => unknown;
	/** The session's id as a launched shell would read it; absent, there is no shim. */
	sid?: string;
	/** Features the busybox adds to the older build's list. */
	features?: string[];
	/** What `uname -s` answers; absent, it cannot be asked. */
	uname?: string;
	/** Paths that exist besides the two shells. */
	exists?: string[];
	/** The plugin's data folder (default `/data`). */
	data?: string;
	/** What the self-test's stderr says; set, the wrapped `echo` fails with it. */
	probeFails?: string;
	/** Run folders in the artifact root, newest first, with each one's age in minutes. */
	runs?: Array<[name: string, ageMinutes: number]>;
	/** What `busybox log <run> --summary` answers. */
	summary?: string;
	/** Files a test puts on disk and changes as it goes: read, and sized, as they stand. */
	disk?: Record<string, string>;
	/** What `ps -A -o pgid=,time=` prints, each time it is asked. */
	ps?: () => string;
}

/**
 * What the build's self-test prints: a header and one stamped line, in the shape that
 * build has — nine unpadded digits where it was asked for them, six padded where not.
 */
function probeOutput(argv: readonly string[]): string {
	const isNs = argv.includes("--stamp-ns");
	return [
		`run=R1 exit_code=0 timed_out=false cancelled=false ${argv.includes("--idle-timeout") ? "idle=false " : ""}duration_ms=4`,
		"timeline_lines=1 shown=1 truncated=false",
		"--- timeline ---",
		`${isNs ? "[0.004211000 out]" : "[   0.004211 out]"} pi-time-probe`,
		"",
	].join("\n");
}

/** The machine beneath the plugin: an environment, one busybox, and a Bash that answers. */
function world(on: On, options: WorldOptions = {}): World {
	const seen: World = { issued: [], passed: [], written: [], files: {}, setEnv: {}, ran: [] };
	const runs = new Map(options.runs ?? []);
	mock.env(on, { HOME: "/home/t", SHELL: "/bin/zsh", TMPDIR: "/tmp/t/", ...(options.env ?? {}) });
	on("process.hookEnv", () => ({
		value: { CLAUDE_PLUGIN_DATA: options.data ?? "/data", ...(options.sid ? { CLAUDE_CODE_SESSION_ID: options.sid } : {}) },
	}));
	on("env.set", (_, e) => {
		seen.setEnv[e.name] = e.value;
		return { value: {} };
	});
	on("fs.read", (_, e) => {
		const text = options.disk?.[e.path];
		if (text === undefined) return { deny: "ENOENT" };
		return { value: e.offset === undefined ? text : text.slice(e.offset, e.offset + (e.length ?? text.length)) } as never;
	});
	on("command.register", (_, e) => ({ value: { command: e.name } }));
	on("fs.exists", (_, e) => ({ value: e.path === "/bin/zsh" || e.path === "/bin/bash" || (options.exists ?? []).includes(e.path) }));
	on("fs.write", (_, e) => {
		seen.written.push(e.path);
		seen.files[e.path] = e.text;
		return { value: undefined };
	});
	on("fs.stat", (_, e) => {
		if (options.hasBusybox !== false && e.path === BUSYBOX) return { value: { kind: "file" as const, size: 1_800_000, mtimeMs: 0, isLink: false } };
		const onDisk = options.disk?.[e.path];
		if (onDisk !== undefined) return { value: { kind: "file" as const, size: onDisk.length, mtimeMs: 0, isLink: false } };
		const age = runs.get(e.path.slice(e.path.lastIndexOf("/") + 1));
		if (age !== undefined && e.path.startsWith(`${RUN_ROOT}/`)) {
			return { value: { kind: "dir" as const, size: 0, mtimeMs: Date.now() - age * 60_000, isLink: false } };
		}
		return { deny: "ENOENT" };
	});
	on("process.run", (_, e) => {
		const argv = [...e.argv];
		seen.ran.push(argv);
		const done = (stdout = "", exitCode = 0, stderr = "") => ({ value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false } });
		if (argv[1] === "--caps") {
			return done(options.features ? JSON.stringify({ schema: 1, version: "1.39.0.git", features: ["peek", "run", "log", "json", ...options.features] }) : CAPS);
		}
		// The self-test: one wrapped `echo`, answered in the shape this build prints.
		if (argv[1] === "run" && argv[argv.length - 1] === "echo pi-time-probe") {
			return options.probeFails === undefined ? done(probeOutput(argv)) : done("", 1, options.probeFails);
		}
		if (argv[1] === "log" && argv.includes("--summary") && options.summary !== undefined) return done(options.summary);
		if (argv[0] === "ls" && argv[2] === RUN_ROOT && options.runs) return done(`${[...runs.keys()].join("\n")}\n`);
		if (argv[0] === "ps" && options.ps) return done(options.ps());
		if (argv[0] === "chmod" || argv[0] === "rm" || argv[0] === "kill") return done();
		if (argv[0] === "uname" && options.uname !== undefined) return done(`${options.uname}\n`);
		// Anything else here is a command that failed.
		return done("", 1);
	});
	on("tool.run", (_, e, next) => {
		if (next.origin.plugin !== "managed-tools") {
			seen.passed.push({ ...e });
			return { result: { stdout: "as written", stderr: "", interrupted: false } } as never;
		}
		seen.issued.push({ ...e });
		return (options.inner?.() ?? { result: { stdout: OK, stderr: "", interrupted: false } }) as never;
	});
	return seen;
}

/** `/pi-time <args>` as the person types it; the kit's own fields are the engine's to set. */
function slash($: Engine, args?: string): Promise<{ text?: string }> {
	return $.command.run({ command: "pi-time", ...(args === undefined ? {} : { args }) } as never);
}

function stdoutOf(ran: { result?: unknown }): string {
	return (ran.result as { stdout: string }).stdout;
}

test("an allowed call is re-issued inside the wrapper, and the original never runs", async ($, on) => {
	const seen = world(on);
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "npm test", description: "Run tests" });

	expect(seen.passed).toHaveLength(0);
	expect(seen.issued).toHaveLength(1);
	const issued = seen.issued[0] as { command: string; timeout: number; description: string };
	expect(issued.command).toMatch(/'\/home\/t\/\.pi\/agent\/bin\/busybox' run --timestamps --max-bytes 24000 --pty-split --pty-size 200x50 --timeout 120 /);
	// No run prunes the captures: the root is shared by every session on the machine.
	expect(issued.command).not.toMatch(/--prune/);
	// The child keeps the person's shell; the prelude shares the command's first line, so
	// the shell's own line numbers in error messages stay the command's.
	expect(issued.command).toMatch(/-- '\/bin\/zsh' -c 'exec <\/dev\/null; trap [^\n]+ EXIT; npm test'/);
	// The applet owns the deadline; the host is given a grace past it.
	expect(issued.timeout).toBe(125_000);
	expect(issued.description).toBe("Run tests");

	// The model reads the timeline, the digest, and no housekeeping: a header with only
	// what says something, each offset to the millisecond, the notes after their marker.
	const stdout = stdoutOf(ran);
	expect(stdout).toMatch(/^run=R12 exit_code=0 duration_ms=8421\n\[0\.020 out\] collecting\n\[2\.320 out\] collected\n\[8\.421 err\] warning: slow\n--- pi-time ---\ntiming: 8\.42s total, 3 lines, output from 0\.02s, stderr from 8\.42s, longest pause 6\.10s/);
	expect(stdout).not.toMatch(/timed_out=false|timeline_lines=|--- timeline ---/);
	expect(stdout).not.toMatch(/pruned=/);
});

test("a caller's timeout is taken over a second early and the host keeps its own", async ($, on) => {
	const seen = world(on);
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make", timeout: 30_000 });
	const issued = seen.issued[0] as { command: string; timeout: number };
	expect(issued.command).toMatch(/--timeout 29 /);
	expect(issued.timeout).toBe(30_000);
});

test("a failed command stays a failure, with the host's own text and Pi-Time's notes", async ($, on) => {
	const text = "Exit code 1\nrun=R13 exit_code=1 timed_out=false cancelled=false duration_ms=40\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n[   0.030000 err] no such file\npruned=0 keep=20";
	world(on, { inner: () => ({ isError: true, result: text, text }) });
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "ls missing | head -3" });
	expect(ran.result).toBe(undefined);
	expect(ran.deny).toMatch(/^Exit code 1\nrun=R13 exit_code=1/);
	expect(ran.deny).toMatch(/\n\[0\.030 err\] no such file\n--- pi-time ---\n/);
	// What the command hid from its own result is stated after it.
	expect(ran.deny).toMatch(/pipeline ends in `head`: the exit_code shown is `head`'s/);
	expect(ran.deny).not.toMatch(/pruned=/);
});

test("a deadline comes back as a named TIMEOUT with the way to read the capture", async ($, on) => {
	const text = "Exit code 3\nrun=R14 exit_code=-1 timed_out=true cancelled=false duration_ms=120019\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n[   0.010000 out] starting";
	world(on, { inner: () => ({ isError: true, result: text, text }) });
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "sleep 600" });
	// How it ended comes first, before the host's "Exit code 3" and before any output:
	// a timeout used to open with `exit_code=-1` and only say at the very end that nothing had failed.
	expect(ran.deny).toMatch(/^TIMEOUT — not a failure of the command: it was still running when the 120s deadline fired/);
	expect(ran.deny).toMatch(/\nExit code 3\nrun=R14 exit_code=-1 timed_out=true/);
	expect(ran.deny).toMatch(/\/home\/t\/\.pi\/agent\/bin\/busybox log R14 --stream timeline --lines 1:40/);
});

test("a truncated view names the command that reads the rest", async ($, on) => {
	const stdout = "run=R15 exit_code=0 timed_out=false cancelled=false duration_ms=25\ntimeline_lines=3000 shown=547 truncated=true\n--- timeline ---\n[   0.009921 out] line 1";
	world(on, { inner: () => ({ result: { stdout, stderr: "", interrupted: false } }) });
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "seq 3000" });
	expect(stdoutOf(ran)).toMatch(/\ntruncated: 547 of 3000 lines shown, head only .* \/home\/t\/\.pi\/agent\/bin\/busybox log R15 --stream timeline --lines 2960:3000/);
});

test("a backgrounded command is passed on untouched", async ($, on) => {
	const seen = world(on);
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "npm run dev", run_in_background: true });
	expect(seen.issued).toHaveLength(0);
	expect(seen.passed).toHaveLength(1);
	expect(seen.passed[0]?.command).toBe("npm run dev");
	expect(stdoutOf(ran)).toBe("as written");
});

test("switched off in the options, Bash runs exactly as written", { options: { enabled: false } }, async ($, on) => {
	const seen = world(on);
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "npm test" });
	expect(seen.issued).toHaveLength(0);
	expect(seen.passed[0]?.command).toBe("npm test");
});

test("switched off in the environment, over options that say on", async ($, on) => {
	const seen = world(on, { env: { CLAUDE_MANAGED_TOOLS_WRAP: "off" } });
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "npm test" });
	expect(seen.issued).toHaveLength(0);
	expect(seen.passed).toHaveLength(1);
});

test("with no busybox that can wrap, nothing is wrapped and nothing is refused", async ($, on) => {
	const seen = world(on, { hasBusybox: false });
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "npm test" });
	const guarded = await $.tool.call({ tool: "Bash", command: "make 2>&1 | tail -5" });
	expect(seen.issued).toHaveLength(0);
	expect(seen.passed.map((call) => call.command)).toEqual(["npm test", "make 2>&1 | tail -5"]);
	// The guard protects a stream tag; with no wrapper there is no tag, so no refusal.
	expect(guarded.deny).toBe(undefined);
});

test("the `# pitime-raw` escape runs unwrapped, and its note rides beside the bytes, not in them", async ($, on) => {
	const seen = world(on);
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "sha256sum dist.tgz # pitime-raw" });
	expect(seen.issued).toHaveLength(0);
	expect(seen.passed).toHaveLength(1);
	expect(stdoutOf(ran)).toBe("as written");
	expect(ran.context?.join("\n")).toMatch(/ran unwrapped \(`# pitime-raw`\)/);
});

test("a direct busybox call is not wrapped a second time", async ($, on) => {
	const seen = world(on);
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: `${BUSYBOX} log R12 --stream stderr` });
	expect(seen.issued).toHaveLength(0);
	expect(seen.passed).toHaveLength(1);
});

test("the options reach the wrapper: view, terminal, deadline, cd", { options: { verbosity: "quiet", pty: "off", timeoutSeconds: 0, carryCwd: false } }, async ($, on) => {
	const seen = world(on);
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "cd build && make" });
	const issued = seen.issued[0] as { command: string; timeout?: number };
	expect(issued.command).toMatch(/--max-bytes 6000 /);
	expect(issued.command).not.toMatch(/--pty/);
	// No default of ours: the host's own 120s applies, pre-empted by a second.
	expect(issued.command).toMatch(/--timeout 119 /);
	expect(issued.timeout).toBe(undefined);
	// No carry: nothing leaves its directory behind and the outer shell never moves. The
	// trap that is left reports how the command ended, and only that.
	expect(issued.command).not.toMatch(/PITIME_CWD_FILE|cd -- /);
	expect(issued.command).toMatch(/trap '\\''\{ __pt_ps="\$\{pipestatus\[\*\]\}"; \} 2>\/dev\/null; printf [^\n]* >"\$PITIME_FACTS_FILE" 2>\/dev\/null'\\'' EXIT; cd build && make'/);
});

test("without the carry, a cd is named as call-local on the result", { options: { carryCwd: false } }, async ($, on) => {
	world(on);
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "cd build && make" });
	expect(stdoutOf(ran)).toMatch(/`cd` affects this call only/);
});

test("a sandbox that refuses a terminal gets the same command on plain pipes, once", async ($, on) => {
	const refusal = "Exit code 2\nrun: cannot allocate a pty: Operation not permitted";
	let answers = 0;
	const seen = world(on, {
		inner: () => (answers++ === 0 ? { isError: true, result: refusal, text: refusal } : undefined),
	});
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "npm test" });
	// Asked for a terminal, was refused before the command started, asked again without.
	expect(seen.issued).toHaveLength(2);
	expect(seen.issued[0]?.command).toMatch(/--pty-split/);
	expect(seen.issued[1]?.command).not.toMatch(/--pty/);
	expect(seen.passed).toHaveLength(0);
	expect(stdoutOf(ran)).toMatch(/\[0\.020 out\] collecting/);

	// The rest of the session does not pay for the failed attempt again…
	await $.tool.run({ tool: "Bash", tool_use_id: "t2", command: "npm test" });
	expect(seen.issued).toHaveLength(3);
	expect(seen.issued[2]?.command).not.toMatch(/--pty/);
	// …except a call that leaves the sandbox, where a terminal is still to be had.
	await $.tool.run({ tool: "Bash", tool_use_id: "t3", command: "npm test", dangerouslyDisableSandbox: true });
	expect(seen.issued[3]?.command).toMatch(/--pty-split/);
	expect((await slash($, "status")).text).toMatch(/the sandbox refuses a pseudo-terminal/);
});

test("a refused re-issue is reported, and the command is not run a second way", async ($, on) => {
	const seen = world(on);
	// Another hook's verdict on the wrapped spelling: refused before anything runs.
	on("tool.check", (_, e, next) =>
		next.origin.plugin === "managed-tools"
			? { decision: "deny" as const, reason: "blocked by policy hook" }
			: { decision: "allow" as const },
	);
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "git push" });
	expect(seen.issued).toHaveLength(0);
	expect(seen.passed).toHaveLength(0);
	expect(ran.deny).toMatch(/could not run this command wrapped: the re-issued call was refused \(blocked by policy hook\)/);
	expect(ran.deny).toMatch(/End the command with `# pitime-raw`/);
});

test("a failure after the command started never runs it again", async ($, on) => {
	const seen = world(on, {
		inner: () => {
			throw new Error("the host went away");
		},
	});
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "git push" });
	// The dangerous outcome is the engine running `git push` itself after the hook failed.
	expect(seen.passed).toHaveLength(0);
	expect(ran.deny).toMatch(/failed after this command was started/);
});

test("the guard refuses a tail merge before the permission check, and says how to rewrite", async ($, on) => {
	const seen = world(on);
	const ran = await $.tool.call({ tool: "Bash", command: "make 2>&1 | tail -5" });
	expect(seen.issued).toHaveLength(0);
	expect(ran.deny).toMatch(/^Blocked before running: `2>&1` at the command's tail/);
	expect(ran.deny).toMatch(/\/home\/t\/\.pi\/agent\/bin\/busybox log <R> --stream stderr/);
});

test("the guard lets a declared merge, a background call and an ordinary command through", async ($, on) => {
	const seen = world(on);
	expect((await $.tool.call({ tool: "Bash", command: "make 2>&1 | tail -5 # pitime-safe" })).deny).toBe(undefined);
	expect((await $.tool.call({ tool: "Bash", command: "srv >log 2>&1", run_in_background: true })).deny).toBe(undefined);
	expect((await $.tool.call({ tool: "Bash", command: "make" })).deny).toBe(undefined);
	// Two were wrapped on their way through; the backgrounded one ran as written.
	expect(seen.issued).toHaveLength(2);
	expect(seen.passed.map((call) => call.command)).toEqual(["srv >log 2>&1"]);
});

test("the guard can be switched off", { options: { guard: false } }, async ($, on) => {
	world(on);
	expect((await $.tool.call({ tool: "Bash", command: "make 2>&1 | tail -5" })).deny).toBe(undefined);
});

test("the model is told about the timeline only while it is on", async ($, on) => {
	world(on);
	on("prompt.compose", () => ({ sections: [{ id: "intro", text: "You are Claude.", scope: "shared" as const }] }));
	const base = { model: "m", promptModel: "m", surfaces: [], outputStyle: null, traits: [] };
	const composed = await $.prompt.compose({ ...base, tools: ["Bash", "Read"] });
	expect(composed.sections.map((section) => section.id)).toEqual(["intro", "managed-tools:pi-time"]);
	const section = composed.sections[1];
	expect(section?.scope).toBe("session");
	expect(section?.text).toMatch(/# Pi-Time: every Bash result is a timeline/);
	expect(section?.text).toMatch(/\/home\/t\/\.pi\/agent\/bin\/busybox log R12/);
	// No Bash, no claim.
	expect((await $.prompt.compose({ ...base, tools: ["Read"] })).sections).toHaveLength(1);
});

test("the model is told nothing when the wrapper is off", { options: { enabled: false } }, async ($, on) => {
	world(on);
	on("prompt.compose", () => ({ sections: [{ id: "intro", text: "You are Claude.", scope: "shared" as const }] }));
	const composed = await $.prompt.compose({ model: "m", promptModel: "m", surfaces: [], outputStyle: null, traits: [], tools: ["Bash"] });
	expect(composed.sections).toHaveLength(1);
});

test("/pi-time reports the state and switches it for the session", async ($, on) => {
	const seen = world(on);
	const status = await slash($, "status");
	expect(status.text).toMatch(/Pi-Time is \*\*on\*\*/);
	// pi's copy: in use, and said not to be the one this plugin keeps current.
	expect(status.text).toMatch(/busybox: `\/home\/t\/\.pi\/agent\/bin\/busybox` \(not this plugin's own copy, busybox 1\.39\.0\.git\)/);
	// An older build's feature list: nothing newer is asked of it.
	expect(status.text).toMatch(/this build: microsecond offsets, no idle timeout, basic log only/);
	expect(status.text).toMatch(/view: normal — timeline, 24 KB view/);

	expect((await slash($, "verbosity shouty")).text).toMatch(/Usage/);
	await slash($, "verbosity quiet");
	await slash($, "pty off");
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	expect(seen.issued[0]?.command).toMatch(/--max-bytes 6000 /);
	expect(seen.issued[0]?.command).not.toMatch(/--pty/);

	expect((await slash($, "off")).text).toMatch(/Pi-Time is \*\*off\*\*/);
	await $.tool.run({ tool: "Bash", tool_use_id: "t2", command: "make" });
	expect(seen.passed).toHaveLength(1);
});

test("/pi-time says where it looked when there is nothing to wrap with", async ($, on) => {
	world(on, { hasBusybox: false });
	const status = await slash($);
	expect(status.text).toMatch(/not wrapping/);
	expect(status.text).toMatch(/looked in `\/data\/bin\/busybox`, `\/home\/t\/\.pi\/agent\/bin\/busybox`/);
	expect(status.text).toMatch(/\/pi-time install/);
});

const RESULT_ROW = { plugin: "managed-tools", component: "ToolResult", requestId: "t1" } as const;

test("on screen a result is the command's own lines; the stored result keeps the timeline", async ($, on) => {
	world(on);
	let drawnFrom: unknown;
	on("ui.render", ($, e) => {
		drawnFrom = (e.props as { output?: unknown }).output;
		const { Text } = $.ui.resolve(e);
		return (<Text>engine</Text>) as never;
	});
	const output = { stdout: `${OK}\ntiming: 8.42s total`, stderr: "", interrupted: false };
	for (const surface of ["terminal", "desktop"] as const) {
		const ui = await $.ui.mount({
			...RESULT_ROW,
			surface,
			props: { tool_use_id: "t1", tool: "Bash", output, isErrored: false },
		});
		// The engine's own renderer is handed the cleaned text…
		expect(drawnFrom).toEqual({ stdout: "collecting\ncollected\nwarning: slow", stderr: "", interrupted: false });
		await ui.unmount();
	}
	// …and what was stored is not touched.
	expect(output.stdout).toMatch(/\[ {3}0\.020000 out\] collecting/);
});

test("on screen a failed command reads as its error, without the wrapper's header", async ($, on) => {
	world(on);
	const output = "Exit code 4\nrun=R3104 exit_code=4 timed_out=false cancelled=false duration_ms=7\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n[   0.007410 out] before";
	for (const surface of ["terminal", "desktop"] as const) {
		const ui = await $.ui.mount({
			...RESULT_ROW,
			surface,
			props: { tool_use_id: "t1", tool: "Bash", output, isErrored: true },
		});
		expect((await ui.find({ type: "Text", text: /Exit code 4/ }))?.text).toBe("Error: Exit code 4\nbefore");
		await ui.unmount();
		// The transcript's own text already leads with "Error: "; it is said once.
		const prefixed = await $.ui.mount({
			...RESULT_ROW,
			surface,
			props: { tool_use_id: "t1", tool: "Bash", output: `Error: ${output}`, isErrored: true },
		});
		expect((await prefixed.find({ type: "Text", text: /Exit code 4/ }))?.text).toBe("Error: Exit code 4\nbefore");
		await prefixed.unmount();
	}
});

test("a long failure is folded on screen and whole when expanded", async ($, on) => {
	world(on);
	const lines = Array.from({ length: 30 }, (_, index) => `[   0.0${String(index).padStart(2, "0")}000 err] line ${index + 1}`);
	const output = ["Exit code 1", "run=R1 exit_code=1 timed_out=false cancelled=false duration_ms=40", "--- timeline ---", ...lines].join("\n");
	const props = { tool_use_id: "t1", tool: "Bash", output, isErrored: true };
	const folded = await $.ui.mount({ ...RESULT_ROW, surface: "terminal", props });
	const foldedText = (await folded.find({ type: "Text", text: /Exit code 1/ }))?.text ?? "";
	expect(foldedText.split("\n")).toHaveLength(11);
	expect(foldedText).toMatch(/\n… \+21 lines$/);
	await folded.unmount();
	const whole = await $.ui.mount({ ...RESULT_ROW, surface: "terminal", props: { ...props, isExpanded: true } });
	expect(((await whole.find({ type: "Text", text: /Exit code 1/ }))?.text ?? "").split("\n")).toHaveLength(31);
	await whole.unmount();
});

test("rows that are not a wrapped Bash result are the engine's to draw", { options: { cleanDisplay: false } }, async ($, on) => {
	world(on);
	let drawnFrom: unknown;
	on("ui.render", ($, e) => {
		drawnFrom = (e.props as { output?: unknown }).output;
		const { Text } = $.ui.resolve(e);
		return (<Text>engine</Text>) as never;
	});
	const output = { stdout: OK, stderr: "", interrupted: false };
	const ui = await $.ui.mount({ ...RESULT_ROW, surface: "terminal", props: { tool_use_id: "t1", tool: "Bash", output, isErrored: false } });
	// Switched off, the person sees exactly what the model reads.
	expect(drawnFrom).toEqual(output);
	await ui.unmount();
});

test("/sh runs the person's command through the capture and splits the two readers", async ($, on) => {
	const seen = world(on);
	const ran = (await $.command.run({ command: "sh", args: "make test", origin: { kind: "composer" } } as never)) as { text?: string; context?: readonly string[]; isTextDisplayOnly?: boolean };
	expect(seen.issued).toHaveLength(1);
	const issued = seen.issued[0] as { command: string; timeout: number };
	expect(issued.command).toMatch(/busybox' run --timestamps .* -c 'exec <\/dev\/null; trap [^\n]+ EXIT; make test'/);
	// The person's own command gets the default deadline too, the applet's ahead of the host's.
	expect(issued.command).toMatch(/--timeout 120 /);
	expect(issued.timeout).toBe(125_000);
	// The person sees the command's lines; the model reads the timeline and the digest.
	expect(ran.text).toBe("exit 0 · 8.42s\n```\ncollecting\ncollected\nwarning: slow\n```");
	expect(ran.isTextDisplayOnly).toBe(true);
	const context = ran.context?.join("\n") ?? "";
	expect(context).toMatch(/<bash-input>make test<\/bash-input>/);
	expect(context).toMatch(/\[8\.421 err\] warning: slow/);
	expect(context).toMatch(/\ntiming: 8\.42s total/);
	expect(context).not.toMatch(/pruned=/);
});

test("/sh with the default deadline off runs to the longest the host allows", { options: { timeoutSeconds: 0 } }, async ($, on) => {
	const seen = world(on);
	await $.command.run({ command: "sh", args: "make test", origin: { kind: "composer" } } as never);
	const issued = seen.issued[0] as { command: string; timeout: number };
	expect(issued.command).toMatch(/--timeout 599 /);
	expect(issued.timeout).toBe(600_000);
});

test("/sh stopped at the deadline tells both readers whose switch it is", async ($, on) => {
	const text = "Exit code 3\nrun=R14 exit_code=-1 timed_out=true cancelled=false idle=false duration_ms=120019\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n[0.01 out] starting";
	world(on, { inner: () => ({ isError: true, result: text, text }) });
	const ran = (await $.command.run({ command: "sh", args: "npm run dev", origin: { kind: "composer" } } as never)) as { text?: string; context?: readonly string[] };
	expect(ran.text).toMatch(/^timed out · 120\.02s — stopped at the deadline, not a failure of the command \(`\/pi-time timeout <seconds>` gives your commands longer\)\n```\nstarting\n```$/);
	const context = ran.context?.join("\n") ?? "";
	expect(context).toMatch(/\nTIMEOUT — not a failure of the command: it was still running when the 120s deadline fired/);
	expect(context).toMatch(/The user ran this themselves, so there is no `timeout` to raise on a call/);
	expect(context).not.toMatch(/Recovery: raise `timeout`/);
});

test("/pi-time timeout sets the default deadline for the session, for every kind of command", async ($, on) => {
	const seen = world(on, { sid: "S1" });
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });
	// The `!` shim starts with the default, the applet's own flag and no host deadline.
	const conf = () => seen.files["/data/shell/conf-S1.sh"] ?? "";
	expect(conf()).toMatch(/\nPT_RUN='[^\n]* --pty-size 200x50 --timeout 120 --env /);
	expect(conf()).toMatch(/\nPT_RUN_NOPTY='[^\n]* --max-bytes 24000 --timeout 120 --env /);

	expect((await slash($, "timeout 300")).text).toMatch(/default deadline for this session: 300s, for a call that names no `timeout` and for your own `!` and `\/sh` commands/);
	expect(conf()).toMatch(/\nPT_RUN='[^\n]* --timeout 300 --env /);
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	await $.command.run({ command: "sh", args: "make", origin: { kind: "composer" } } as never);
	for (const issued of seen.issued as Array<{ command: string; timeout: number }>) {
		expect(issued.command).toMatch(/--timeout 300 /);
		expect(issued.timeout).toBe(305_000);
	}
	expect((await slash($, "status")).text).toMatch(/- deadline: 300s for every command that names none — a tool call with no `timeout`, and your own `!` and `\/sh` commands/);
	// A caller's own number still wins over the default.
	await $.tool.run({ tool: "Bash", tool_use_id: "t2", command: "make", timeout: 30_000 });
	expect((seen.issued[2] as { command: string }).command).toMatch(/--timeout 29 /);

	expect((await slash($, "timeout off")).text).toMatch(/default deadline for this session: off/);
	expect(conf()).not.toMatch(/--timeout/);
	expect((await slash($, "status")).text).toMatch(/- deadline: none of Pi-Time's/);
	expect((await slash($, "timeout soon")).text).toMatch(/^Usage: `\/pi-time timeout <seconds>`/);
});

test("a `!` command's silence limit rides with its deadline, and goes when the deadline goes", async ($, on) => {
	const seen = world(on, { sid: "S1", features: ["idle-timeout"] });
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });
	const conf = () => seen.files["/data/shell/conf-S1.sh"] ?? "";
	expect(conf()).toMatch(/\nPT_RUN='[^\n]* --timeout 120 --idle-timeout 120 --env /);
	await slash($, "idle 30");
	expect(conf()).toMatch(/\nPT_RUN='[^\n]* --timeout 120 --idle-timeout 30 --env /);
	// "Runs until it finishes" has to be true: no deadline, so no watchdog either.
	await slash($, "timeout off");
	expect(conf()).not.toMatch(/--timeout|--idle-timeout/);
	expect((await slash($, "status")).text).toMatch(/whatever its deadline \(not your own `!` commands while the deadline is off\)/);
	// A tool call still has the host's deadline, taken over, and the limit with it.
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	expect(seen.issued[0]?.command).toMatch(/--timeout 119 --idle-timeout 30 /);
	await slash($, "idle off");
	await slash($, "timeout 120");
	expect(conf()).toMatch(/--timeout 120 --env /);
	expect(conf()).not.toMatch(/--idle-timeout/);
});

const COMPOSE = { model: "m", promptModel: "m", surfaces: [], outputStyle: null, traits: [], tools: ["Bash"] };

/** The engine's own, empty, system prompt: registered before a test first calls `$`. */
function composes(on: On): void {
	on("prompt.compose", () => ({ sections: [] }));
}

/** The Pi-Time section as the model would be sent it. */
async function section($: Engine): Promise<string> {
	return (await $.prompt.compose(COMPOSE)).sections[0]?.text ?? "";
}

test("every wrapped command is handed the variables that switch buffering off, and both preludes", async ($, on) => {
	const seen = world(on, { sid: "S1", uname: "Darwin" });
	composes(on);
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make | tee build.log" });
	await $.command.run({ command: "sh", args: "make", origin: { kind: "composer" } } as never);
	// The two preludes are files of the plugin's own, written before anything names them.
	expect(seen.files["/data/pitime-unbuffer.rb"]).toMatch(/\$stdout\.sync = true/);
	expect(seen.files["/data/PiTimeUnbuffer.pm"]).toMatch(/^package PiTimeUnbuffer;\n[^\n]*\n\$\| = 1;\n1;\n$/);
	const conf = seen.files["/data/shell/conf-S1.sh"] ?? "";
	// A tool call, `/sh` and the `!` shim all carry the same set.
	for (const text of [String(seen.issued[0]?.command), String(seen.issued[1]?.command), conf]) {
		expect(text).toMatch(/ --env PYTHONUNBUFFERED=1 --env STDBUF1=L --env NSUnbufferedIO=YES /);
		expect(text.includes('--env "LUA_INIT=${LUA_INIT:-io.stdout:setvbuf[[line]]}"')).toBe(true);
		expect(text.includes('--env "RUBYOPT=${RUBYOPT:+$RUBYOPT }-r/data/pitime-unbuffer.rb"')).toBe(true);
		expect(text.includes('--env "PERL5OPT=${PERL5OPT:+$PERL5OPT }-I/data -MPiTimeUnbuffer"')).toBe(true);
		expect(text).not.toMatch(/LD_PRELOAD/);
	}
	expect((await slash($, "status")).text).toMatch(/- buffering: switched off for Python, Ruby, Perl, Lua and every C-stdio program \(`STDBUF1=L`: grep, sed, awk, jq, compiled C and Swift\)/);
	const text = await section($);
	expect(text).toMatch(/buffering is switched off for Python, Ruby, Perl, Lua and C-stdio programs \(`grep`, `sed`, `awk`, `jq`, compiled C\), so lines still arrive when written/);
	expect(text).toMatch(/so lines still arrive when written; for millions of lines prefix the command with `STDBUF1=F`\./);
});

test("on Linux the model is told what still writes in blocks, and which flag fixes it", async ($, on) => {
	const seen = world(on, { uname: "Linux", exists: ["/usr/libexec/coreutils/libstdbuf.so"] });
	composes(on);
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	// The library is there, but nobody asked for a preload.
	expect(String(seen.issued[0]?.command)).not.toMatch(/LD_PRELOAD|_STDBUF_O/);
	expect((await slash($, "status")).text).toMatch(/- buffering: switched off for Python, Ruby, Perl, Lua; C-stdio programs \(grep, sed, awk, compiled C\) on a pipe still write in blocks here — the `preloadStdbuf` option/);
	const text = await section($);
	expect(text).toMatch(/buffering is switched off for Python, Ruby, Perl and Lua\. A C-stdio program \(`grep`, `sed`, `awk`, compiled C\) there still writes in blocks/);
	expect(text).toMatch(/A C-stdio program \(`grep`, `sed`, `awk`, compiled C\) there still writes in blocks, .* use `grep --line-buffered`, `sed -u` or `stdbuf -oL cmd`\./);
	expect(text).not.toMatch(/STDBUF1/);
});

test("the stdbuf preload is used on Linux only when asked for and found", { options: { preloadStdbuf: true } }, async ($, on) => {
	const seen = world(on, { uname: "Linux", exists: ["/usr/lib/aarch64-linux-gnu/coreutils/libstdbuf.so"] });
	composes(on);
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make | grep warning" });
	expect(String(seen.issued[0]?.command).includes('--env "LD_PRELOAD=${LD_PRELOAD:+$LD_PRELOAD:}/usr/lib/aarch64-linux-gnu/coreutils/libstdbuf.so" --env _STDBUF_O=L ')).toBe(true);
	expect((await slash($, "status")).text).toMatch(/and dynamically linked C-stdio programs, through `LD_PRELOAD` of `\/usr\/lib\/aarch64-linux-gnu\/coreutils\/libstdbuf\.so`/);
	expect(await section($)).toMatch(/Lua and dynamically linked C-stdio programs .* prefix the command with `_STDBUF_O=65536`\./);
});

test("asked for a preload where there is no library, nothing is preloaded and status says so", { options: { preloadStdbuf: true } }, async ($, on) => {
	const seen = world(on, { uname: "Linux" });
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	expect(String(seen.issued[0]?.command)).not.toMatch(/LD_PRELOAD/);
	expect((await slash($, "status")).text).toMatch(/`preloadStdbuf` is on, but no `libstdbuf\.so` from GNU coreutils was found/);
});

test("with unbuffer off no program's buffering is touched, and the model is told that instead", { options: { unbuffer: false } }, async ($, on) => {
	const seen = world(on, { uname: "Darwin" });
	composes(on);
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	const command = String(seen.issued[0]?.command);
	expect(command).not.toMatch(/PYTHONUNBUFFERED|STDBUF|NSUnbufferedIO|LUA_INIT|RUBYOPT|PERL5OPT/);
	// The rest of the wrapper's environment is not buffering and stays.
	expect(command).toMatch(/ --env TERM=dumb /);
	expect(Object.keys(seen.files).some((path) => /pitime-unbuffer|PiTimeUnbuffer/.test(path))).toBe(false);
	expect((await slash($, "status")).text).toMatch(/- buffering: left to each program \(`unbuffer` is off\)/);
	expect(await section($)).toMatch(/Output buffering is left to each program: one writing into a pipe or a file may hold its lines/);
});

test("a data folder with a space gets no prelude: neither variable could carry its path", async ($, on) => {
	const seen = world(on, { data: "/Users/a b/data", uname: "Darwin" });
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "ruby x.rb" });
	expect(String(seen.issued[0]?.command)).not.toMatch(/RUBYOPT|PERL5OPT/);
	expect(String(seen.issued[0]?.command)).toMatch(/ --env STDBUF1=L /);
	expect((await slash($, "status")).text).toMatch(/switched off for Python, Lua \(no Ruby or Perl prelude could be written to the data folder\)/);
});

test("/sh does not refuse the person's own stream merge", async ($, on) => {
	const seen = world(on);
	await $.command.run({ command: "sh", args: "make 2>&1 | tail -5", origin: { kind: "composer" } } as never);
	// The guard is for the model's reflex; what the person types is the person's choice.
	expect(seen.issued).toHaveLength(1);
});

test("/sh says what to type, and says so when there is nothing to wrap with", async ($, on) => {
	world(on, { hasBusybox: false });
	expect(((await $.command.run({ command: "sh" } as never)) as { text?: string }).text).toMatch(/^Usage: `\/sh <command>`/);
	expect(((await $.command.run({ command: "sh", args: "ls", origin: { kind: "sdk" } } as never)) as { text?: string }).text).toMatch(/not wrapping \(no busybox build/);
});

test("the model is told that a `!` command is outside the capture and `/sh` is inside it", async ($, on) => {
	world(on);
	on("prompt.compose", () => ({ sections: [] }));
	const composed = await $.prompt.compose({ model: "m", promptModel: "m", surfaces: [], outputStyle: null, traits: [], tools: ["Bash"] });
	expect(composed.sections[0]?.text).toMatch(/types with `!` does not go through the capture/);
	expect(composed.sections[0]?.text).toMatch(/One run with `\/sh` does, and arrives as a timeline/);
});

test("/sh runs only for the person: a line that arrives any other way is refused", async ($, on) => {
	const seen = world(on);
	for (const origin of [{ kind: "peer" }, { kind: "channel", server: "slack" }, { kind: "scheduled-trigger" }, { kind: "plugin", name: "other" }, { kind: "unclassified" }, undefined]) {
		const ran = (await $.command.run({ command: "sh", args: "touch owned", ...(origin ? { origin } : {}) } as never)) as { text?: string };
		expect(ran.text).toMatch(/only runs when you type it yourself/);
	}
	// Nothing reached the shell.
	expect(seen.issued).toHaveLength(0);
	expect(seen.passed).toHaveLength(0);
	// The person's own three doors do run it.
	for (const kind of ["composer", "bridge", "sdk"]) {
		await $.command.run({ command: "sh", args: "true", origin: { kind } } as never);
	}
	expect(seen.issued).toHaveLength(3);
});

const START = { cwd: "/work", surface: "terminal", isInteractive: true } as const;

/** The kit runs tests where timers exist; its typings do not declare them. */
declare function setTimeout(run: (value?: unknown) => void, ms: number): unknown;

/** The composer's two events, as the engine raises them; the kit's typings leave them off `$.prompt`. */
function composer($: Engine): {
	edit: (e: Record<string, unknown>) => Promise<{ text: string; cursor: number }>;
	change: (e: Record<string, unknown>) => Promise<unknown>;
} {
	return $.prompt as never;
}
const SHIM = "/data/shell/zsh";

/** Lowercase hex sha256, as the shim's `busybox sha256sum` prints it. */
async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("at session start Claude Code is pointed at the shim, once everything it needs is on disk", async ($, on) => {
	const seen = world(on, { sid: "S1" });
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	await $.session.start(START);
	// The script carries the real shell's name, and this session's file says how to wrap.
	expect(seen.files[SHIM]).toMatch(/^#!\/bin\/sh\n# Pi-Time shell shim/);
	expect(seen.files["/data/shell/conf-S1.sh"]).toMatch(/^PT_ENABLED=1\nPT_REAL='\/bin\/zsh'\nPT_BUSYBOX='\/home\/t\/\.pi\/agent\/bin\/busybox'\nPT_PTY=1\n/);
	expect(seen.setEnv.CLAUDE_CODE_SHELL).toBe(SHIM);
	// Written before it is named: the variable is the last step.
	expect(seen.written.indexOf(SHIM) < seen.written.indexOf("/data/shell/conf-S1.sh")).toBe(true);
	expect((await slash($, "status")).text).toMatch(/`!command` runs in \/bin\/zsh inside the capture/);
});

test("with the option off, or no session id, the shell is left exactly as it was", { options: { wrapBang: false } }, async ($, on) => {
	const seen = world(on, { sid: "S1" });
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	await $.session.start(START);
	expect(seen.setEnv.CLAUDE_CODE_SHELL).toBe(undefined);
	expect(Object.keys(seen.files).filter((path) => path.startsWith("/data/shell/"))).toHaveLength(0);
	expect((await slash($, "status")).text).toMatch(/`!command` does not \(the `wrapBang` option is off\)/);
});

test("with nothing to wrap with, the shim is not stood up", async ($, on) => {
	const seen = world(on, { sid: "S1", hasBusybox: false });
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	await $.session.start(START);
	expect(seen.setEnv.CLAUDE_CODE_SHELL).toBe(undefined);
});

test("the prompt box is followed by its hash alone, and an emptied box is not recorded", async ($, on) => {
	const seen = world(on, { sid: "S1" });
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	on("prompt.edit", (_, e) => {
		const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end);
		return { text, cursor: text.length };
	});
	on("prompt.change", (_, e) => ({ text: e.text, cursor: e.cursor }) as never);
	await $.session.start(START);
	const origin = { kind: "composer" } as const;
	const box = await composer($).edit({ origin, text: "", cursor: 0, start: 0, end: 0, inputText: "make  test" });
	// The edit itself is passed on untouched.
	expect(box.text).toBe("make  test");
	await new Promise((resolve) => setTimeout(resolve, 20));
	const draft = seen.files["/data/shell/draft-S1"] ?? "";
	expect(draft).toBe(await sha256("maketest"));
	// The text itself is nowhere on disk.
	expect(Object.values(seen.files).some((text) => text.includes("make  test"))).toBe(false);
	// Enter empties the box while the shell that needs the hash is still starting.
	await composer($).change({ text: "", cursor: 0, origin: { kind: "clear" } });
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(seen.files["/data/shell/draft-S1"]).toBe(draft);
});

test("a `!` command's stored result gets the digest and notes a tool result gets", async ($, on) => {
	world(on, { sid: "S1" });
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	const kept = mock.session(on);
	await $.session.start(START);
	const row = (text: string) => ({ message: { type: "user", role: "user", content: [{ type: "text", text }] }, door: "command", origin: { kind: "unclassified" } }) as never;
	await $.session.append(row("<bash-input>make test | tail -3</bash-input>"));
	await $.session.append(row(`<bash-stdout>${OK}</bash-stdout><bash-stderr></bash-stderr>`));
	const stored = JSON.stringify(kept.appended());
	expect(stored).toMatch(/<bash-input>make test \| tail -3<\/bash-input>/);
	expect(stored).toMatch(/\[8\.421 err\] warning: slow\\n--- pi-time ---\\ntiming: 8\.42s total/);
	expect(stored).toMatch(/pipeline ends in `tail`/);
	expect(stored).not.toMatch(/pruned=/);
	expect(stored).toMatch(/<\/bash-stdout><bash-stderr><\/bash-stderr>/);
});

test("a `!` command stopped at the deadline is stored with the notice that names the person's switch", async ($, on) => {
	world(on, { sid: "S1" });
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	const kept = mock.session(on);
	await $.session.start(START);
	const row = (text: string) => ({ message: { type: "user", role: "user", content: [{ type: "text", text }] }, door: "command", origin: { kind: "unclassified" } }) as never;
	const body = "run=R20 exit_code=-1 timed_out=true cancelled=false idle=false duration_ms=120011\ntimeline_lines=1 shown=1 truncated=false stamp=us res_ns=0\n--- timeline ---\n[0.01 out] listening on 3000";
	await $.session.append(row("<bash-input>npm run dev</bash-input>"));
	await $.session.append(row(`<bash-stdout>${body}</bash-stdout><bash-stderr></bash-stderr>`));
	const stored = JSON.stringify(kept.appended());
	expect(stored).toMatch(/TIMEOUT — not a failure of the command: it was still running when the 120s deadline fired/);
	expect(stored).toMatch(/The user ran this themselves, so there is no `timeout` to raise on a call/);
	expect(stored).toMatch(/`\/pi-time timeout <seconds>` gives their commands longer/);
});

test("a `!` result that is not a timeline is stored exactly as it came", async ($, on) => {
	world(on, { sid: "S1" });
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	const kept = mock.session(on);
	await $.session.start(START);
	const text = "<bash-stdout>plain output\nsecond line</bash-stdout><bash-stderr></bash-stderr>";
	await $.session.append({ message: { type: "user", role: "user", content: [{ type: "text", text }] }, door: "command", origin: { kind: "unclassified" } } as never);
	expect(JSON.stringify(kept.appended())).toMatch(/plain output\\nsecond line<\/bash-stdout>/);
	expect(JSON.stringify(kept.appended())).not.toMatch(/timing:|pipeline ends/);
});

test("switching Pi-Time off turns the shim back into the plain shell, and on again restores it", async ($, on) => {
	const seen = world(on, { sid: "S1" });
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	await $.session.start(START);
	await slash($, "off");
	expect(seen.files["/data/shell/conf-S1.sh"]).toMatch(/^PT_ENABLED=0\n/);
	await slash($, "verbosity quiet");
	await slash($, "on");
	expect(seen.files["/data/shell/conf-S1.sh"]).toMatch(/^PT_ENABLED=1\n/);
	expect(seen.files["/data/shell/conf-S1.sh"]).toMatch(/--max-bytes 6000 /);
});

test("with the shim in place a tool call's own shell is still the real one", async ($, on) => {
	const seen = world(on, { sid: "S1", env: { CLAUDE_CODE_SHELL: SHIM } });
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	await $.session.start(START);
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "npm test" });
	// The environment names the shim (a reload sees its own earlier setting): never wrap in it.
	expect(seen.issued[0]?.command).toMatch(/-- '\/bin\/zsh' -c /);
	expect(seen.files["/data/shell/conf-S1.sh"]).toMatch(/PT_REAL='\/bin\/zsh'/);
});


// =============================================================================
// 0.5.0: what pi-managed-tools' hardening pass found, here
// =============================================================================

/**
 * A wrapped result as Claude Code's Bash hands it back: the view, and after it whatever
 * the outer shell wrote to stderr — measured in a live session, both arrive in `stdout`.
 */
function ranWith(stdout: string, facts?: string) {
	return () => ({ result: { stdout: facts === undefined ? stdout : `${stdout}\n${facts}`, stderr: "", interrupted: false } });
}

const QUICK = "run=R20 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=30\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n[0.030000000 out] 1";

test("a pipeline's stage statuses come from the run itself, and replace the guess", async ($, on) => {
	const seen = world(on, { inner: ranWith(QUICK, "pitime_facts ps=[1 141 0] dir=/tmp/t/busybox-run/R20") });
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "false | seq 1 100000 | head -1" });
	// The guest is asked: the trap reads the statuses before anything can overwrite them,
	// and the outer shell hands them over on stderr, after the capture has ended.
	const issued = seen.issued[0] as { command: string };
	expect(issued.command).toMatch(/--env "PITIME_FACTS_FILE=\$__pt_f\.f" /);
	expect(issued.command).toMatch(/printf 'pitime_facts ps=\[%s\] dir=%s\\n' "\$__pt_ps" "\$__pt_rd" >&2; fi; rm -f "\$__pt_f" "\$__pt_f\.f"; \(exit "\$__pt_rc"\)$/);
	const stdout = stdoutOf(ran);
	expect(stdout).toMatch(/\npipeline stage statuses: 1 141 0 — the exit_code shown is the last stage's; 141 is a stage ended by SIGPIPE because the next stage stopped reading, not a failure of its own; an earlier stage failed \(1\) and the header does not show it\.$/);
	// The fact replaces the caveat, and the facts line itself reaches nobody.
	expect(stdout).not.toMatch(/its own status is unknown|pitime_facts/);
	expect((ran.result as { stderr: string }).stderr).toBe("");
});

test("a host that keeps stderr apart has the facts read from there, and none left behind", async ($, on) => {
	world(on, { inner: () => ({ result: { stdout: QUICK, stderr: "zsh: warning\npitime_facts ps=[2 0] dir=/tmp/t/busybox-run/R20\n", interrupted: false } }) });
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make | tee build.log" });
	expect(stdoutOf(ran)).toMatch(/\npipeline stage statuses: 2 0 /);
	expect((ran.result as { stderr: string }).stderr).toBe("zsh: warning\n");
});

test("a pipeline whose stages all exited 0 earns no note at all", async ($, on) => {
	world(on, { inner: ranWith(QUICK, "pitime_facts ps=[0 0] dir=/tmp/t/busybox-run/R20") });
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "ls | head -3" });
	// Without the facts every `| head` call carried two lines about a status that was fine.
	// With nothing to add, a short command costs one header line and its own output.
	expect(stdoutOf(ran)).toBe("run=R20 exit_code=0 duration_ms=30\n[0.030 out] 1");
});

test("with no facts from the guest the old caveat stands, in full once and in a few words after", async ($, on) => {
	world(on, { inner: ranWith(QUICK) });
	const first = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make | head -3" });
	expect(stdoutOf(first)).toMatch(/the pipeline ends in `head`: the exit_code shown is `head`'s, not the command's — and if `head` closed the pipe early/);
	const second = await $.tool.run({ tool: "Bash", tool_use_id: "t2", command: "make test | head -3" });
	// The same two lines on every call are read once and then skimmed past.
	expect(stdoutOf(second)).toMatch(/\nexit_code is `head`'s, not the command's\.$/);
	expect(stdoutOf(second)).not.toMatch(/closed the pipe early/);
});

test("a failed call's facts are read out of the host's error text, wherever its stderr sits in it", async ($, on) => {
	const text = "Exit code 1\nrun=R21 exit_code=1 timed_out=false cancelled=false idle=false duration_ms=40\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n[0.030000000 err] boom\npitime_facts ps=[2 1] dir=/tmp/t/busybox-run/R21";
	world(on, { inner: () => ({ isError: true, result: text, text }) });
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "build | grep -c warning" });
	expect(ran.deny).toMatch(/^Exit code 1\nrun=R21 exit_code=1 /);
	expect(ran.deny).toMatch(/\npipeline stage statuses: 2 1 — the exit_code shown is the last stage's; an earlier stage failed \(2\) and the header does not show it\./);
	// `grep` exited 1, so its own caveat applies too.
	expect(ran.deny).toMatch(/exit_code 1 means no match/);
	expect(ran.deny).not.toMatch(/pitime_facts/);
});

test("a `grep` that matched needs no caveat", async ($, on) => {
	world(on, { inner: ranWith(QUICK, "pitime_facts ps=[0 0] dir=/tmp/t/busybox-run/R20") });
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "ps aux | grep node" });
	expect(stdoutOf(ran)).not.toMatch(/no match/);
});

/** A long run as `run` prints it since 0.6.0: the head, the cut, the tail. */
const CUT = [
	"run=R30 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=900",
	"timeline_lines=762 shown=5 truncated=true stamp=ns res_ns=41",
	"--- timeline ---",
	"[0.010000000 out] line 1",
	"[0.010000000 out] line 2",
	"[0.011000000 err] warning: early",
	"... [timeline truncated: 5 of 762 lines shown (757 omitted); `log R30 --stream timeline' has them] ...",
	"[0.890000000 out] line 761",
	"[0.890000000 out] line 762",
].join("\n");

test("a truncated view's pointer names the lines that are missing, not the ones already shown", async ($, on) => {
	const seen = world(on, {
		features: ["log-query"],
		summary: "run=R30 lines=762 stderr=41 first_out_us=10000 first_err_us=11000 last_us=890000 longest_gap_us=8510 exit_code=0 duration_ms=900 timed_out=0\n",
		inner: ranWith(CUT, "pitime_facts ps=[0] dir=/sandbox/tmp/busybox-run/R30"),
	});
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make -j8" });
	const stdout = stdoutOf(ran);
	// The view keeps the head and the tail: "head only … read the end" sent the model to
	// lines it already had.
	expect(stdout).toMatch(/\n--- pi-time ---\ntruncated: 5 of 762 lines shown — the first 3 and the last 2\. Lines 4-760 are omitted, 40 of them on stderr\./);
	expect(stdout).toMatch(/\/home\/t\/\.pi\/agent\/bin\/busybox log R30 --stream timeline --lines 4:43 reads part of the gap; with --match STR in place of --stream and --lines it finds a literal anywhere, and with --stream stderr alone it shows the stderr lines/);
	// The counts stay in the header when the view was cut, and only then.
	expect(stdout).toMatch(/^run=R30 exit_code=0 duration_ms=900\ntimeline_lines=762 shown=5 truncated=true\n\[0\.010 out\] line 1\n/);
	expect(stdout).not.toMatch(/head only/);
	// Run ids are counters per root: the summary is asked of the root this run reported.
	expect(seen.ran).toContainEqual([BUSYBOX, "log", "-D", "/sandbox/tmp/busybox-run", "R30", "--summary"]);
});

test("a summary that is not about this run is not believed", async ($, on) => {
	// Another root's R30 answers: same id, another run, another duration.
	world(on, { features: ["log-query"], summary: "run=R30 lines=3 stderr=0 exit_code=0 duration_ms=12 timed_out=0\n", inner: ranWith(CUT) });
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make -j8" });
	expect(stdoutOf(ran)).toMatch(/Lines 4-760 are omitted, it may hold stderr lines this view does not show\./);
});

test("a command that prints the words `truncated=true` has not been truncated", async ($, on) => {
	// Met in use: a diff quoting those words came back with "137 of 137 lines shown, head only".
	const stdout = "run=R31 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=20\ntimeline_lines=2 shown=2 truncated=false\n--- timeline ---\n[0.010000000 out] a view marked `truncated=true` shows\n[0.011000000 out] timeline_lines=9 shown=1 truncated=true";
	world(on, { inner: ranWith(stdout) });
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "git diff" });
	// No pointer, no notes: only the header and the stamps are respelled.
	expect(stdoutOf(ran)).toBe("run=R31 exit_code=0 duration_ms=20\n[0.010 out] a view marked `truncated=true` shows\n[0.011 out] timeline_lines=9 shown=1 truncated=true");
});

test("a stamp starts a burst and the lines under it carry none; the cut ends a burst", async ($, on) => {
	world(on, { inner: ranWith(CUT) });
	const stdout = stdoutOf(await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make -j8" }));
	expect(stdout).toMatch(/\n\[0\.010 out\] line 1\nline 2\n\[0\.011 err\] warning: early\n/);
	// The cut ends a burst: the first line after it carries its own offset again.
	expect(stdout).toMatch(/\] \.\.\.\n\[0\.890 out\] line 761\nline 762\n/);
});

test("with compactStamps off every line keeps a stamp", { options: { compactStamps: false } }, async ($, on) => {
	world(on, { inner: ranWith(CUT) });
	const stdout = stdoutOf(await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make -j8" }));
	expect(stdout).toMatch(/\n\[0\.010 out\] line 1\n\[0\.010 out\] line 2\n/);
	expect(stdout).toMatch(/\n\[0\.890 out\] line 762\n/);
});

test("the person's row is the same lines either way: `[= out]` is decoration too", async ($, on) => {
	world(on, { inner: ranWith(CUT) });
	let drawnFrom: unknown;
	on("ui.render", ($, e) => {
		drawnFrom = (e.props as { output?: unknown }).output;
		const { Text } = $.ui.resolve(e);
		return (<Text>engine</Text>) as never;
	});
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make -j8" });
	const ui = await $.ui.mount({ ...RESULT_ROW, surface: "terminal", props: { tool_use_id: "t1", tool: "Bash", output: ran.result, isErrored: false } });
	const drawn = (drawnFrom as { stdout: string }).stdout;
	// The cut between head and tail is the one line of the wrapper's a person needs.
	expect(drawn).toMatch(/^line 1\nline 2\nwarning: early\n\.\.\. \[timeline truncated: 5 of 762 lines shown \(757 omitted\)[^\n]*\nline 761\nline 762\n/);
	expect(drawn).not.toMatch(/\[= out\]|0\.010|pi-time/);
	await ui.unmount();
});

test("a command that cannot end here is refused before it runs, with what to write instead", async ($, on) => {
	const seen = world(on);
	for (const [command, said] of [
		["tail -f /var/log/app.log", /`tail -f` follows until interrupted/],
		["cd web && npm run dev", /starts something that runs until stopped/],
		["git log | less", /a pager waits for keys nobody can press/],
		["vim src/main.ts", /an editor waits for keys nobody can press/],
		["python3 -m http.server 8080", /a web server runs until stopped/],
	] as const) {
		const refused = await $.tool.call({ tool: "Bash", command });
		expect(refused.deny).toMatch(/^Blocked before running: /);
		expect(refused.deny).toMatch(said);
		expect(refused.deny).toMatch(/nobody can press a key or Ctrl-C — it would run until the deadline and come back as a TIMEOUT/);
	}
	// A server's rewrite is Claude Code's own: the call that returns at once.
	expect((await $.tool.call({ tool: "Bash", command: "npm run dev" })).deny).toMatch(/`run_in_background: true`/);
	expect(seen.issued).toHaveLength(0);
	expect(seen.passed).toHaveLength(0);
	expect((await slash($)).text).toMatch(/\(6 refused this session\)/);
});

test("what does end, or was meant to keep running, is let through", async ($, on) => {
	world(on);
	for (const command of [
		// The same commands, backgrounded by the call or inside it.
		"npm run dev >dev.log 2>dev.err &",
		// A pipeline that ends, a bounded form, a version check.
		"tail -f build.log | grep -m1 ready",
		"timeout 20 tail -f build.log",
		"tail -n 50 build.log",
		"vim --version",
		"top -l 1",
		// A word in a string or a pattern is not a command: the first real session in pi
		// refused a grep whose pattern held `\|tail -f /dev/null`.
		'grep -n "PIPESTATUS\\|tail -f /dev/null" notes.md',
		"echo 'run less or vim yourself'",
		// Declared to end by itself.
		"watch -n1 -g ls # pitime-safe",
	]) {
		expect((await $.tool.call({ tool: "Bash", command })).deny).toBe(undefined);
	}
	expect((await $.tool.call({ tool: "Bash", command: "npm run dev", run_in_background: true })).deny).toBe(undefined);
});

test("with the guard off nothing is refused", { options: { guard: false } }, async ($, on) => {
	world(on);
	expect((await $.tool.call({ tool: "Bash", command: "tail -f app.log" })).deny).toBe(undefined);
});

test("`busybox sh -c` is a command like any other: wrapped, with a deadline", async ($, on) => {
	const seen = world(on);
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: `${BUSYBOX} sh -c 'for f in *; do wc -l "$f"; done'` });
	expect(seen.passed).toHaveLength(0);
	expect((seen.issued[0] as { command: string }).command).toMatch(/ run --timestamps .* --timeout 120 .* -c 'exec <\/dev\/null; trap /);
	// Reading a capture back is still left exactly as written.
	await $.tool.run({ tool: "Bash", tool_use_id: "t2", command: `${BUSYBOX} log R12 --stream stderr` });
	expect(seen.passed).toHaveLength(1);
});

test("a build that declares `run` and cannot wrap an `echo` is passed over: Bash runs as written", async ($, on) => {
	const seen = world(on, { probeFails: "run: cannot create /tmp/t/busybox-run: Read-only file system" });
	on("prompt.compose", () => ({ sections: [] }));
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "npm test" });
	// Running commands as written beats failing every one of them.
	expect(seen.issued).toHaveLength(0);
	expect(stdoutOf(ran)).toBe("as written");
	const status = (await slash($)).text ?? "";
	expect(status).toMatch(/\*\*not wrapping\*\*: the busybox at `\/home\/t\/\.pi\/agent\/bin\/busybox` failed its self-test \(run: cannot create \/tmp\/t\/busybox-run: Read-only file system\)/);
	// And the model is promised nothing.
	expect((await $.prompt.compose({ model: "m", promptModel: "m", surfaces: [], outputStyle: null, traits: [], tools: ["Bash"] })).sections).toHaveLength(0);
});

test("the self-test is one wrapped echo with the flags a command gets, and its line shapes the prompt", async ($, on) => {
	const seen = world(on, { features: ["stamp-ns", "idle-timeout"] });
	on("prompt.compose", () => ({ sections: [] }));
	const composed = await $.prompt.compose({ model: "m", promptModel: "m", surfaces: [], outputStyle: null, traits: [], tools: ["Bash"] });
	expect(seen.ran).toContainEqual([BUSYBOX, "run", "--timestamps", "--stamp-ns", "--max-bytes", "4000", "--timeout", "10", "--idle-timeout", "10", "--", "/bin/sh", "-c", "echo pi-time-probe"]);
	const text = composed.sections[0]?.text ?? "";
	// The example header and stamps are cut from what this build printed.
	expect(text).toMatch(/opens with `run=R12 exit_code=0 duration_ms=328`, then `\[0\.012 out\] text` starts a burst/);
	expect(text).toMatch(/Lines under it with no stamp arrived at that same offset on that same stream/);
});

test("an older build's prompt quotes what its results will look like once respelled", async ($, on) => {
	world(on);
	on("prompt.compose", () => ({ sections: [] }));
	const text = (await $.prompt.compose({ model: "m", promptModel: "m", surfaces: [], outputStyle: null, traits: [], tools: ["Bash"] })).sections[0]?.text ?? "";
	// Padded or not, six digits or nine: what the model is shown is what a result will
	// look like once the hook has respelled it, which is the same for every build.
	expect(text).toMatch(/opens with `run=R12 exit_code=0 duration_ms=328`, then `\[0\.012 out\] text` starts a burst/);
});

/** 205 run folders, newest first: the first 200 are kept whatever their age. */
function runsBeyond(ages: readonly number[]): Array<[string, number]> {
	const kept: Array<[string, number]> = Array.from({ length: 200 }, (_, i) => [`R${1000 - i}`, 500]);
	return [...kept, ...ages.map((age, i): [string, number] => [`R${700 - i}`, age])];
}

test("captures are swept by count and age together: beyond the newest 200, and hours old", async ($, on) => {
	const seen = world(on, { runs: [...runsBeyond([30, 119, 121, 3000]), ["notes.txt", 9000], ["R5x", 9000]] });
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });
	await new Promise((resolve) => setTimeout(resolve, 20));
	const removals = seen.ran.filter((argv) => argv[0] === "rm");
	// One removal, of the two runs that are both beyond the count and old enough, each
	// spelled out in full; the young ones may still be what a session was pointed at.
	expect(removals).toEqual([["rm", "-rf", "--", `${RUN_ROOT}/R698`, `${RUN_ROOT}/R697`]]);
});

test("under the count nothing is removed, however old", async ($, on) => {
	const seen = world(on, { runs: [["R3", 90_000], ["R2", 90_000], ["R1", 90_000]] });
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	await $.session.start({ cwd: "/work", surface: "terminal", isInteractive: true });
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(seen.ran.filter((argv) => argv[0] === "rm")).toHaveLength(0);
	expect((await slash($)).text).toMatch(/- captures: kept in `\/tmp\/t\/busybox-run` for `busybox log` — at least 2 hours, and the newest 200 for longer \(0 removed by this session\)/);
});


// =============================================================================
// 0.7.0: a running command is watched — its output, and its processor
// =============================================================================

const RUN_DIR = `${RUN_ROOT}/R50`;
const LIVE_FILE = "/data/live/t1";
const TOOL_ROW = { plugin: "managed-tools", component: "ToolUse", requestId: "t1" } as const;

/** A command that is still running: the test ends it, with whatever result it chooses. */
function held() {
	let finish: (value: unknown) => void = () => undefined;
	const pending = new Promise<unknown>((resolve) => {
		finish = resolve;
	});
	return { inner: () => pending, finish };
}

/** `ps -A -o pgid=,time=` for the command's group (4242) at a CPU time in seconds, among others. */
function psAt(seconds: number): string {
	return `    1  10:02.48\n 4242   0:${seconds.toFixed(2).padStart(5, "0")}\n  359   0:00.33\n`;
}

test("the command is told where to report itself, and the applet's own silence limit is left out", async ($, on) => {
	mock.clock(on);
	const seen = world(on, { features: ["stamp-ns", "idle-timeout"] });
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make -j8" });
	const issued = (seen.issued[0] as { command: string }).command;
	expect(issued).toMatch(/ --env 'PITIME_LIVE_FILE=\/data\/live\/t1' /);
	expect(issued).toMatch(/-c 'exec <\/dev\/null; \{ printf [^;]+ >"\$PITIME_LIVE_FILE"; \} 2>\/dev\/null; trap /);
	// Watched from here, by output and processor both: the applet's limit knows only silence.
	expect(issued).not.toMatch(/--idle-timeout/);
	expect(issued).toMatch(/--timeout 120 /);
	expect(issued).toMatch(/ '\/data\/live\/t1'; \(exit "\$__pt_rc"\)$/);
});

test("with live off nothing is watched, and the applet's silence limit stands", { options: { live: false } }, async ($, on) => {
	mock.clock(on);
	const seen = world(on, { features: ["stamp-ns", "idle-timeout"] });
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make -j8" });
	const issued = (seen.issued[0] as { command: string }).command;
	expect(issued).not.toMatch(/PITIME_LIVE_FILE/);
	expect(issued).toMatch(/--timeout 120 --idle-timeout 120 /);
});

test("a running command shows its newest lines and a sign of life under its row", async ($, on) => {
	const clock = mock.clock(on);
	const disk: Record<string, string> = {};
	let cpu = 0;
	const run = held();
	world(on, { disk, ps: () => psAt(cpu), inner: run.inner });
	on("ui.render", ($, e) => {
		const { Text } = $.ui.resolve(e);
		return (<Text>Bash(make -j8)</Text>) as never;
	});
	const pending = $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make -j8" });
	// Nothing is read for the first moment: most commands are over by then.
	await clock.advance(1000);
	const props = { tool_use_id: "t1", tool: "Bash", input: { command: "make -j8" }, isRunning: true, isErrored: false, isInterrupted: false };
	const early = await $.ui.mount({ ...TOOL_ROW, surface: "terminal", props });
	expect(await early.find({ type: "Text", text: /running/ })).toBe(undefined);
	await early.unmount();

	// The command has reported itself and printed two lines; the processor is busy.
	disk[LIVE_FILE] = `${RUN_DIR}\n4242\n`;
	disk[`${RUN_DIR}/stdout`] = "cc -c src/a.c\r\ncc -c src/b.c\r\n";
	disk[`${RUN_DIR}/stderr`] = "";
	await clock.advance(600);
	cpu = 3;
	await clock.advance(3000);
	const ui = await $.ui.mount({ ...TOOL_ROW, surface: "terminal", props });
	const shown = (await ui.find({ type: "Text", text: /running/ }))?.text ?? "";
	expect(shown).toBe("  ⎿  cc -c src/a.c\n     cc -c src/b.c\n     running 5s · last output 3s ago · CPU busy (100% of a processor): working");
	// The engine's own row is kept above it.
	expect((await ui.find({ type: "Text", text: /Bash\(make/ }))?.text).toBe("Bash(make -j8)");
	await ui.unmount();

	// More output, and a warning on stderr: the view follows the capture.
	disk[`${RUN_DIR}/stdout`] += "ld: linking\r\n";
	disk[`${RUN_DIR}/stderr`] = "warning: unused variable\n";
	await clock.advance(500);
	const later = await $.ui.mount({ ...TOOL_ROW, surface: "terminal", props });
	expect((await later.find({ type: "Text", text: /running/ }))?.text).toMatch(/cc -c src\/b\.c\n     ld: linking\n     warning: unused variable\n     running 5s · CPU busy/);
	await later.unmount();

	run.finish({ result: { stdout: OK, stderr: "", interrupted: false } });
	const ran = await pending;
	// The model is sent the result, and none of the live view.
	expect(stdoutOf(ran as { result?: unknown })).not.toMatch(/running \d+s|CPU busy/);
	// Once it has ended the row is the engine's alone again.
	const done = await $.ui.mount({ ...TOOL_ROW, surface: "terminal", props: { ...props, isRunning: false } });
	expect(await done.find({ type: "Text", text: /running/ })).toBe(undefined);
	await done.unmount();
});

test("a command with no sign of life — no line, no processor — is stopped as stuck, and the result says why", { options: { idleSeconds: 20 } }, async ($, on) => {
	const clock = mock.clock(on);
	const disk: Record<string, string> = { [LIVE_FILE]: `${RUN_DIR}\n4242\n`, [`${RUN_DIR}/stdout`]: "Password: ", [`${RUN_DIR}/stderr`]: "" };
	const run = held();
	// The processor time never moves: the command is waiting.
	const seen = world(on, { disk, ps: () => psAt(0.02), inner: run.inner });
	const pending = $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "sudo make install", timeout: 600_000 });
	await clock.advance(19_000);
	expect(seen.ran.filter((argv) => argv[0] === "kill")).toHaveLength(0);
	await clock.advance(4000);
	// Its whole group, and only a group that `ps` had just listed.
	expect(seen.ran.filter((argv) => argv[0] === "kill")).toEqual([["kill", "-TERM", "--", "-4242"]]);
	// Asked once. A command that ignores the request is not left running behind a result
	// that says it was stopped: three seconds on, the group is killed outright.
	await clock.advance(3100);
	expect(seen.ran.filter((argv) => argv[0] === "kill")).toEqual([["kill", "-TERM", "--", "-4242"], ["kill", "-KILL", "--", "-4242"]]);
	// The run reports a signal, since that is all it saw; the hooks module knows more.
	const text = "Exit code 1\nrun=R50 exit_code=-1 timed_out=false cancelled=false idle=false duration_ms=22100\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n[0.010000000 out] Password: ";
	run.finish({ isError: true, result: text, text });
	const ran = (await pending) as { deny?: string };
	expect(ran.deny).toMatch(/^IDLE — not a failure of the command and not its deadline: for 2\ds it printed nothing and used no processor time to speak of \(0\.0s\), so it was waiting, not working, and was stopped as stuck\./);
	expect(ran.deny).not.toMatch(/KILLED/);
	expect(ran.deny).toMatch(/\nExit code 1\nrun=R50 exit_code=-1 duration_ms=22100\n\[0\.010 out\] Password: /);
	expect((await slash($)).text).toMatch(/\(1 stopped this session\)/);
});

test("a command that is silent and working is left alone, and its deadline says it was working", { options: { idleSeconds: 20 } }, async ($, on) => {
	const clock = mock.clock(on);
	const disk: Record<string, string> = { [LIVE_FILE]: `${RUN_DIR}\n4242\n`, [`${RUN_DIR}/stdout`]: "compiling\r\n", [`${RUN_DIR}/stderr`]: "" };
	const run = held();
	let cpu = 0;
	const seen = world(on, { disk, ps: () => psAt(cpu), inner: run.inner });
	const pending = $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "cargo build --release" });
	// A whole processor, the whole time, and not a line after the first.
	for (let second = 0; second < 59; second++) {
		cpu += 1;
		await clock.advance(1000);
	}
	// Three times the silence limit has passed.
	expect(seen.ran.filter((argv) => argv[0] === "kill")).toHaveLength(0);
	const text = "Exit code 3\nrun=R50 exit_code=-1 timed_out=true cancelled=false idle=false duration_ms=59020\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n[0.300000000 out] compiling";
	run.finish({ isError: true, result: text, text });
	const ran = (await pending) as { deny?: string };
	expect(ran.deny).toMatch(/^TIMEOUT — not a failure of the command/);
	expect(ran.deny).toMatch(/\nCPU: it used 5\d\.\ds of processor time in 59s and was still computing when it was stopped, so it was working, not stuck: more time \(or `run_in_background`\) is what it needs\.\n/);
});

test("a command that cannot report itself is not watched again: such calls get the applet's own limit", async ($, on) => {
	const clock = mock.clock(on);
	const first = held();
	let calls = 0;
	// Nothing ever appears on disk: a sandbox that cannot write the report.
	const seen = world(on, { features: ["stamp-ns", "idle-timeout"], disk: {}, inner: () => (calls++ === 0 ? first.inner() : { result: { stdout: OK, stderr: "", interrupted: false } }) });
	on("prompt.compose", () => ({ sections: [] }));
	const compose = () => $.prompt.compose({ model: "m", promptModel: "m", surfaces: [], outputStyle: null, traits: [], tools: ["Bash"] });
	// While commands can be watched, the model is told what "stuck" means here.
	expect((await compose()).sections[0]?.text).toMatch(/a command that neither prints nor uses the processor for 120s is stopped as stuck whatever its `timeout`/);
	const pending = $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	await clock.advance(8000);
	first.finish({ result: { stdout: OK, stderr: "", interrupted: false } });
	await pending;
	await $.tool.run({ tool: "Bash", tool_use_id: "t2", command: "make test" });
	const [watched, unwatched] = seen.issued.map((call) => (call as { command: string }).command);
	expect(watched).toMatch(/PITIME_LIVE_FILE/);
	expect(watched).not.toMatch(/--idle-timeout/);
	expect(unwatched).not.toMatch(/PITIME_LIVE_FILE/);
	expect(unwatched).toMatch(/--idle-timeout 120 /);
	// And the model is told the truth about it from then on.
	expect((await compose()).sections[0]?.text).toMatch(/a command that prints nothing for 120s is stopped whatever its `timeout`/);
	expect((await slash($)).text).toMatch(/not for sandboxed commands here, which cannot report themselves and are judged by silence alone/);
});

test("nothing is signalled that `ps` did not just list", { options: { idleSeconds: 20 } }, async ($, on) => {
	const clock = mock.clock(on);
	const disk: Record<string, string> = { [LIVE_FILE]: `${RUN_DIR}\n4242\n`, [`${RUN_DIR}/stdout`]: "", [`${RUN_DIR}/stderr`]: "" };
	const run = held();
	// The group the command named is not among the processes: it has gone, or the file is stale.
	const seen = world(on, { disk, ps: () => "    1  10:02.48\n  359   0:00.33\n", inner: run.inner });
	const pending = $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	await clock.advance(60_000);
	expect(seen.ran.filter((argv) => argv[0] === "kill")).toHaveLength(0);
	run.finish({ result: { stdout: OK, stderr: "", interrupted: false } });
	await pending;
});
