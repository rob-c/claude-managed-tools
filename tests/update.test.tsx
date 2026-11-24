/**
 * The binary: which build is used, what is asked of it, and how the plugin's own copy
 * is kept at the latest release.
 *
 * Each `on` here stands for the machine: a file system, a few commands, GitHub.
 */
import { expect, mock, test } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";

/** The kit runs tests where timers exist; its typings do not declare them. */
declare function setTimeout(run: (value?: unknown) => void, ms: number): unknown;

const PI_COPY = "/home/t/.pi/agent/bin/busybox";
const OWN_COPY = "/data/bin/busybox";
const OLD_FEATURES = ["peek", "run", "log", "json"];
const NEW_FEATURES = [...OLD_FEATURES, "timeline", "pty", "stamp-ns", "idle-timeout", "log-query"];
const SHA = "a".repeat(64);
const START = { cwd: "/work", surface: "terminal", isInteractive: true } as const;

const OK = [
	"run=R12 exit_code=0 timed_out=false cancelled=false idle=false duration_ms=1214",
	"timeline_lines=2 shown=2 truncated=false stamp=ns res_ns=41",
	"--- timeline ---",
	"[00000.006785709 out] one",
	"[00001.214464084 err] late",
].join("\n");

interface Machine {
	/** Which copies exist, by path, and what each reports as its features. */
	binaries: Record<string, string[]>;
	/** The latest release GitHub would answer with; absent, GitHub is unreachable. */
	release?: { tag: string; sha256: string };
	/** What the downloaded file hashes to (defaults to the release's own checksum). */
	downloadSha?: string;
	/** What the plugin's store holds at the start. */
	store?: Record<string, unknown>;
	env?: Record<string, string>;
	/** What the wrapped command answers. */
	inner?: () => unknown;
}

interface Seen {
	issued: Array<{ command: string }>;
	fetched: string[];
	ran: string[][];
	toasts: string[];
}

const ASSET = "busybox-static-1.39.0-aac079e-darwin-universal";

function machine(on: On, world: Machine): Seen {
	const seen: Seen = { issued: [], fetched: [], ran: [], toasts: [] };
	mock.env(on, { HOME: "/home/t", SHELL: "/bin/zsh", ...(world.env ?? {}) });
	mock.store(on, world.store ?? {});
	on("session.start", (_, e) => ({ cwd: e.cwd }));
	on("process.hookEnv", () => ({ value: { CLAUDE_PLUGIN_DATA: "/data" } }));
	on("command.register", (_, e) => ({ value: { command: e.name } }));
	on("fs.exists", (_, e) => ({ value: e.path === "/bin/zsh" }));
	on("fs.write", () => ({ value: undefined }));
	on("fs.read", () => ({ deny: "ENOENT" }));
	on("ui.log", () => ({ value: undefined }) as never);
	on("ui.toast", (_, e) => {
		seen.toasts.push(String((e as { text?: unknown }).text ?? ""));
		return { value: undefined } as never;
	});
	on("fs.stat", (_, e) =>
		world.binaries[e.path] ? { value: { kind: "file" as const, size: 1_800_000, mtimeMs: 0, isLink: false } } : { deny: "ENOENT" },
	);
	on("http.fetch", (_, e) => {
		seen.fetched.push(e.url);
		if (!world.release) return { value: { status: 503, ok: false, headers: {}, text: "" } };
		const text = JSON.stringify({
			tag_name: world.release.tag,
			assets: [
				{
					name: ASSET,
					browser_download_url: `https://github.com/rob-c/busybox-static/releases/download/${world.release.tag}/${ASSET}`,
					digest: `sha256:${world.release.sha256}`,
				},
			],
		});
		return { value: { status: 200, ok: true, headers: {}, text } };
	});
	on("process.run", (_, e) => {
		const argv = [...e.argv];
		seen.ran.push(argv);
		const done = (stdout = "", exitCode = 0) => ({ value: { exitCode, stdout, stderr: "", isStdoutTruncated: false, isStderrTruncated: false } });
		const [program = "", first = ""] = argv;
		if (program === "uname") return done(first === "-s" ? "Darwin\n" : "arm64\n");
		if (program === "shasum") return done(`${world.downloadSha ?? world.release?.sha256 ?? ""}  ${argv[3]}\n`);
		if (program === "mv") {
			// The download becomes the plugin's own copy, with the features of the new release.
			world.binaries[argv[3] ?? ""] = NEW_FEATURES;
			return done();
		}
		if (first === "--caps") {
			const features = world.binaries[program] ?? (program.includes(".download-") ? NEW_FEATURES : undefined);
			return features ? done(JSON.stringify({ schema: 1, version: "1.39.0.git", features })) : done("", 127);
		}
		// The self-test a build must pass before a command is trusted to it: one wrapped
		// `echo`, answered in the shape that build prints.
		if (first === "run" && argv[argv.length - 1] === "echo pi-time-probe") {
			const stamp = argv.includes("--stamp-ns") ? "[0.004211000 out]" : "[   0.004211 out]";
			return done(`run=R1 exit_code=0 timed_out=false cancelled=false duration_ms=4\ntimeline_lines=1 shown=1 truncated=false\n--- timeline ---\n${stamp} pi-time-probe\n`);
		}
		// mkdir, curl, chmod, rm, find: they work.
		return done();
	});
	on("tool.run", (_, e, next) => {
		if (next.origin.plugin !== "managed-tools") return { result: { stdout: "as written", stderr: "", interrupted: false } } as never;
		seen.issued.push({ command: String((e as { command?: unknown }).command) });
		return (world.inner?.() ?? { result: { stdout: OK, stderr: "", interrupted: false } }) as never;
	});
	return seen;
}

function slash($: Engine, args: string): Promise<{ text?: string }> {
	return $.command.run({ command: "pi-time", args } as never);
}

async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 60));
}

test("a build that has them is asked for nanosecond offsets; an older one is not", async ($, on) => {
	const seen = machine(on, { binaries: { [OWN_COPY]: NEW_FEATURES } });
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	expect(seen.issued[0]?.command).toMatch(/'\/data\/bin\/busybox' run --timestamps --stamp-ns --max-bytes 24000 /);
});

test("pi's older copy is given only the flags it knows", { options: { idleSeconds: 30 } }, async ($, on) => {
	const seen = machine(on, { binaries: { [PI_COPY]: OLD_FEATURES } });
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	expect(seen.issued[0]?.command).toMatch(/busybox' run --timestamps --max-bytes 24000 /);
	expect(seen.issued[0]?.command).not.toMatch(/--stamp-ns|--idle-timeout/);
	// Asked for and not available: said, not silently dropped.
	expect((await slash($, "status")).text).toMatch(/silence: 30s asked for, but this build has no idle timeout/);
});

test("the plugin's own copy is preferred to pi's when both are there", async ($, on) => {
	const seen = machine(on, { binaries: { [OWN_COPY]: NEW_FEATURES, [PI_COPY]: OLD_FEATURES } });
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	expect(seen.issued[0]?.command).toMatch(/^__pt_f=[^;]+; '\/data\/bin\/busybox' run /);
});

test("the silence limit follows the option", { options: { idleSeconds: 45 } }, async ($, on) => {
	const seen = machine(on, { binaries: { [OWN_COPY]: NEW_FEATURES } });
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	expect(seen.issued[0]?.command).toMatch(/--timeout 120 --idle-timeout 45 /);
});

test("with no idle setting the silence limit is 120s, beside whatever deadline the call has", async ($, on) => {
	const seen = machine(on, { binaries: { [OWN_COPY]: NEW_FEATURES } });
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	expect(seen.issued[0]?.command).toMatch(/--timeout 120 --idle-timeout 120 /);
	// Where it earns its keep: a call given ten minutes is still stopped after two of silence.
	await $.tool.run({ tool: "Bash", tool_use_id: "t2", command: "make", timeout: 600_000 });
	expect(seen.issued[1]?.command).toMatch(/--timeout 599 --idle-timeout 120 /);
	await $.command.run({ command: "sh", args: "make", origin: { kind: "composer" } } as never);
	expect(seen.issued[2]?.command).toMatch(/--timeout 120 --idle-timeout 120 /);
	expect((await slash($, "status")).text).toMatch(/- silence: a command that prints nothing on either stream for 120s is stopped as `IDLE`, whatever its deadline/);
});

test("the option at 0, or the environment, turns the silence limit off", { options: { idleSeconds: 0 } }, async ($, on) => {
	const seen = machine(on, { binaries: { [OWN_COPY]: NEW_FEATURES } });
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	expect(seen.issued[0]?.command).not.toMatch(/--idle-timeout/);
	expect((await slash($, "status")).text).toMatch(/- silence: a quiet command is left to run to its deadline/);
});

test("/pi-time idle sets the silence limit for the session, and off removes it", async ($, on) => {
	const seen = machine(on, { binaries: { [OWN_COPY]: NEW_FEATURES } });
	expect((await slash($, "idle 300")).text).toMatch(/silence limit for this session: 300s\. A command that prints nothing on either stream for that long is stopped as `IDLE`/);
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make", timeout: 600_000 });
	expect(seen.issued[0]?.command).toMatch(/--timeout 599 --idle-timeout 300 /);
	expect((await slash($, "idle off")).text).toMatch(/silence limit for this session: off\. A quiet command runs to its deadline\./);
	await $.tool.run({ tool: "Bash", tool_use_id: "t2", command: "make" });
	expect(seen.issued[1]?.command).not.toMatch(/--idle-timeout/);
	expect((await slash($, "idle soon")).text).toMatch(/^Usage: `\/pi-time idle <seconds>`/);
});

test("/pi-time idle on a build with no idle timeout says nothing will be stopped", async ($, on) => {
	machine(on, { binaries: { [PI_COPY]: OLD_FEATURES } });
	expect((await slash($, "idle 60")).text).toMatch(/60s, but the busybox in use has no idle timeout, so nothing is stopped for silence/);
});

test("a command stopped for silence comes back as IDLE, not as a signal or a deadline", { options: { idleSeconds: 2 } }, async ($, on) => {
	const text = "Exit code 3\nrun=R14 exit_code=-1 timed_out=false cancelled=false idle=true duration_ms=2025\ntimeline_lines=1 shown=1 truncated=false stamp=ns res_ns=41\n--- timeline ---\n[00000.005950123 out] start";
	machine(on, { binaries: { [OWN_COPY]: NEW_FEATURES }, inner: () => ({ isError: true, result: text, text }) });
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "read answer" });
	// How it ended comes first: before the host's "Exit code 3" and before the output.
	expect(ran.deny).toMatch(/^IDLE — not a failure of the command and not its deadline: it printed nothing for 2s/);
	expect(ran.deny).toMatch(/\nExit code 3\nrun=R14 exit_code=-1 /);
	// Stdin is ruled out, not blamed: a read there returns end-of-file at once (measured).
	expect(ran.deny).toMatch(/it was not on standard input: stdin is empty here/);
	expect(ran.deny).toMatch(/If it was working quietly, a larger `timeout` will not help/);
	expect(ran.deny).not.toMatch(/KILLED|TIMEOUT/);
	expect(ran.deny).toMatch(/\/data\/bin\/busybox log R14 --stream timeline/);
});

test("the digest reads nanosecond offsets as it reads microsecond ones", async ($, on) => {
	machine(on, { binaries: { [OWN_COPY]: NEW_FEATURES } });
	const ran = await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	expect((ran.result as { stdout: string }).stdout).toMatch(/\ntiming: 1\.21s total, 2 lines, output from 0\.01s, stderr from 1\.21s, longest pause 1\.21s/);
});

test("the model is told what this build's offsets look like and what its log can do", async ($, on) => {
	machine(on, { binaries: { [OWN_COPY]: NEW_FEATURES } });
	on("prompt.compose", () => ({ sections: [] }));
	const base = { model: "m", promptModel: "m", surfaces: [], outputStyle: null, traits: [], tools: ["Bash"] };
	const text = (await $.prompt.compose(base)).sections[0]?.text ?? "";
	expect(text).toMatch(/`\[0\.012345678 out\] text`/);
	expect(text).toMatch(/to the nanosecond/);
	expect(text).toMatch(/`--sample N` gives its first and last N lines/);
});

test("on a first start with no binary anywhere, the latest release is fetched, verified and used", async ($, on) => {
	const world: Machine = { binaries: {}, release: { tag: "v0.6.0", sha256: SHA } };
	const seen = machine(on, world);
	await $.session.start(START);
	await settle();
	expect(seen.fetched).toEqual(["https://api.github.com/repos/rob-c/busybox-static/releases/latest"]);
	const curl = seen.ran.find((argv) => argv[0] === "curl") ?? [];
	// Only GitHub's own release download, over https, to a file of this process's own.
	expect(curl.slice(1, 6)).toEqual(["-fsSL", "--proto", "=https", "--tlsv1.2", "-o"]);
	expect(curl[6]).toMatch(/^\/data\/bin\/busybox\.download-/);
	expect(curl[7]).toBe(`https://github.com/rob-c/busybox-static/releases/download/v0.6.0/${ASSET}`);
	// Checked, made runnable, asked what it is, and only then moved into place.
	const steps = seen.ran.map((argv) => (argv[1] === "--caps" && /\.download-/.test(argv[0] ?? "") ? "probe" : (argv[0] ?? "")));
	const at = (name: string) => steps.indexOf(name);
	expect(at("curl") >= 0 && at("curl") < at("shasum")).toBe(true);
	expect(at("shasum") < at("chmod") && at("chmod") < at("probe") && at("probe") < at("mv")).toBe(true);
	expect(world.binaries[OWN_COPY]).toEqual(NEW_FEATURES);
	// The next command is wrapped with it, with what the new build can do.
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	expect(seen.issued[0]?.command).toMatch(/'\/data\/bin\/busybox' run --timestamps --stamp-ns /);
	const status = (await slash($, "status")).text ?? "";
	expect(status).toMatch(/busybox: `\/data\/bin\/busybox` \(release v0\.6\.0, busybox 1\.39\.0\.git\)/);
	expect(status).toMatch(/last update check: Installed busybox-static-1\.39\.0-aac079e-darwin-universal from v0\.6\.0/);
});

test("a newer release replaces the copy the plugin installed earlier", async ($, on) => {
	const world: Machine = {
		binaries: { [OWN_COPY]: OLD_FEATURES },
		release: { tag: "v0.6.0", sha256: SHA },
		store: { busybox: { tag: "v0.5.1", asset: ASSET, sha256: "b".repeat(64), installedAt: 1 }, busyboxCheckedAt: 0 },
	};
	const seen = machine(on, world);
	await $.session.start(START);
	await settle();
	expect(seen.ran.some((argv) => argv[0] === "mv")).toBe(true);
	expect((await slash($, "status")).text).toMatch(/from v0\.6\.0 \(was v0\.5\.1\)/);
});

test("a copy already at the latest release is left alone, and GitHub is asked once a day at most", async ($, on) => {
	const state = { tag: "v0.6.0", asset: ASSET, sha256: SHA, installedAt: 1 };
	// Checked a moment ago: nothing is asked.
	const seen = machine(on, { binaries: { [OWN_COPY]: NEW_FEATURES }, release: { tag: "v0.6.0", sha256: SHA }, store: { busybox: state, busyboxCheckedAt: Date.now() } });
	await $.session.start(START);
	await settle();
	expect(seen.fetched).toHaveLength(0);
	// Asked for by hand: GitHub is asked, and nothing is downloaded because nothing changed.
	expect((await slash($, "update")).text).toMatch(/^Up to date: v0\.6\.0/);
	expect(seen.fetched).toHaveLength(1);
	expect(seen.ran.some((argv) => argv[0] === "curl")).toBe(false);
});

test("a download that does not match its published checksum is never put in place", async ($, on) => {
	const world: Machine = { binaries: { [PI_COPY]: OLD_FEATURES }, release: { tag: "v0.6.0", sha256: SHA }, downloadSha: "c".repeat(64) };
	const seen = machine(on, world);
	const answer = (await slash($, "install")).text ?? "";
	expect(answer).toMatch(/^Not installed: sha256 mismatch/);
	expect(seen.ran.some((argv) => argv[0] === "mv")).toBe(false);
	expect(seen.ran.some((argv) => argv[0] === "rm" && /\.download-/.test(argv[2] ?? ""))).toBe(true);
	expect(world.binaries[OWN_COPY]).toBe(undefined);
	// What was in use stays in use.
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	expect(seen.issued[0]?.command).toMatch(/\.pi\/agent\/bin\/busybox' run /);
});

test("switched off, by option or by environment, nothing is fetched on its own", { options: { autoUpdate: false } }, async ($, on) => {
	const seen = machine(on, { binaries: { [PI_COPY]: OLD_FEATURES }, release: { tag: "v0.6.0", sha256: SHA } });
	await $.session.start(START);
	await settle();
	expect(seen.fetched).toHaveLength(0);
});

test("with GitHub unreachable the session carries on with what it has", async ($, on) => {
	const seen = machine(on, { binaries: { [PI_COPY]: OLD_FEATURES } });
	await $.session.start(START);
	await settle();
	await $.tool.run({ tool: "Bash", tool_use_id: "t1", command: "make" });
	expect(seen.issued).toHaveLength(1);
	expect((await slash($, "status")).text).toMatch(/last update check: Cannot install: GitHub answered 503/);
});
