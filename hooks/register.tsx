/*
 * claude-managed-tools — Pi-Time for Claude Code: every Bash call comes back as a timeline.
 * Copyright (C) 2026 Robert Currie
 *
 * This program is free software; you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation; version 2 of the License only.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY
 * WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
 * PARTICULAR PURPOSE. See the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with this
 * program; if not, see <https://www.gnu.org/licenses/old-licenses/gpl-2.0.html>.
 */
/**
 * Pi-Time, wired into Claude Code.
 *
 * Five hooks, each standing where pi-managed-tools stands in pi:
 *
 *   tool.call   the guard: `2>&1` at a command's end, or a command that cannot end here
 *               (a pager, `tail -f`, a foreground server), is refused before the
 *               permission prompt, because nobody should be asked to approve a command
 *               that will be refused anyway.
 *   tool.run    the wrapper. The call has been allowed *as the model wrote it* — rules,
 *               mode and the person all judged `npm test`, not a wrapper around it — and
 *               only then is it re-issued as `busybox run --timestamps … -- sh -c '…'`.
 *               That order is the whole design: a rewrite ahead of the permission check
 *               would make every allow rule stop matching and every deny rule blind.
 *   ui.render   the human's view: the same result drawn without the prefixes (the stored
 *               result, which the model reads, keeps them), and while a command runs, its
 *               newest lines and a sign of life under its row.
 *   prompt.compose  what the model is told about the timeline, while it is on.
 *   command.run     `/pi-time`: status, switches for this session, and the install.
 *
 * The re-issued call is Claude Code's own Bash tool, so the sandbox, the shell snapshot
 * and the working directory are the ones an unwrapped call would have had.
 */
import type { Register } from "claude-code";

import {
	type Abilities,
	abilitiesOf,
	BUSYBOX_RELEASE_URL,
	busyboxTarget,
	candidatePaths,
	defaultRunRoot,
	excessRuns,
	installedPath,
	type InstallState,
	isCheckDue,
	isRunRoot,
	isStale,
	needsInstall,
	parseCaps,
	parseShaOutput,
	pickAsset,
	probeArgv,
	readInstallState,
	readProbe,
	runRootOf,
	type StampShape,
} from "../src/busybox";
import { dropHousekeeping, hasTimeline, stripTimeline } from "../src/display";
import { CpuMeter, type CpuReading, cpuSentence, groupCpuSeconds, isStuck, lifeLine, liveDir, liveFile, type LivePointer, LiveTail, parsePointer, PS_ARGV } from "../src/live";
import { blockReason, detectEndless, detectTailMerge, endlessReason, guardEnabled, hasOverride, resultNotes, type RunFacts, takeFacts } from "../src/guard";
import { planDeadline, shellCandidates } from "../src/policy";
import { sectionId, sectionText } from "../src/prompt";
import { isPersonsOwn, modelContext, personText, SHELL_DESCRIPTION, SHELL_HINT, SHELL_USAGE } from "../src/shell";
import { bashBlock, confText, draftKeys, SHIM_SOURCE, shimDir, shimName, withStdout } from "../src/shim";
import { compactStamps, NOTES_MARKER, outcomeNotice, parseDurationMs, parseHeader, parseTimeline, type RunHeader, slimHeader, summarizeTiming, truncationHint } from "../src/timing";
import {
	describeVerbosity,
	isWrapped,
	PTY_MODES,
	type PtyMode,
	ptyWasRefused,
	readWrapSettings,
	PERL_PRELUDE,
	PERL_PRELUDE_NAME,
	RUBY_PRELUDE,
	RUBY_PRELUDE_NAME,
	RUN_MIN_AGE_MINUTES,
	RUN_RETENTION,
	STDBUF_LIBS,
	runPrefix,
	shellValue,
	VERBOSITIES,
	type Verbosity,
	wantsRaw,
	type WrapSettings,
	wrapCommand,
} from "../src/wrap";

type Engine = Parameters<Parameters<Parameters<Register>[0]>[2]>[0];
type Options = Parameters<Register>[1];
type Env = Record<string, string | undefined>;

/** How many lines of a failed command's output a folded row shows before "… +N lines". */
const ERROR_ROWS = 10;

/** The slash command's name; the plugin's own name is longer than anyone wants to type. */
const COMMAND = "pi-time";

/** Keys in the plugin's own store, kept between sessions. */
const STORE_INSTALLED = "busybox";
const STORE_CHECKED = "busyboxCheckedAt";

interface Found {
	path: string;
	version?: string;
	/** The build's own feature list, from `--caps`. */
	features: string[];
	/** What that list lets the wrapper ask for. */
	abilities: Abilities;
	/** How this build writes an offset, read off the line its self-test printed. */
	stamp: StampShape;
	/** The header line of that same run, for the prompt's example. */
	header?: string;
}

interface Located {
	found?: Found;
	/** What was looked at, for `/pi-time status` when nothing was found. */
	tried: string[];
	/** A build that declared `run` and then failed to wrap an `echo`: which, and what it said. */
	failed?: { path: string; reason: string };
	at: number;
	key: string;
}

/**
 * Session state. Module variables on purpose: they are this session's switches, and a
 * hot reload (a developer saving the file) starting them over is the honest behaviour.
 */
const session: {
	enabled?: boolean;
	verbosity?: Verbosity;
	pty?: PtyMode;
	/** `/pi-time timeout`: this session's default deadline in seconds, 0 for none. */
	timeoutSeconds?: number;
	/** `/pi-time idle`: this session's silence limit in seconds, 0 for none. */
	idleSeconds?: number;
	/** The deadline and silence limit the shim was last given, for the notice on a `!` result. */
	bang?: { timeoutSeconds: number; idleSeconds: number };
	located?: Located;
	dataDir?: string;
	shell?: string;
	/** The Ruby and Perl preludes that are on disk, once looked for. */
	preludes?: { ruby?: string; perl?: string };
	/** `stdbuf`'s preload library: a path, or null once looked for and not found. */
	stdbufLib?: string | null;
	/** `uname -s`, lowercased; null once asked and not answered. */
	platform?: string | null;
	/** The sandbox refused a pseudo-terminal this session: sandboxed calls go straight to pipes. */
	isPtyRefused?: boolean;
	/** Claude Code's own id for this session, as a shell it launches reads it. */
	sid?: string;
	/** The shell shim, once Claude Code has been pointed at it: where it is and whose shell it is. */
	shim?: { dir: string; path: string; real: string; sid: string };
	/** Why the shim is not in use, when it was wanted and could not be set up. */
	shimProblem?: string;
	/** The last `!` command the session recorded, for the notes on its result. */
	lastInput?: string;
	/** Writes of the draft's hash, one after another so the last edit is the last write. */
	draft: Promise<void>;
	/** This session's check for a newer release, once started. */
	update?: Promise<string>;
	/** How that check ended, for `/pi-time status`. */
	updateNote?: string;
	/** Notes already given in full this session: a repeat comes back in a few words. */
	seenNotes: Set<string>;
	/** Artifact roots this session's runs were seen in, besides the default one. */
	roots: Set<string>;
	/** Captures removed by this session's sweeps. */
	swept: number;
	/**
	 * Whether a running command could be watched, by kind of call (sandboxed or not): false
	 * once a command's own report of itself never turned up, as in a sandbox that cannot
	 * write it. Such calls then fall back to the applet's own silence limit.
	 */
	liveWorks: Map<string, boolean>;
	/** The folder for those reports has been made this session. */
	hasLiveDir?: boolean;
	/** Commands stopped by the hooks module for showing no sign of life. */
	stuck: number;
	wrapped: number;
	refused: number;
	blocked: number;
} = { wrapped: 0, refused: 0, blocked: 0, swept: 0, stuck: 0, draft: Promise.resolve(), seenNotes: new Set(), roots: new Set(), liveWorks: new Map() };

/** Before a running command is looked at: most commands are over by then, and pay nothing. */
const LIVE_DELAY_MS = 1500;
/** How often a running command's capture is read. */
const LIVE_INTERVAL_MS = 500;
/** Every this many reads, the processor is sampled too (`ps` costs more than a stat). */
const CPU_EVERY = 6;
/** How long a command has to report itself before the watch is given up. */
const LIVE_GIVE_UP_MS = 6000;
/** The most of a burst of output that is read for the live view. */
const LIVE_READ_BYTES = 16 * 1024;

/** One running command, as the hooks module watches it. */
interface Live {
	/** Where the command's shell says which capture and which process group are its own. */
	file: string;
	/** The kind of call, for remembering whether such calls can be watched at all. */
	kind: string;
	startedAt: number;
	pointer?: LivePointer;
	sizes: { stdout: number; stderr: number };
	tail: LiveTail;
	hasOutput: boolean;
	lastOutputAt: number;
	meter: CpuMeter;
	/** Whether the last `ps` listed the command's group: nothing is signalled that was not just seen. */
	isGroupSeen: boolean;
	/** The silence limit this watch enforces, in milliseconds; 0 when the applet enforces its own. */
	idleMs: number;
	/** Set when this watch stopped the command for showing no sign of life. */
	stopped?: { seconds: number; cpuSeconds?: number };
	timers: Array<{ cancel: () => void }>;
	ticks: number;
	isPolling: boolean;
	isDone: boolean;
}

/** The commands running now, by the id of the call the model made. */
const running = new Map<string, Live>();

/** How many wrapped commands pass between two sweeps of the captures. */
const SWEEP_EVERY = 25;

/** Calls whose command has been handed to Bash: a failure after that must not run it again. */
const started = new Set<string>();

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function flag(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function count(value: string | undefined): number | undefined {
	const parsed = Number((value ?? "").trim());
	return (value ?? "").trim() !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Every variable the module reads, each by its literal name so `validate` can list them. */
async function readEnv($: Engine): Promise<Env> {
	const [wrap, verbosity, pty, timeout, extraEnv, guard, busybox, shell, claudeShell, home, hostDefault, hostMax, idle, update, unbuffer, preload, compact, tmpdir, digits, liveSwitch] =
		await Promise.all([
			$.env.get("CLAUDE_MANAGED_TOOLS_WRAP"),
			$.env.get("CLAUDE_MANAGED_TOOLS_VERBOSITY"),
			$.env.get("CLAUDE_MANAGED_TOOLS_PTY"),
			$.env.get("CLAUDE_MANAGED_TOOLS_TIMEOUT"),
			$.env.get("CLAUDE_MANAGED_TOOLS_EXTRA_ENV"),
			$.env.get("CLAUDE_MANAGED_TOOLS_GUARD"),
			$.env.get("CLAUDE_MANAGED_TOOLS_BUSYBOX"),
			$.env.get("SHELL"),
			$.env.get("CLAUDE_CODE_SHELL"),
			$.env.get("HOME"),
			$.env.get("BASH_DEFAULT_TIMEOUT_MS"),
			$.env.get("BASH_MAX_TIMEOUT_MS"),
			$.env.get("CLAUDE_MANAGED_TOOLS_IDLE"),
			$.env.get("CLAUDE_MANAGED_TOOLS_UPDATE"),
			$.env.get("CLAUDE_MANAGED_TOOLS_UNBUFFER"),
			$.env.get("CLAUDE_MANAGED_TOOLS_PRELOAD"),
			$.env.get("CLAUDE_MANAGED_TOOLS_COMPACT_STAMPS"),
			$.env.get("TMPDIR"),
			$.env.get("CLAUDE_MANAGED_TOOLS_STAMP_DIGITS"),
			$.env.get("CLAUDE_MANAGED_TOOLS_LIVE"),
		]);
	return {
		CLAUDE_MANAGED_TOOLS_WRAP: wrap,
		CLAUDE_MANAGED_TOOLS_VERBOSITY: verbosity,
		CLAUDE_MANAGED_TOOLS_PTY: pty,
		CLAUDE_MANAGED_TOOLS_TIMEOUT: timeout,
		CLAUDE_MANAGED_TOOLS_EXTRA_ENV: extraEnv,
		CLAUDE_MANAGED_TOOLS_GUARD: guard,
		CLAUDE_MANAGED_TOOLS_BUSYBOX: busybox,
		SHELL: shell,
		CLAUDE_CODE_SHELL: claudeShell,
		HOME: home,
		BASH_DEFAULT_TIMEOUT_MS: hostDefault,
		BASH_MAX_TIMEOUT_MS: hostMax,
		CLAUDE_MANAGED_TOOLS_IDLE: idle,
		CLAUDE_MANAGED_TOOLS_UPDATE: update,
		CLAUDE_MANAGED_TOOLS_UNBUFFER: unbuffer,
		CLAUDE_MANAGED_TOOLS_PRELOAD: preload,
		CLAUDE_MANAGED_TOOLS_COMPACT_STAMPS: compact,
		TMPDIR: tmpdir,
		CLAUDE_MANAGED_TOOLS_STAMP_DIGITS: digits,
		CLAUDE_MANAGED_TOOLS_LIVE: liveSwitch,
	};
}

/** The settings in force: this session's switches over the environment over the options. */
function settingsFor(env: Env, options: Options): WrapSettings {
	const settings = readWrapSettings(
		env,
		{
			enabled: flag(options.enabled, true),
			verbosity: text(options.verbosity),
			pty: text(options.pty),
			timeoutSeconds: typeof options.timeoutSeconds === "number" ? options.timeoutSeconds : undefined,
			idleSeconds: typeof options.idleSeconds === "number" ? options.idleSeconds : undefined,
			unbuffer: flag(options.unbuffer, true),
			preload: flag(options.preloadStdbuf, false),
			compactStamps: flag(options.compactStamps, true),
			stampDigits: typeof options.stampDigits === "number" ? options.stampDigits : undefined,
			live: flag(options.live, true),
			extraEnv: text(options.extraEnv),
		},
		session.verbosity,
	);
	if (session.pty) settings.pty = session.pty;
	if (session.timeoutSeconds !== undefined) settings.timeoutSeconds = session.timeoutSeconds;
	if (session.idleSeconds !== undefined) settings.idleSeconds = session.idleSeconds;
	if (session.enabled !== undefined) settings.enabled = session.enabled;
	return settings;
}

/** This plugin's data folder, kept across updates; undefined where the host has none. */
async function dataDir($: Engine): Promise<string | undefined> {
	if (session.dataDir) return session.dataDir;
	try {
		const hookEnv = await $.process.hookEnv();
		const dir = hookEnv.CLAUDE_PLUGIN_DATA;
		if (dir) session.dataDir = dir;
		if (hookEnv.CLAUDE_CODE_SESSION_ID) session.sid = hookEnv.CLAUDE_CODE_SESSION_ID;
		return dir;
	} catch {
		return undefined;
	}
}

/** True when the path is a non-empty file: an empty binary "runs" on Linux and fails on macOS. */
async function isBinary($: Engine, path: string): Promise<boolean> {
	try {
		const stat = await $.fs.stat(path);
		return stat.kind === "file" && stat.size > 0;
	} catch {
		return false;
	}
}

/**
 * Find a busybox that can wrap, and remember it.
 *
 * A hit is kept for the session; a miss only for half a minute, so an install made from
 * another terminal is picked up without a restart.
 */
async function locate($: Engine, env: Env, options: Options, isFresh = false): Promise<Located> {
	const tried = candidatePaths({
		option: text(options.busybox),
		env: env.CLAUDE_MANAGED_TOOLS_BUSYBOX,
		dataDir: await dataDir($),
		home: env.HOME,
	});
	const key = tried.join("\n");
	const cached = session.located;
	if (!isFresh && cached && cached.key === key && (cached.found || Date.now() - cached.at < 30_000)) return cached;
	let found: Found | undefined;
	let failed: Located["failed"];
	for (const path of tried) {
		if (!(await isBinary($, path))) continue;
		try {
			const asked = await $.process.run([path, "--caps", "--format", "json"], { timeoutMs: 5_000 });
			const caps = parseCaps(asked.stdout);
			if (asked.exitCode !== 0 || !caps.ok) continue;
			// What a build declares is not what it does: one wrapped `echo`, with the flags
			// a real command gets, before any command is trusted to it. A build that fails
			// is passed over — running commands as written beats failing every one.
			const abilities = abilitiesOf(caps.features);
			const probe = readProbe(await $.process.run(probeArgv(path, abilities), { timeoutMs: 15_000 }));
			if (!probe.ok) {
				failed ??= { path, reason: probe.reason ?? "no reason given" };
				continue;
			}
			found = { path, version: caps.version, features: caps.features, abilities, stamp: probe.stamp, header: probe.header };
			break;
		} catch {
			// Not runnable here (wrong architecture, no exec bit): try the next one.
		}
	}
	session.located = { found, tried, at: Date.now(), key, ...(failed && !found ? { failed } : {}) };
	return session.located;
}

/** The shell the wrapped child runs in: the one Claude Code itself would have used. */
async function pickShell($: Engine, env: Env): Promise<string> {
	// Once Claude Code is pointed at the shim, the environment names the shim: the real
	// shell is the one the shim was set up around.
	if (session.shim) return session.shim.real;
	if (session.shell) return session.shell;
	for (const candidate of shellCandidates(env)) {
		if (await $.fs.exists(candidate).catch(() => false)) {
			session.shell = candidate;
			return candidate;
		}
	}
	return "/bin/sh";
}

/** After a switch changed: bring the shim's file into line, standing the shim up if it never was. */
async function refreshShim($: Engine, options: Options): Promise<void> {
	try {
		const env = await readEnv($);
		if (!session.shim && settingsFor(env, options).enabled && (await locate($, env, options)).found) {
			await setupShim($, env, options);
		}
		await writeShimConf($, env, options);
	} catch {
		// The switch itself took effect; a stale file only leaves `!` as it was.
	}
}

/** Lowercase hex sha256 of a text, as `busybox sha256sum` prints it. */
async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The person's real shell, when the environment may already name the shim.
 *
 * A reload runs `session.start` again in a process whose `CLAUDE_CODE_SHELL` this plugin
 * set earlier, so the session's own file is asked first, then every candidate that is not
 * the shim itself.
 */
async function realShell($: Engine, env: Env, dir: string, sid: string): Promise<string | undefined> {
	const isOurs = (path: string) => path.startsWith(`${dir}/`);
	try {
		const kept = /^PT_REAL='([^']+)'$/m.exec(await $.fs.read(`${dir}/conf-${sid}.sh`))?.[1];
		if (kept && !isOurs(kept) && (await $.fs.exists(kept))) return kept;
	} catch {
		// No file for this session yet: the usual first start.
	}
	for (const candidate of shellCandidates(env)) {
		if (!isOurs(candidate) && (await $.fs.exists(candidate).catch(() => false))) return candidate;
	}
	return undefined;
}

/** Write what the shim reads for this session: on or off, and the capture's exact flags. */
async function writeShimConf($: Engine, env: Env, options: Options): Promise<void> {
	const shim = session.shim;
	if (!shim) return;
	const settings = settingsFor(env, options);
	const { found } = await locate($, env, options);
	const flags = found ? captureFlags(found, settings) : { stampNs: false, idleSeconds: 0 };
	// The silence limit rides with a deadline, as it does in pi: with the deadline off a
	// `!` command is the person's to time, and "runs until it finishes" has to be true.
	const capture = { ...flags, idleSeconds: settings.timeoutSeconds > 0 ? flags.idleSeconds : 0 };
	const base = {
		...capture,
		busybox: found?.path ?? "",
		verbosity: settings.verbosity,
		extraEnv: settings.extraEnv,
		...(await streamOptions($, settings)),
		// The default deadline covers the person's own commands too. A `!` launch carries
		// no `timeout` parameter for the applet's deadline to stay under, so the number
		// goes to the applet as it is.
		...(settings.timeoutSeconds > 0 ? { timeoutSeconds: settings.timeoutSeconds } : {}),
	};
	session.bang = { timeoutSeconds: settings.timeoutSeconds, idleSeconds: capture.idleSeconds };
	await $.fs.write(
		`${shim.dir}/conf-${shim.sid}.sh`,
		confText({
			enabled: settings.enabled && found !== undefined,
			real: shim.real,
			busybox: base.busybox,
			run: runPrefix({ ...base, pty: settings.pty }),
			runNoPty: runPrefix({ ...base, pty: "off" }),
			hasPty: settings.pty !== "off",
		}),
	);
}

/**
 * Point Claude Code at the shim, so a command typed with `!` runs inside the capture.
 *
 * Each step that fails leaves Claude Code on the person's own shell: the shim is only
 * named once the script, its mode and this session's file are all in place.
 */
async function setupShim($: Engine, env: Env, options: Options): Promise<void> {
	if (session.shim || !flag(options.wrapBang, true)) return;
	const data = await dataDir($);
	const sid = session.sid;
	if (!data || !sid) {
		session.shimProblem = "this session has no plugin data folder or no session id";
		return;
	}
	const dir = shimDir(data);
	const real = await realShell($, env, dir, sid);
	if (!real) {
		session.shimProblem = "no bash or zsh was found to stand behind the shim";
		return;
	}
	const path = `${dir}/${shimName(real)}`;
	try {
		await $.fs.write(path, SHIM_SOURCE);
		const mode = await $.process.run(["chmod", "755", path]);
		if (mode.exitCode !== 0) throw new Error(mode.stderr.trim() || "chmod failed");
		session.shim = { dir, path, real, sid };
		await writeShimConf($, env, options);
		const set = (await $.env.set("CLAUDE_CODE_SHELL", path)) as { deny?: string };
		if (set.deny !== undefined) throw new Error(set.deny);
		session.shimProblem = undefined;
		// Each session leaves two small files here; sweep the ones no live session can
		// still be reading. Only this folder, only these two names, and never a failure.
		void $.process
			.run(["find", dir, "-maxdepth", "1", "-type", "f", "(", "-name", "conf-*.sh", "-o", "-name", "draft-*", ")", "-mtime", "+7", "-delete"])
			.catch(() => undefined);
	} catch (error) {
		session.shim = undefined;
		session.shimProblem = error instanceof Error ? error.message : String(error);
	}
}

/**
 * Keep the hash of what is in the prompt box where the shim can read it.
 *
 * Only a hash: the draft itself is never written. An empty box is not recorded, because
 * pressing Enter empties it while the shell that needs the hash is still starting.
 */
function noteDraft($: Engine, draft: string): void {
	const shim = session.shim;
	if (!shim) return;
	const keys = draftKeys(draft);
	if (keys.length === 0) return;
	session.draft = session.draft
		.then(async () => {
			const hashes = await Promise.all(keys.map(sha256));
			await $.fs.write(`${shim.dir}/draft-${shim.sid}`, hashes.join(" "));
		})
		.catch(() => undefined);
}

/**
 * The Ruby and Perl preludes, written once into the data folder.
 *
 * Each is only handed to the wrapper when its file is there: a RUBYOPT or PERL5OPT that
 * names a missing file makes every ruby, or every perl, fail to start. Neither variable
 * can carry a path with a space (both are split on whitespace), so such a folder gets no
 * prelude and those two runtimes stay block-buffered.
 */
async function preludes($: Engine): Promise<{ ruby?: string; perl?: string }> {
	if (session.preludes) return session.preludes;
	const kept: { ruby?: string; perl?: string } = {};
	session.preludes = kept;
	const dir = await dataDir($);
	if (!dir || /\s/.test(dir)) return kept;
	const put = async (name: string, text: string) => {
		try {
			if (!(await $.fs.exists(`${dir}/${name}`))) await $.fs.write(`${dir}/${name}`, text);
			return true;
		} catch {
			return false;
		}
	};
	if (await put(RUBY_PRELUDE_NAME, RUBY_PRELUDE)) kept.ruby = `${dir}/${RUBY_PRELUDE_NAME}`;
	if (await put(PERL_PRELUDE_NAME, PERL_PRELUDE)) kept.perl = dir;
	return kept;
}

/** `stdbuf`'s preload library, looked for once, and only when the person asked for it. */
async function stdbufLib($: Engine): Promise<string | undefined> {
	if (session.stdbufLib !== undefined) return session.stdbufLib ?? undefined;
	session.stdbufLib = null;
	for (const path of STDBUF_LIBS) {
		if (await $.fs.exists(path).catch(() => false)) {
			session.stdbufLib = path;
			break;
		}
	}
	return session.stdbufLib ?? undefined;
}

/** `uname -s`, lowercased and asked once: which C library a command will meet. */
async function platform($: Engine): Promise<string | undefined> {
	if (session.platform !== undefined) return session.platform ?? undefined;
	session.platform = null;
	try {
		const ran = await $.process.run(["uname", "-s"], { timeoutMs: 5_000 });
		const name = ran.exitCode === 0 ? ran.stdout.trim().toLowerCase() : "";
		if (/^[a-z0-9_-]+$/.test(name)) session.platform = name;
	} catch {
		// Not known: the model is told the conservative version.
	}
	return session.platform ?? undefined;
}

/** `/pi-time status`: what is switched off, by which means, and what is left. */
async function describeBuffering($: Engine, settings: WrapSettings): Promise<string> {
	if (!settings.unbuffer) return "- buffering: left to each program (`unbuffer` is off): a stage inside a pipeline, or output to a file, may arrive late";
	const streams = await streamOptions($, settings);
	const os = await platform($);
	const scripted = [
		"Python",
		...(streams.rubyPrelude ? ["Ruby"] : []),
		...(streams.perlPrelude ? ["Perl"] : []),
		"Lua",
	].join(", ");
	const missing = streams.rubyPrelude && streams.perlPrelude ? "" : " (no Ruby or Perl prelude could be written to the data folder)";
	const cStdio =
		os === "darwin" || os === "freebsd"
			? "and every C-stdio program (`STDBUF1=L`: grep, sed, awk, jq, compiled C and Swift)"
			: streams.stdbufLib
				? `and dynamically linked C-stdio programs, through \`LD_PRELOAD\` of \`${streams.stdbufLib}\``
				: settings.preload
					? "; `preloadStdbuf` is on, but no `libstdbuf.so` from GNU coreutils was found, so C-stdio programs on a pipe still write in blocks"
					: "; C-stdio programs (grep, sed, awk, compiled C) on a pipe still write in blocks here — the `preloadStdbuf` option preloads `stdbuf`'s library for them";
	return `- buffering: switched off for ${scripted}${missing} ${cStdio}`.replace(" ;", ";");
}

/**
 * What switches buffering off for this call: the preludes that are on disk and, where
 * asked for and found, the preload. With the setting off, nothing.
 */
async function streamOptions(
	$: Engine,
	settings: WrapSettings,
): Promise<{ unbuffer: boolean; rubyPrelude?: string; perlPrelude?: string; stdbufLib?: string }> {
	if (!settings.unbuffer) return { unbuffer: false };
	const { ruby, perl } = await preludes($);
	const lib = settings.preload ? await stdbufLib($) : undefined;
	return {
		unbuffer: true,
		...(ruby ? { rubyPrelude: ruby } : {}),
		...(perl ? { perlPrelude: perl } : {}),
		...(lib ? { stdbufLib: lib } : {}),
	};
}

/**
 * The flags a newer build earns, each asked for only if this binary says it has it.
 *
 * An older build — pi's copy, a pinned path — is handed nothing it does not know.
 */
function captureFlags(found: Found, settings: WrapSettings): { stampNs: boolean; idleSeconds: number } {
	return {
		stampNs: found.abilities.stampNs,
		idleSeconds: found.abilities.idleTimeout ? settings.idleSeconds : 0,
	};
}

/**
 * Begin watching one call: where its command will report itself, and what limit applies.
 *
 * Undefined when there is nothing to watch with — the setting is off, there is no data
 * folder, or such calls have already shown that they cannot report themselves.
 */
async function openLive($: Engine, callId: string, kind: string, settings: WrapSettings): Promise<Live | undefined> {
	if (!settings.live || session.liveWorks.get(kind) === false) return undefined;
	const dir = await dataDir($);
	if (!dir) return undefined;
	if (!session.hasLiveDir) {
		// `fs.write` makes the folder; the command's shell cannot be asked to.
		await $.fs.write(`${liveDir(dir)}/.keep`, "");
		session.hasLiveDir = true;
	}
	const now = await $.clock.now();
	return {
		file: liveFile(dir, callId),
		kind,
		startedAt: now,
		sizes: { stdout: 0, stderr: 0 },
		tail: new LiveTail(),
		hasOutput: false,
		lastOutputAt: now,
		meter: new CpuMeter(),
		isGroupSeen: false,
		idleMs: settings.idleSeconds * 1000,
		timers: [],
		ticks: 0,
		isPolling: false,
		isDone: false,
	};
}

/** Start the clock on a watch: nothing is read until the command has run for a moment. */
function watch($: Engine, live: Live): void {
	live.timers.push(
		$.clock.after(LIVE_DELAY_MS, () => {
			if (live.isDone) return;
			live.timers.push($.clock.every(LIVE_INTERVAL_MS, () => void look($, live).catch(() => undefined)));
			void look($, live).catch(() => undefined);
		}),
	);
}

/** Stop watching: the command has ended, or cannot be watched. */
function closeLive(live: Live): void {
	live.isDone = true;
	for (const timer of live.timers) timer.cancel();
	live.timers = [];
}

/**
 * Look at a running command once: new output, the processor, and whether it is stuck.
 *
 * Never in front of the command: this runs on a timer while the call is awaited, and a
 * look that is still under way when the next is due is skipped.
 */
async function look($: Engine, live: Live): Promise<void> {
	// Once it has been told to stop there is nothing more to decide, and it is told once.
	if (live.isPolling || live.isDone || live.stopped) return;
	live.isPolling = true;
	try {
		const now = await $.clock.now();
		if (!live.pointer) {
			const reported = await $.fs.read(live.file).catch(() => "");
			live.pointer = parsePointer(typeof reported === "string" ? reported : "");
			if (!live.pointer) {
				// Never reported itself: a sandbox that cannot write here, most likely. Such
				// calls are not watched again, and get the applet's own silence limit instead.
				if (now - live.startedAt > LIVE_GIVE_UP_MS) {
					session.liveWorks.set(live.kind, false);
					closeLive(live);
				}
				return;
			}
			session.liveWorks.set(live.kind, true);
		}
		const pointer = live.pointer;
		let hasGrown = false;
		for (const stream of ["stdout", "stderr"] as const) {
			const path = `${pointer.runDir}/${stream}`;
			const size = (await $.fs.stat(path).catch(() => undefined))?.size ?? 0;
			if (size <= live.sizes[stream]) continue;
			const from = Math.max(live.sizes[stream], size - LIVE_READ_BYTES);
			const added = await $.fs.read(path, { offset: from, length: size - from }).catch(() => "");
			live.sizes[stream] = size;
			if (typeof added === "string") live.tail.push(added);
			hasGrown = true;
		}
		if (hasGrown) {
			live.hasOutput = true;
			live.lastOutputAt = now;
			live.meter.sawOutput();
		}
		if (live.ticks++ % CPU_EVERY === 0) {
			const listed = await $.process.run([...PS_ARGV], { timeoutMs: 5_000 }).catch(() => undefined);
			const seconds = listed?.exitCode === 0 ? groupCpuSeconds(listed.stdout, pointer.pgid) : undefined;
			live.isGroupSeen = seconds !== undefined;
			live.meter.sample(seconds, now);
		}
		const cpu = cpuOf(live, now);
		const silentMs = now - live.lastOutputAt;
		const watchedFrom = Math.max(live.meter.since() ?? now, live.lastOutputAt);
		// Only a group that `ps` listed a moment ago is ever signalled.
		if (live.isGroupSeen && isStuck({ silentMs, idleMs: live.idleMs, cpu, cpuWatchedMs: now - watchedFrom })) {
			live.stopped = { seconds: Math.round(silentMs / 1000), ...(cpu ? { cpuSeconds: cpu.sinceOutput } : {}) };
			session.stuck++;
			const group = `-${pointer.pgid}`;
			await $.process.run(["kill", "-TERM", "--", group], { timeoutMs: 5_000 }).catch(() => undefined);
			// A command that ignores the request is not left running behind a result that says it was stopped.
			live.timers.push($.clock.after(3000, () => void (live.isDone ? undefined : $.process.run(["kill", "-KILL", "--", group], { timeoutMs: 5_000 }).catch(() => undefined))));
			return;
		}
		$.ui.invalidate("ui.render");
	} finally {
		live.isPolling = false;
	}
}

/** The processor reading of a watched command, or undefined once it has gone stale. */
function cpuOf(live: Live, now: number): CpuReading | undefined {
	return live.meter.reading(now, LIVE_INTERVAL_MS * CPU_EVERY * 3);
}

/**
 * How many stderr lines a run captured in all, from `log --summary`.
 *
 * Undefined when it cannot be asked or the answer is not about this run: run ids are
 * counters per artifact root, and a sandboxed call may keep its captures in another root
 * than this process would look in — so the root is named when the run reported it, and
 * the duration must match the header's either way.
 */
async function stderrLines($: Engine, found: Found, header: RunHeader, facts: RunFacts | undefined): Promise<number | undefined> {
	if (!found.abilities.logQuery) return undefined;
	const root = runRootOf(facts?.runDir);
	const asked = await $.process
		.run([found.path, "log", ...(root ? ["-D", root] : []), header.runId, "--summary"], { timeoutMs: 5_000 })
		.catch(() => undefined);
	if (!asked || asked.exitCode !== 0) return undefined;
	const count = / stderr=(\d+)\b/.exec(asked.stdout)?.[1];
	const duration = / duration_ms=(\d+)\b/.exec(asked.stdout)?.[1];
	if (count === undefined) return undefined;
	if (header.durationMs !== undefined && duration !== String(header.durationMs)) return undefined;
	return Number(count);
}

interface Settle {
	/** The wrapped result as `run` printed it, housekeeping already dropped. */
	body: string;
	/** The command as it was written, for the notes on what it hid. */
	command: string;
	found: Found;
	settings: WrapSettings;
	/** The deadline this run was given, in seconds. */
	budgetSeconds: number;
	/** The silence limit it was given; 0 for none. */
	idleSeconds: number;
	/** A command the person ran themselves (`!`, `/sh`). */
	isPersons?: boolean;
	/** What the guest shell reported about how it ended, when it did. */
	facts?: RunFacts;
	/** Whether the final directory was carried back to the host's shell. */
	cwdCarried: boolean;
	/** The call ran outside the capture (`# pitime-raw`), so there is no timeline to read. */
	escaped?: boolean;
	/** What the watch saw of the processor, when the command ran long enough to be watched. */
	cpu?: CpuReading;
	/** Set when the watch stopped the command for showing no sign of life. */
	stuck?: { seconds: number; cpuSeconds?: number };
}

/**
 * A wrapped result as the model reads it: how it ended first, when that was not the
 * command's own exit; then the timeline; then the digest, the pointer into a truncated
 * view, and the notes on what the command hid.
 *
 * The notice goes first because of what came before it otherwise: a timeout opened with
 * `exit_code=-1`, then up to 24 KB of output, and only then said that nothing had failed.
 */
async function settle($: Engine, input: Settle): Promise<string> {
	const { body, found } = input;
	const busybox = shellValue(found.path);
	const header = parseHeader(body);
	const after: string[] = [];
	// A one-liner is not a timing problem: only a run long enough to have shape earns the line.
	const summary = summarizeTiming(parseTimeline(body), header?.durationMs ?? parseDurationMs(body));
	if (summary) after.push(summary);
	// A truncated view is only useful if the model can say what it wants next — and only
	// honest if it says whether the part it lacks holds errors.
	const stderrTotal = header?.truncated ? await stderrLines($, found, header, input.facts) : undefined;
	const hint = truncationHint(body, busybox, { stderrTotal });
	if (hint) after.push(hint);
	// What the command hid from its own result — or, where the run reported it, what
	// actually happened: each pipeline stage's status.
	after.push(
		...resultNotes(input.command, {
			cwdCarried: input.cwdCarried,
			escaped: input.escaped,
			seen: session.seenNotes,
			facts: input.facts,
			exitCode: header?.exitCode,
		}),
	);
	// A timeout must not be mistaken for a failure: say what happened and what to do.
	const notice = outcomeNotice(
		body,
		input.budgetSeconds,
		busybox,
		input.idleSeconds > 0 ? input.idleSeconds : undefined,
		input.isPersons === true,
		// The one mode where a read on stdin waits (measured); a `!` command's stdin is the host's own `/dev/null`.
		input.settings.pty === "raw" && input.isPersons !== true,
		{
			cpu: cpuSentence(input.cpu, header?.durationMs === undefined ? undefined : header.durationMs / 1000),
			...(input.stuck ? { stuck: input.stuck } : {}),
		},
	);
	// What the model reads of the capture itself: a header with only what says something,
	// and each offset once and no more precisely than it is read. Every parser above read
	// the capture as `run` printed it; this is the last step.
	const shown = header
		? compactStamps(slimHeader(body), { digits: input.settings.stampDigits, burst: input.settings.compactStamps })
		: body;
	const root = runRootOf(input.facts?.runDir);
	if (root) session.roots.add(root);
	// With one stamp per burst a note has no mark of its own to tell it from output.
	return [...(notice ? [notice] : []), shown, ...(header && after.length > 0 ? [NOTES_MARKER] : []), ...after].join("\n");
}

/**
 * Remove old captures from one artifact root: beyond the newest RUN_RETENTION, and only
 * once they are RUN_MIN_AGE_MINUTES old.
 *
 * Every path handed to `rm` is spelled out here: `<root>/R<digits>`, a real folder (not a
 * link), under a folder named `busybox-run`. Nothing else in the root is looked at.
 */
async function sweepRoot($: Engine, root: string): Promise<number> {
	if (!isRunRoot(root)) return 0;
	const listed = await $.process.run(["ls", "-1t", root], { timeoutMs: 10_000 });
	if (listed.exitCode !== 0) return 0;
	const now = Date.now();
	const stale: string[] = [];
	for (const name of excessRuns(listed.stdout.split("\n"), RUN_RETENTION)) {
		const path = `${root}/${name}`;
		const stat = await $.fs.stat(path).catch(() => undefined);
		if (stat?.kind === "dir" && !stat.isLink && isStale(stat.mtimeMs, now, RUN_MIN_AGE_MINUTES * 60_000)) stale.push(path);
	}
	for (let i = 0; i < stale.length; i += 100) {
		await $.process.run(["rm", "-rf", "--", ...stale.slice(i, i + 100)], { timeoutMs: 30_000 });
	}
	return stale.length;
}

/** One more wrapped command: counted, and every so often the captures are swept behind it. */
function noteWrapped($: Engine, env: Env): void {
	session.wrapped++;
	if (session.wrapped % SWEEP_EVERY === 0) sweep($, env);
}

/** Sweep every root this session has run in, behind the session and never in front of a command. */
function sweep($: Engine, env: Env): void {
	const roots = new Set([defaultRunRoot(env.TMPDIR), ...session.roots]);
	void (async () => {
		for (const root of roots) session.swept += await sweepRoot($, root).catch(() => 0);
	})();
}

/** A Bash result as the transcript stores it, as far as this module reads it. */
interface BashOutput {
	stdout: string;
	stderr: string;
}

function isBashOutput(value: unknown): value is BashOutput {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as BashOutput).stdout === "string" &&
		typeof (value as BashOutput).stderr === "string"
	);
}

/**
 * A good result with the guest's facts line taken out of it, wherever the host put it.
 *
 * The outer shell writes that line to stderr. Measured, Claude Code's Bash hands stderr
 * back inside `stdout`, after what the command printed there; a host that keeps the two
 * apart would leave it in `stderr`. Both are looked in, and neither keeps the line.
 */
function takeOutput(output: BashOutput): { text: string; stderr: string; facts?: RunFacts } {
	const out = takeFacts(output.stdout);
	const err = takeFacts(output.stderr ?? "");
	return { text: out.text, stderr: err.text, facts: out.facts ?? err.facts };
}

/** The command's own lines, for a person: an empty result stays empty, not "(no output)". */
function plain(body: string): string {
	const stripped = stripTimeline(body);
	return stripped === "(no output)" ? "" : stripped;
}

/**
 * What a tool row draws from, with the wrapper's decoration taken off.
 *
 * Returns the same value when there is nothing to take off, so the caller can leave the
 * drawing to the engine untouched.
 */
function forDisplay(output: unknown): unknown {
	if (typeof output === "string") return hasTimeline(output) ? stripTimeline(output) : output;
	if (isBashOutput(output) && hasTimeline(output.stdout)) return { ...output, stdout: plain(output.stdout) };
	return output;
}

function describePty(mode: PtyMode): string {
	switch (mode) {
		case "off":
			return "plain pipes, isatty() false, byte-exact";
		case "merged":
			return "one pty for 0/1/2, streams merged";
		case "raw":
			return "one pty with the line discipline off";
		default:
			return "stdout on a pty (line-buffered, real timing), stderr on a pipe";
	}
}

/** `/pi-time status`. */
async function status($: Engine, options: Options): Promise<string> {
	const env = await readEnv($);
	const settings = settingsFor(env, options);
	const located = await locate($, env, options, true);
	const lines: string[] = [];
	if (!settings.enabled) lines.push("Pi-Time is **off**: Bash runs exactly as Claude Code runs it. `/pi-time on` turns it back on.");
	else if (!located.found && located.failed) {
		lines.push(
			`Pi-Time is on but **not wrapping**: the busybox at \`${located.failed.path}\` failed its self-test (${located.failed.reason}), so Bash runs as written. \`/pi-time install\` replaces the plugin's own copy.`,
		);
	} else if (!located.found) lines.push("Pi-Time is on but **not wrapping**: no busybox build with `run` was found. `/pi-time install` fetches one.");
	else lines.push(`Pi-Time is **on**: ${session.wrapped} command(s) wrapped this session.`);
	if (located.found) {
		const dir = await dataDir($);
		const installed = readInstallState(await $.store.get(STORE_INSTALLED).catch(() => undefined));
		const isOurs = dir !== undefined && located.found.path === installedPath(dir);
		const release = isOurs && installed ? `release ${installed.tag}, ` : isOurs ? "" : "not this plugin's own copy, ";
		lines.push(`- busybox: \`${located.found.path}\` (${release}busybox ${located.found.version ?? "version unknown"})`);
		const { stampNs, idleTimeout, logQuery } = located.found.abilities;
		lines.push(
			`- this build: ${stampNs ? "nanosecond offsets" : "microsecond offsets"}, ${idleTimeout ? "idle timeout available" : "no idle timeout"}, ${logQuery ? "log queries (`--sample`, `--since`, `--around-gap`)" : "basic log only"}`,
		);
	} else {
		lines.push(`- busybox: looked in ${located.tried.map((path) => `\`${path}\``).join(", ") || "nowhere (no data folder, no HOME)"}`);
	}
	if (session.updateNote) lines.push(`- last update check: ${session.updateNote}`);
	lines.push(
		`- view: ${settings.verbosity} — ${describeVerbosity(settings.verbosity)}${settings.verbosity === "brief" ? "" : `; offsets to ${settings.stampDigits} decimal${settings.stampDigits === 1 ? "" : "s"}, ${settings.compactStamps ? "one stamp per burst (a line at the offset and on the stream of the one above carries none)" : "a stamp on every line (`compactStamps` is off)"}`}`,
	);
	lines.push(
		`- captures: kept in \`${defaultRunRoot(env.TMPDIR)}\` for \`busybox log\` — at least ${RUN_MIN_AGE_MINUTES / 60} hours, and the newest ${RUN_RETENTION} for longer (${session.swept} removed by this session)`,
	);
	lines.push(
		settings.idleSeconds > 0
			? located.found?.abilities.idleTimeout === false
				? `- silence: ${settings.idleSeconds}s asked for, but this build has no idle timeout`
				: `- silence: a command that prints nothing on either stream for ${settings.idleSeconds}s is stopped as \`IDLE\`, whatever its deadline${settings.timeoutSeconds > 0 ? "" : " (not your own `!` commands while the deadline is off)"} (\`/pi-time idle <seconds|off>\` changes it for this session)`
			: "- silence: a quiet command is left to run to its deadline (`/pi-time idle <seconds>` sets a limit)",
	);
	lines.push(
		session.isPtyRefused && settings.pty !== "off"
			? `- terminal: ${settings.pty}, but the sandbox refuses a pseudo-terminal, so sandboxed commands run on plain pipes (offsets of a block-buffering program are its flushes)`
			: `- terminal: ${settings.pty} — ${describePty(settings.pty)}`,
	);
	lines.push(
		!settings.live
			? "- while a command runs: nothing is shown until it ends (`live` is off), and silence alone decides whether it is stuck"
			: [...session.liveWorks.values()].includes(false)
				? "- while a command runs: its newest lines and a sign of life under its row — but not for sandboxed commands here, which cannot report themselves and are judged by silence alone"
				: `- while a command runs: its newest lines and a sign of life under its row; it is stopped as stuck only when it has neither printed nor used the processor for the silence limit (${session.stuck} stopped this session)`,
	);
	lines.push(await describeBuffering($, settings));
	lines.push(
		settings.timeoutSeconds > 0
			? `- deadline: ${settings.timeoutSeconds}s for every command that names none — a tool call with no \`timeout\`, and your own \`!\` and \`/sh\` commands (\`/pi-time timeout <seconds|off>\` changes it for this session)`
			: "- deadline: none of Pi-Time's — Claude Code's own default for a tool call that names none, and no deadline on your own commands (`/pi-time timeout <seconds>` sets one)",
	);
	lines.push(
		`- guard: ${guardEnabled(env, flag(options.guard, true)) ? "on" : "off"} — a stream merge at a command's tail, and a command that cannot end here (a pager, \`tail -f\`, a foreground server), are refused before they run (${session.blocked} refused this session)`,
	);
	lines.push(`- cd between calls: ${flag(options.carryCwd, true) ? "kept" : "not kept"}`);
	lines.push(`- on screen: ${flag(options.cleanDisplay, true) ? "the command's own output (the model reads the timeline)" : "the timeline, as the model reads it"}`);
	if (session.refused > 0) lines.push(`- ${session.refused} wrapped call(s) were refused by another hook or rule and did not run`);
	lines.push(
		session.shim
			? `- your own commands: \`!command\` runs in ${session.shim.real} inside the capture (Claude Code's shell is the shim at \`${session.shim.path}\`); \`/sh <command>\` does the same and keeps the timeline off your screen`
			: `- your own commands: \`/sh <command>\` runs through the capture; \`!command\` does not (${flag(options.wrapBang, true) ? (session.shimProblem ?? "the shell shim is not set up while Pi-Time is not wrapping") : "the `wrapBang` option is off"})`,
	);
	lines.push("", "`/pi-time on|off` · `/pi-time verbosity quiet|normal|verbose|brief` · `/pi-time pty split|off|merged|raw` · `/pi-time update`");
	return lines.join("\n");
}

/**
 * `/pi-time install`: fetch this machine's busybox-static build into the data folder.
 *
 * Fails closed: no published sha256, or a mismatch, and nothing is installed. The file is
 * only moved into place after it has answered `--caps` as a build that can wrap.
 */
async function install($: Engine, options: Options, isForced = true): Promise<string> {
	const dir = await dataDir($);
	if (!dir) return "Cannot install: this session has no plugin data folder.";
	const [system, machine] = await Promise.all([$.process.run(["uname", "-s"]), $.process.run(["uname", "-m"])]);
	const target = busyboxTarget(system.stdout, machine.stdout);
	if (!target) return `Cannot install: there is no busybox-static build for ${system.stdout.trim()} ${machine.stdout.trim()}.`;
	const release = await $.http.fetch(BUSYBOX_RELEASE_URL, {
		headers: { accept: "application/vnd.github+json", "user-agent": "pi-time-plugin" },
	});
	if (!release.ok) return `Cannot install: GitHub answered ${release.status} for the latest release.`;
	const asset = pickAsset(release.text, target);
	if (!asset) return `Cannot install: the latest release has no asset for ${target}.`;
	if (!asset.sha256) return `Not installed: ${asset.name} has no published sha256, so it cannot be verified.`;
	const dest = installedPath(dir);
	// GitHub was asked and answered: that is a check, whatever follows.
	await $.store.set(STORE_CHECKED, Date.now()).catch(() => undefined);
	const installed = readInstallState(await $.store.get(STORE_INSTALLED).catch(() => undefined));
	if (!isForced && !needsInstall({ latest: asset, installed, hasBinary: await isBinary($, dest) })) {
		return `Up to date: ${asset.tag} (${asset.name}) is installed at \`${dest}\`.`;
	}
	// Per process, so two sessions starting together cannot write over each other's download.
	const download = `${dest}.download-${session.sid ?? Date.now()}`;
	const fail = async (why: string) => {
		await $.process.run(["rm", "-f", download]).catch(() => undefined);
		return why;
	};
	await $.process.run(["mkdir", "-p", dest.slice(0, dest.lastIndexOf("/"))]);
	// curl where there is one; a minimal Linux image often has only wget. A command that
	// cannot be started rejects, which is what tells "no curl here" from "curl failed".
	const fetched = await $.process
		.run(["curl", "-fsSL", "--proto", "=https", "--tlsv1.2", "-o", download, asset.url], { timeoutMs: 180_000 })
		.catch(() => $.process.run(["wget", "-q", "--https-only", "-O", download, asset.url], { timeoutMs: 180_000 }))
		.catch(() => undefined);
	if (!fetched) return fail("Not installed: neither curl nor wget is available to download with.");
	if (fetched.exitCode !== 0) return fail(`Not installed: the download failed (${fetched.stderr.trim() || `exit ${fetched.exitCode}`}).`);
	let sum = await $.process.run(["shasum", "-a", "256", download]).catch(() => undefined);
	if (!sum || sum.exitCode !== 0) sum = await $.process.run(["sha256sum", download]).catch(() => undefined);
	const actual = sum && sum.exitCode === 0 ? parseShaOutput(sum.stdout) : undefined;
	if (!actual) return fail("Not installed: no sha256 tool (shasum, sha256sum) to verify the download with.");
	if (actual !== asset.sha256) return fail(`Not installed: sha256 mismatch for ${asset.name} (expected ${asset.sha256}, got ${actual}).`);
	await $.process.run(["chmod", "755", download]);
	const probe = await $.process.run([download, "--caps", "--format", "json"], { timeoutMs: 5_000 }).catch(() => undefined);
	const caps = probe && probe.exitCode === 0 ? parseCaps(probe.stdout) : undefined;
	if (!caps?.ok) return fail(`Not installed: ${asset.name} does not run here, or has no \`run\` applet.`);
	const moved = await $.process.run(["mv", "-f", download, dest]);
	if (moved.exitCode !== 0) return fail(`Not installed: could not move the binary into place (${moved.stderr.trim()}).`);
	const state: InstallState = { tag: asset.tag, asset: asset.name, sha256: asset.sha256, installedAt: Date.now() };
	await $.store.set(STORE_INSTALLED, state).catch(() => undefined);
	// The binary in use may have just changed under this session: look again, and bring the
	// shim's flags into line with what the new build can do.
	session.located = undefined;
	const located = await locate($, await readEnv($), options, true);
	await refreshShim($, options);
	const inUse = located.found?.path === dest ? "It is the one in use." : `In use: \`${located.found?.path ?? "none"}\` (an explicit path comes first).`;
	const was = installed && installed.tag !== asset.tag ? ` (was ${installed.tag})` : "";
	return `Installed ${asset.name} from ${asset.tag}${was}, busybox ${caps.version ?? "?"}, sha256 verified, at \`${dest}\`. ${inUse}`;
}

/**
 * Keep the plugin's own copy at the latest release, without holding a session up.
 *
 * Asked at most once a day, and at once when there is no copy at all. Runs behind the
 * session: a failure (no network, a rate limit, a mismatch) leaves whatever binary was
 * in use in use, and is said only in the debug log and `/pi-time status`.
 */
function autoUpdate($: Engine, options: Options, env: Env): void {
	if (session.update || !flag(options.autoUpdate, true) || isOffValue(env.CLAUDE_MANAGED_TOOLS_UPDATE)) return;
	session.update = (async () => {
		const dir = await dataDir($);
		if (!dir) return "no data folder";
		const checkedAt = await $.store.get(STORE_CHECKED).catch(() => undefined);
		const hasBinary = await isBinary($, installedPath(dir));
		if (!isCheckDue({ now: Date.now(), checkedAt: typeof checkedAt === "number" ? checkedAt : undefined, hasBinary })) return "not due";
		const outcome = await install($, options, false);
		if (outcome.startsWith("Installed ")) $.ui.toast(`Pi-Time: ${outcome.split(",")[0]}`);
		return outcome;
	})()
		.catch((error: unknown) => `update check failed: ${error instanceof Error ? error.message : String(error)}`)
		.then((outcome) => {
			session.updateNote = outcome;
			$.ui.log(`busybox update: ${outcome}`, { to: "debug" });
			return outcome;
		});
}

function isOffValue(raw: string | undefined): boolean {
	const value = (raw ?? "").trim().toLowerCase();
	return value === "0" || value === "off" || value === "false" || value === "no";
}

export const register: Register = (on, options) => {
	on("session.start", async ($, e, next) => {
		const startedSession = await next(e);
		try {
			await $.command.register({
				name: COMMAND,
				description: "Pi-Time: show or change how Bash results are timestamped (status, on, off, verbosity, pty, timeout, idle, update, install)",
			});
			await $.command.register({ name: "sh", description: SHELL_DESCRIPTION, argumentHint: SHELL_HINT });
			// Warm the lookups, so the first Bash call does not pay for them.
			const env = await readEnv($);
			// A new conversation has read none of the notes: each is given in full once more.
			session.seenNotes.clear();
			if (settingsFor(env, options).enabled) {
				const { found } = await locate($, env, options);
				// Captures are no longer pruned by each run (the root is shared): sweep the
				// old ones here, and again every SWEEP_EVERY commands.
				if (found) sweep($, env);
				// A call that was cut short leaves its small report behind; a day is long enough.
				const data = await dataDir($);
				if (data) void $.process.run(["find", liveDir(data), "-maxdepth", "1", "-type", "f", "-mtime", "+1", "-delete"]).catch(() => undefined);
				// The shim is only worth standing up where there is something to wrap with.
				if (found) await setupShim($, env, options);
				// Behind the session, not in front of it: a first start with no binary wraps
				// from the first command after the download lands.
				autoUpdate($, options, env);
			}
		} catch {
			// A session that cannot register a command still gets the wrapper.
		}
		return startedSession;
	});

	/**
	 * Follow the prompt box, so the shim can tell a `!` command from every other launch.
	 *
	 * Neither hook changes anything: the edit is passed on as made, and its hash is written
	 * behind it without holding the keystroke up.
	 */
	on("prompt.edit", async ($, e, next) => {
		const box = await next(e);
		if (session.shim && typeof box?.text === "string") noteDraft($, box.text);
		return box;
	});

	on("prompt.change", ($, e, next) => {
		if (session.shim) noteDraft($, e.text);
		return next(e);
	});

	/**
	 * A `!` command's result, as the session keeps it: the same additions a tool result gets.
	 *
	 * The shim made the output a timeline; this adds the digest, the pointer to the rest of
	 * a truncated view, a deadline's notice and the notes on what the command hid. The row
	 * is one text for the person and the model alike — Claude Code draws it itself and
	 * raises nothing a plugin could draw differently — so both read the timeline.
	 */
	on("session.append", { door: "command" }, async ($, e, next) => {
		if (!session.shim) return next(e);
		const message = e.message as { content?: ReadonlyArray<{ type: string; text?: string }> };
		const whole = (message.content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("");
		const input = bashBlock(whole, "bash-input");
		if (input !== undefined) {
			session.lastInput = input;
			return next(e);
		}
		const output = bashBlock(whole, "bash-stdout");
		if (output === undefined || !hasTimeline(output)) return next(e);
		const found = session.located?.found;
		if (!found) return next(e);
		const bang = session.bang ?? { timeoutSeconds: 0, idleSeconds: 0 };
		const view = await settle($, {
			body: dropHousekeeping(output),
			command: session.lastInput ?? "",
			found,
			settings: settingsFor(await readEnv($), options),
			budgetSeconds: bang.timeoutSeconds,
			idleSeconds: bang.idleSeconds,
			isPersons: true,
			cwdCarried: true,
		});
		const rewritten = { ...e, message: { ...e.message, content: [{ type: "text", text: withStdout(whole, view) }] } };
		return next(rewritten as typeof e);
	}).catch(($, e, next) => next(e));

	on("command.run", { command: COMMAND }, async ($, e) => {
		const [verb = "status", value = ""] = (e.args ?? "").trim().toLowerCase().split(/\s+/);
		switch (verb) {
			case "":
			case "status":
				return { text: await status($, options) };
			case "on":
			case "off":
				session.enabled = verb === "on";
				await refreshShim($, options);
				return { text: await status($, options) };
			case "verbosity":
				if (!(VERBOSITIES as readonly string[]).includes(value)) {
					return { text: `Usage: \`/pi-time verbosity ${VERBOSITIES.join("|")}\`` };
				}
				session.verbosity = value as Verbosity;
				await refreshShim($, options);
				return { text: `Pi-Time view for this session: ${value} — ${describeVerbosity(value as Verbosity)}.` };
			case "pty":
				if (!(PTY_MODES as readonly string[]).includes(value)) {
					return { text: `Usage: \`/pi-time pty ${PTY_MODES.join("|")}\`` };
				}
				session.pty = value as PtyMode;
				await refreshShim($, options);
				return { text: `Pi-Time terminal for this session: ${value} — ${describePty(value as PtyMode)}.` };
			case "idle": {
				// Seconds, or `off`: how long a command may print nothing before it is taken
				// to be stuck, for the rest of this session.
				const seconds = /^(?:off|none|0)$/.test(value) ? 0 : /^\d{1,6}$/.test(value) ? Number(value) : undefined;
				if (seconds === undefined) {
					return { text: "Usage: `/pi-time idle <seconds>` or `/pi-time idle off` — how long a command may print nothing before it is stopped as stuck." };
				}
				session.idleSeconds = seconds;
				await refreshShim($, options);
				const env = await readEnv($);
				const hasIt = (await locate($, env, options)).found?.abilities.idleTimeout !== false;
				return {
					text:
						seconds === 0
							? "Pi-Time silence limit for this session: off. A quiet command runs to its deadline."
							: hasIt
								? `Pi-Time silence limit for this session: ${seconds}s. A command that prints nothing on either stream for that long is stopped as \`IDLE\`, whatever its deadline.`
								: `Pi-Time silence limit for this session: ${seconds}s, but the busybox in use has no idle timeout, so nothing is stopped for silence. \`/pi-time update\` fetches a build that has it.`,
				};
			}
			case "timeout": {
				// Seconds, or `off`: the default deadline for a call that names none and for
				// the person's own `!` and `/sh` commands, for the rest of this session.
				const seconds = /^(?:off|none|0)$/.test(value) ? 0 : /^\d{1,6}$/.test(value) ? Number(value) : undefined;
				if (seconds === undefined) {
					return { text: "Usage: `/pi-time timeout <seconds>` or `/pi-time timeout off` — the default deadline for a command that names none, yours included." };
				}
				session.timeoutSeconds = seconds;
				await refreshShim($, options);
				return {
					text:
						seconds > 0
							? `Pi-Time default deadline for this session: ${seconds}s, for a call that names no \`timeout\` and for your own \`!\` and \`/sh\` commands.`
							: "Pi-Time default deadline for this session: off. A call that names no `timeout` gets Claude Code's own default; your own `!` and `/sh` commands run until they finish (`/sh` to the longest Claude Code allows).",
				};
			}
			case "install":
			case "update":
				// `update` installs only when the latest release differs from what is here;
				// `install` fetches and replaces regardless.
				try {
					if (session.update) await session.update;
					return { text: await install($, options, verb === "install") };
				} catch (error) {
					return { text: `Not installed: ${error instanceof Error ? error.message : String(error)}` };
				}
			default:
				return { text: "Usage: `/pi-time [status|on|off|verbosity <level>|pty <mode>|timeout <seconds|off>|idle <seconds|off>|update|install]`" };
		}
	});

	/**
	 * `/sh <command>`: the person's own command, through the capture.
	 *
	 * The host's `!` prefix raises nothing a hook can stand on, so this is the door for a
	 * typed command. It runs as the person's act: Claude Code's own Bash tool, in the
	 * session's shell and directory, with nobody asked — as `!` runs it. The person's row
	 * is the command's own lines; the model reads the timeline beside it.
	 *
	 * Because nobody is asked, it runs only for the person: their Enter at the prompt, their
	 * message over Remote Control, or the prompt a host was started with. A line that
	 * arrives any other way — a peer session, a channel, a schedule, another plugin, or a
	 * source the engine could not attest — is refused.
	 */
	on("command.run", { command: "sh" }, async ($, e, next) => {
		const command = (e.args ?? "").trim();
		if (command === "") return { text: SHELL_USAGE };
		if (!isPersonsOwn(e.origin?.kind)) {
			return {
				text: "`/sh` runs a command with nobody asked, so it only runs when you type it yourself. This one arrived another way and was not run.",
			};
		}
		const env = await readEnv($);
		const settings = settingsFor(env, options);
		const { found } = await locate($, env, options);
		if (!settings.enabled || !found) {
			return {
				text: `Pi-Time is not wrapping (${settings.enabled ? "no busybox build with `run` was found" : "it is off"}), so \`/sh\` has nothing to add: \`!${command}\` runs it plainly, and \`/pi-time\` says more.`,
			};
		}
		const carryCwd = flag(options.carryCwd, true);
		// The person's own command gets the default deadline, like every other; with the
		// default off it gets the longest the host allows.
		const plan = planDeadline({
			askedMs: settings.timeoutSeconds > 0 ? undefined : Number.MAX_SAFE_INTEGER,
			defaultSeconds: settings.timeoutSeconds,
			hostDefaultMs: count(env.BASH_DEFAULT_TIMEOUT_MS),
			hostMaxMs: count(env.BASH_MAX_TIMEOUT_MS),
		});
		const shell = await pickShell($, env);
		const streams = await streamOptions($, settings);
		const capture = captureFlags(found, settings);
		const wrapFor = (pty: PtyMode) =>
			wrapCommand(command, {
				busybox: found.path,
				shell,
				verbosity: settings.verbosity,
				pty,
				extraEnv: settings.extraEnv,
				...streams,
				timeoutSeconds: plan.budgetSeconds,
				carryCwd,
				report: true,
				...capture,
			});
		const pty: PtyMode = session.isPtyRefused ? "off" : settings.pty;
		const wrapped = wrapFor(pty);
		const issue = (line: string) =>
			$.tool.call({
				tool: "Bash",
				command: line,
				description: "Shell command typed by the user (/sh)",
				...(plan.hostTimeoutMs !== undefined ? { timeout: plan.hostTimeoutMs } : {}),
			});
		let ran: Awaited<ReturnType<typeof issue>>;
		try {
			// A direct busybox call or a `# pitime-raw` command is run as written.
			ran = await issue(wrapped ?? command);
			if (wrapped && pty !== "off" && ran.deny === undefined && ran.isError === true && ptyWasRefused(ran.text ?? "")) {
				session.isPtyRefused = true;
				ran = await issue(wrapFor("off") ?? wrapped);
			}
		} catch {
			return { text: "Interrupted: the command was stopped before it finished. It may have run in part." };
		}
		if (ran.deny !== undefined) {
			return {
				text: next.signal.aborted
					? "Interrupted: the command was stopped before it finished. It may have run in part."
					: `Not run: the call was refused (${ran.deny}).`,
			};
		}
		if (wrapped) noteWrapped($, env);
		// The guest's facts line: in a failed call's text, and for a good one wherever the
		// host put the outer shell's stderr. Either way it is read and taken out.
		const taken = ran.isError === true ? takeFacts(ran.text ?? (typeof ran.result === "string" ? ran.result : "")) : takeOutput(ran.result as BashOutput);
		const facts = taken.facts;
		const body = dropHousekeeping(taken.text);
		const view = await settle($, {
			body,
			command,
			found,
			settings,
			budgetSeconds: plan.budgetSeconds,
			idleSeconds: capture.idleSeconds,
			isPersons: true,
			facts,
			cwdCarried: carryCwd,
			escaped: !wrapped && wantsRaw(command),
		}).catch(() => body);
		return { text: personText(body), context: [modelContext(command, view)], isTextDisplayOnly: true as const };
	});

	/**
	 * Keep the model's description of the environment true, on every turn the wrapper is on.
	 *
	 * Idempotent, and silent when nothing wraps: a prompt that promises a timeline the
	 * results do not carry is worse than no prompt.
	 */
	on("prompt.compose", async ($, e, next) => {
		const composed = await next(e);
		if (e.traits.includes("bare") || !e.tools.includes("Bash")) return composed;
		const id = sectionId($.plugin.name);
		if (composed.sections.some((section) => section.id === id)) return composed;
		const env = await readEnv($);
		const settings = settingsFor(env, options);
		if (!settings.enabled) return composed;
		const { found } = await locate($, env, options);
		if (!found) return composed;
		const section = {
			id,
			scope: "session" as const,
			text: sectionText({
				busybox: shellValue(found.path),
				verbosity: settings.verbosity,
				pty: session.isPtyRefused ? "off" : settings.pty,
				timeoutSeconds: settings.timeoutSeconds,
				guard: guardEnabled(env, flag(options.guard, true)),
				carryCwd: flag(options.carryCwd, true),
				bang: session.shim !== undefined,
				stamp: found.stamp,
				header: found.header,
				compactStamps: settings.compactStamps,
				stampDigits: settings.stampDigits,
				idleByProcessor: settings.live && ![...session.liveWorks.values()].includes(false),
				idleSeconds: captureFlags(found, settings).idleSeconds,
				logQuery: found.abilities.logQuery,
				unbuffer: settings.unbuffer,
				platform: await platform($),
				preload: (await streamOptions($, settings)).stdbufLib !== undefined,
			}),
		};
		return { sections: [...composed.sections, section] };
	});

	/**
	 * The guard, ahead of the permission check: a stream merge at a command's tail, and a
	 * command that cannot end on its own here.
	 *
	 * Only a command that would be wrapped is judged: with the wrapper off, backgrounded,
	 * or escaped there is no stream tag for a merge to destroy, and no deadline of ours for
	 * an endless command to run into. It fails open — a guard that cannot decide must not
	 * stop a command.
	 */
	on("tool.call", { tool: "Bash" }, async ($, e, next) => {
		// This plugin's own re-issue: already judged as the model wrote it.
		if (next.origin.plugin === $.plugin.name) return next(e);
		if (e.run_in_background === true || isWrapped(e.command) || wantsRaw(e.command)) return next(e);
		if (hasOverride(e.command)) return next(e);
		const merge = detectTailMerge(e.command);
		// The other thing that cannot work here: a command that only ends when somebody
		// presses a key. It would sit until the deadline and come back as a TIMEOUT.
		const endless = merge ? undefined : detectEndless(e.command);
		if (!merge && !endless) return next(e);
		const env = await readEnv($);
		if (!settingsFor(env, options).enabled || !guardEnabled(env, flag(options.guard, true))) return next(e);
		const { found } = await locate($, env, options);
		if (!found) return next(e);
		session.blocked++;
		return { deny: merge ? blockReason(merge, shellValue(found.path)) : endlessReason(endless as NonNullable<typeof endless>) };
	}).catch(($, e, next) => next(e));

	/**
	 * The wrapper: an allowed call, re-issued inside `busybox run --timestamps`.
	 *
	 * Everything that can decline does so before the command is handed to Bash, and passes
	 * the call on untouched. After that point nothing may throw past this hook: a failed
	 * hook is skipped and the engine runs the tool in its place, which here would run the
	 * person's command a second time.
	 */
	on("tool.run", { tool: "Bash" }, async ($, e, next) => {
		if (next.origin.plugin === $.plugin.name) return next(e);
		// A backgrounded command returns at once and is read from its own output file as
		// it runs; `busybox run` prints its view only at exit, which would leave that file
		// empty until the end.
		if (e.run_in_background === true) return next(e);
		const env = await readEnv($);
		const settings = settingsFor(env, options);
		if (!settings.enabled) return next(e);
		const { found } = await locate($, env, options);
		if (!found) return next(e);

		const carryCwd = flag(options.carryCwd, true);
		const plan = planDeadline({
			askedMs: e.timeout,
			defaultSeconds: settings.timeoutSeconds,
			hostDefaultMs: count(env.BASH_DEFAULT_TIMEOUT_MS),
			hostMaxMs: count(env.BASH_MAX_TIMEOUT_MS),
		});
		const shell = await pickShell($, env);
		const streams = await streamOptions($, settings);
		const capture = captureFlags(found, settings);
		// The sandbox refuses a pseudo-terminal; once it has, sandboxed calls skip the attempt.
		const isSandboxed = e.dangerouslyDisableSandbox !== true;
		// A command that can be watched is judged by output *and* processor, here; one that
		// cannot keeps the applet's own limit, which knows only silence.
		const live = await openLive($, e.tool_use_id, isSandboxed ? "sandboxed" : "open", settings).catch(() => undefined);
		const wrapFor = (pty: PtyMode) =>
			wrapCommand(e.command, {
				busybox: found.path,
				shell,
				verbosity: settings.verbosity,
				pty,
				extraEnv: settings.extraEnv,
				...streams,
				timeoutSeconds: plan.budgetSeconds,
				carryCwd,
				report: true,
				...capture,
				...(live ? { idleSeconds: 0, liveFile: live.file } : {}),
			});
		const pty: PtyMode = isSandboxed && session.isPtyRefused ? "off" : settings.pty;
		const wrapped = wrapFor(pty);

		if (!wrapped) {
			// Left as written: a direct busybox call, or a `# pitime-raw` command. The marker
			// asked for exact bytes, so what it hid goes beside the result, never into it.
			const ran = await next(e);
			if (ran.deny !== undefined || ran.isError === true || !wantsRaw(e.command)) return ran;
			const notes = resultNotes(e.command, { escaped: true, cwdCarried: true, seen: session.seenNotes });
			return notes.length > 0 ? { ...ran, context: [...(ran.context ?? []), notes.join("\n")] } : ran;
		}

		const reissue = (command: string) =>
			$.tool.call({
				tool: "Bash",
				command,
				...(e.description !== undefined ? { description: e.description } : {}),
				...(plan.hostTimeoutMs !== undefined ? { timeout: plan.hostTimeoutMs } : {}),
				...(e.dangerouslyDisableSandbox !== undefined ? { dangerouslyDisableSandbox: e.dangerouslyDisableSandbox } : {}),
			});

		if (started.size > 200) started.clear();
		started.add(e.tool_use_id);
		if (live) {
			running.set(e.tool_use_id, live);
			watch($, live);
		}
		let ran = await reissue(wrapped);
		if (pty !== "off" && ran.deny === undefined && ran.isError === true && ptyWasRefused(ran.text ?? "")) {
			// No terminal to be had, and so no command started: the same call on plain pipes.
			if (isSandboxed) session.isPtyRefused = true;
			ran = await reissue(wrapFor("off") ?? wrapped);
		}
		started.delete(e.tool_use_id);
		const seen = live ? { cpu: cpuOf(live, await $.clock.now()), stuck: live.stopped } : {};
		if (live) {
			closeLive(live);
			running.delete(e.tool_use_id);
		}

		if (ran.deny !== undefined && next.signal.aborted) {
			// The person pressed Esc (or the turn was aborted) while the command ran: the
			// re-issued call comes back refused, but nothing refused it — it was stopped.
			return {
				deny: "CANCELLED — the command was stopped on request (interrupt or abort) while it was running, not because it failed. It may have run in part; what it printed before the stop was not returned.",
			};
		}
		if (ran.deny !== undefined) {
			// Another hook or a host rule refused the wrapped spelling of an allowed call.
			// Whether anything ran is not ours to know, so it is not run again here.
			session.refused++;
			return {
				deny: [
					`Pi-Time could not run this command wrapped: the re-issued call was refused (${ran.deny}).`,
					"It is not known to have run. End the command with `# pitime-raw` to run it unwrapped once, or `/pi-time off` turns the wrapper off for the session.",
				].join("\n"),
			};
		}
		noteWrapped($, env);
		const about = {
			command: e.command,
			found,
			settings,
			budgetSeconds: plan.budgetSeconds,
			idleSeconds: capture.idleSeconds,
			cwdCarried: carryCwd,
			...(seen.cpu ? { cpu: seen.cpu } : {}),
			...(seen.stuck ? { stuck: seen.stuck } : {}),
		};
		if (ran.isError === true) {
			// A failed command stays a failed command: the model reads the same error text
			// the host built ("Exit code 4", then the timeline), with Pi-Time's lines around
			// it. The guest's facts line is somewhere in that text, since it holds stderr too.
			const taken = takeFacts(ran.text ?? (typeof ran.result === "string" ? ran.result : ""));
			const body = dropHousekeeping(taken.text);
			// The command has run: whatever goes wrong from here must not run it again, so
			// a result that cannot be dressed is handed over as it is.
			return { deny: await settle($, { ...about, body, facts: taken.facts }).catch(() => body) };
		}
		const taken = takeOutput(ran.result);
		const body = dropHousekeeping(taken.text);
		const stdout = await settle($, { ...about, body, facts: taken.facts }).catch(() => body);
		return { result: { ...ran.result, stdout, stderr: taken.stderr } };
	}).catch(($, e, next) => {
		const live = running.get(e.tool_use_id);
		if (live) {
			closeLive(live);
			running.delete(e.tool_use_id);
		}
		if (next.called) return next(e);
		if (!started.delete(e.tool_use_id)) return next(e);
		return {
			deny: "Pi-Time failed after this command was started (interrupted, or an internal error): it may have run in part or in full, and its output was lost. Check its effects before running it again.",
		};
	});

	/**
	 * The human's view of a wrapped result: the command's own lines.
	 *
	 * A rewrite here changes the row alone — the stored result, which the model reads and
	 * the session keeps, still carries every offset.
	 */
	on("ui.render", { component: "ToolResult" }, ($, e, next) => {
		if (e.props.tool !== "Bash" || !flag(options.cleanDisplay, true)) return next(e);
		if (e.props.isErrored) {
			// A failed call draws its error text, which no rewrite of `output` reaches, so
			// the row is drawn here: the same words, without the wrapper's decoration.
			const raw = e.props.output;
			if (typeof raw !== "string" || !hasTimeline(raw)) return next(e);
			const { Box, Text } = $.ui.resolve(e);
			// The stored text may already lead with the host's own "Error: " (it does in the
			// terminal's transcript); say it once either way.
			const body = stripTimeline(raw);
			const lines = (body.startsWith("Error: ") ? body : `Error: ${body}`).split("\n");
			const isWhole = e.props.isExpanded === true || lines.length <= ERROR_ROWS;
			const shown = isWhole ? lines : [...lines.slice(0, ERROR_ROWS), `… +${lines.length - ERROR_ROWS} lines`];
			return (
				<Box flexDirection="row">
					<Text dimColor>{"  ⎿  "}</Text>
					<Text color="error">{shown.join("\n")}</Text>
				</Box>
			);
		}
		const output = forDisplay(e.props.output);
		return output === e.props.output ? next(e) : next({ ...e, props: { ...e.props, output } });
	}).catch(($, e, next) => next(e));

	/**
	 * A running command's row: its newest lines, and a sign of life.
	 *
	 * `busybox run` prints its view when the command ends, so without this a slow command
	 * is an empty row for as long as it takes. What is drawn here is read from the capture
	 * as it grows, and from the processor: "CPU busy: working" under a silent compile,
	 * "CPU idle: waiting on something" under a hang. The model is sent none of it; it
	 * reads the result.
	 */
	on("ui.render", { component: "ToolUse" }, async ($, e, next) => {
		if (e.props.tool !== "Bash") return next(e);
		const live = e.props.isRunning ? running.get(e.props.tool_use_id) : undefined;
		if (live?.pointer && !live.isDone) {
			const now = await $.clock.now();
			const { Box, Text } = $.ui.resolve(e);
			const rows = live.tail.shown();
			const life = lifeLine({
				elapsedMs: now - live.startedAt,
				silentMs: now - live.lastOutputAt,
				hasOutput: live.hasOutput,
				cpu: cpuOf(live, now),
				idleMs: live.idleMs,
			});
			const lines = [...rows, life].map((line, index) => `${index === 0 ? "  ⎿  " : "     "}${line}`);
			return (
				<Box flexDirection="column">
					{await next(e)}
					<Text dimColor>{lines.join("\n")}</Text>
				</Box>
			);
		}
		if (!flag(options.cleanDisplay, true)) return next(e);
		const output = forDisplay(e.props.output);
		return output === e.props.output ? next(e) : next({ ...e, props: { ...e.props, output } });
	}).catch(($, e, next) => next(e));
};
