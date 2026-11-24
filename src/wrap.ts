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
 * Every bash command, run through `busybox run --timestamps`.
 *
 * Why: concatenating stdout and stderr loses the only information that explains a
 * confusing log — the order. `run -t` prints one interleaved, dmesg-style line per
 * record with a microsecond offset and the stream it came from:
 *
 *     [   0.011354 out] ok 1
 *     [   0.066632 err] FAILED test_x
 *     [   0.128234 out] done
 *
 * So a model can tell "the warning came before the failure" from "the tool printed
 * warnings in a block at the end", and a burst of lines sharing one timestamp is
 * itself evidence of a buffered writer flushing at exit.
 *
 * The wrapper is deliberately transparent: the child's exit status is what the shell
 * returns, the command runs in the same shell, cwd and environment it would have
 * had, and stderr is still tagged `err` instead of being merged.
 *
 * Nothing here imports the host: no Node, no Claude Code. The hooks module passes the
 * binary path and the environment in, so the same file runs under `node --test`.
 */

import { LIVE_FILE_VAR, LIVE_PRELUDE } from "./live";

/** A bag of environment variables, as the hooks module read them. */
export type Env = Readonly<Record<string, string | undefined>>;

/** How much of a command's output comes back, and whether it is reduced. */
export type Verbosity = "quiet" | "normal" | "verbose" | "brief";

/**
 * Whether the child gets a pseudo-terminal, and how.
 *
 * `split` (the default) puts stdout on the pty and leaves stderr on a pipe. That is the
 * whole trick behind honest timing: libc line-buffers when stdout is a terminal, so a
 * Python/Node/Ruby/Java program emits each line as it happens instead of flushing the
 * lot at exit — and the timeline then shows the real intervals. stderr is unbuffered
 * whether or not it is a terminal, so keeping it on a pipe costs nothing and preserves
 * the `err` tag.
 *
 * `off` is the byte-exact, no-tty mode (`isatty()` is false, programs take their
 * non-interactive paths). `merged` gives 0/1/2 the same pty, which loses the stream tag
 * but is what a full-screen tool expects. `raw` adds `--pty-raw`, which switches the
 * line discipline off (no CR/NL translation, byte-exact beyond the canonical line
 * limit).
 */
export type PtyMode = "split" | "merged" | "raw" | "off";

export const PTY_MODES: readonly PtyMode[] = ["split", "merged", "raw", "off"];

export const VERBOSITIES: readonly Verbosity[] = ["quiet", "normal", "verbose", "brief"];

export interface WrapSettings {
	/** False when `CLAUDE_MANAGED_TOOLS_WRAP=off`: Bash commands run untouched. */
	enabled: boolean;
	verbosity: Verbosity;
	/** Pseudo-terminal for the child; see PtyMode. */
	pty: PtyMode;
	/** Deadline applied when the caller gave none, in seconds; 0 means no deadline. */
	timeoutSeconds: number;
	/** Stop a command after this many seconds without output; 0 means never. */
	idleSeconds: number;
	/** Set the variables that switch runtimes' output buffering off (STREAM_ENV and the preludes). */
	unbuffer: boolean;
	/** Also preload `stdbuf`'s library on Linux, so C-stdio programs line-buffer there too. */
	preload: boolean;
	/** One stamp per burst: a line at the offset and on the stream of the one above carries none. */
	compactStamps: boolean;
	/** Decimals an offset keeps in what the model reads (3 is milliseconds; 9 is as captured). */
	stampDigits: number;
	/** Show a running command's output and a sign of life under its row, and judge "stuck" by the processor too. */
	live: boolean;
	/** Extra `NAME=VALUE` for the wrapped child, from `CLAUDE_MANAGED_TOOLS_EXTRA_ENV`. */
	extraEnv: Array<[string, string]>;
}

/**
 * Environment that makes a runtime write each line when it prints it.
 *
 * It matters wherever a program's stdout is not a terminal: on plain pipes (the sandbox),
 * as a stage inside a pipeline (`cmd | tee log`, `cmd | grep x`), and into a file that a
 * later command reads (`server > srv.log &`). There a runtime that block-buffers holds
 * its lines until a 4-64 KB buffer fills or it exits, and every offset the timeline then
 * shows is the flush, not the event.
 *
 * Measured with a probe per runtime (print, wait a second, print; stdout a pipe), on
 * macOS 27 and Debian 12:
 *
 *   live with no help   sh builtins, Node, Deno, Bun, PHP, Tcl, R, Java, Elixir, Go,
 *                       Rust, C++ iostream, Lua 5.4, make
 *   fixed here          Python, Ruby, Perl, LuaJIT — and on macOS every C-stdio program:
 *                       compiled C and Swift, grep, sed, awk, cut, tr, jq
 *   fixed by a preload  the same C-stdio programs on Linux (glibc has no variable for
 *                       it): `stdbuf`'s library, off unless asked for, see STDBUF_LIBS
 *   not fixable         Haskell (GHC) on a pipe, OCaml's Printf, mawk's input buffer
 *
 * Stderr needed nothing in any of them but OCaml's Printf.
 */
export const STREAM_ENV: ReadonlyArray<[string, string]> = [
	// Python: stdout and stderr both, for the whole process tree.
	["PYTHONUNBUFFERED", "1"],
	// macOS and FreeBSD libc: line-buffer whatever is on descriptor 1 (setvbuf(3),
	// ENVIRONMENT). One variable covers every C-stdio program, which is most of a
	// pipeline. glibc and musl ignore it.
	["STDBUF1", "L"],
	// Foundation: unbuffered stdout for a Swift or Objective-C program. On macOS the line
	// above already covers them; this one is for the day it does not.
	["NSUnbufferedIO", "YES"],
];

/**
 * `LUA_INIT`, run by the standalone interpreter before the script: line-buffer stdout.
 *
 * A long-bracket string, so the snippet carries no quote of either kind and survives the
 * double-quoted `${LUA_INIT:-…}` it is emitted in. Only used when the person has no
 * `LUA_INIT` of their own.
 */
export const LUA_INIT = "io.stdout:setvbuf[[line]]";

/** The rest of the wrapper's environment: encoding, colour, pagers, prompts, progress. */
export const QUIET_ENV: ReadonlyArray<[string, string]> = [
	["PYTHONIOENCODING", "utf-8"],
	// No __pycache__ writes: they add mtime churn to every run and never help here.
	["PYTHONDONTWRITEBYTECODE", "1"],
	// Colour and pager control: ANSI escapes make a timeline unreadable and a pager
	// can block forever with no TTY.
	["NO_COLOR", "1"],
	["CLICOLOR", "0"],
	["FORCE_COLOR", "0"],
	["TERM", "dumb"],
	["PAGER", "cat"],
	["GIT_PAGER", "cat"],
	["GIT_TERMINAL_PROMPT", "0"],
	["CARGO_TERM_COLOR", "never"],
	// A prompt on a package install would hang until the deadline.
	["DEBIAN_FRONTEND", "noninteractive"],
];

/**
 * Option lists a build tool reads from the environment, added to whatever is there.
 *
 * Both tools print a progress bar (or a spinner) into a captured stream, unusable in a
 * timeline. They are appended, never assigned: a `GRADLE_OPTS=-Xmx4g` the person's build
 * depends on has to survive the wrapper.
 */
export const TOOL_OPTIONS_ENV: ReadonlyArray<[string, string]> = [
	["MAVEN_ARGS", "-B -ntp"],
	["GRADLE_OPTS", "-Dorg.gradle.console=plain -Dorg.gradle.daemon=false"],
];

/** Every plain assignment the wrapper makes with buffering switched off, in the order emitted. */
export const UNBUFFERED_ENV: ReadonlyArray<[string, string]> = [...STREAM_ENV, ...QUIET_ENV];

/**
 * Where GNU coreutils keeps `stdbuf`'s preload library, by distribution.
 *
 * glibc reads no variable for stdio buffering, so on Linux the only way to line-buffer a
 * C-stdio program from outside is the way `stdbuf -oL` does it: `LD_PRELOAD` this library
 * and set `_STDBUF_O=L`. It is not on by default, because a preload reaches every dynamic
 * program the command starts — an AddressSanitizer build refuses to run unless its own
 * runtime is first in that list — so it is an option for someone who wants it.
 */
export const STDBUF_LIBS: readonly string[] = [
	"/usr/libexec/coreutils/libstdbuf.so",
	"/usr/lib/x86_64-linux-gnu/coreutils/libstdbuf.so",
	"/usr/lib/aarch64-linux-gnu/coreutils/libstdbuf.so",
	"/usr/lib/coreutils/libstdbuf.so",
	"/usr/lib64/coreutils/libstdbuf.so",
];

/** `run` flags for each verbosity, on top of the always-present `--timestamps`. */
const LADDER: Record<Verbosity, { flags: string[]; timestamps: boolean }> = {
	// A short view: enough to see what happened, not enough to drown the answer.
	quiet: { flags: ["--max-bytes", "6000"], timestamps: true },
	// Claude Code inlines a Bash result up to ~30 000 characters and moves anything
	// longer to a file behind a 2 000-character preview. The budget counts the whole
	// view, prefixes included (measured: --max-bytes 24000 prints 22.5 KB), so `normal`
	// stays under that line and the model always reads the view it was given.
	normal: { flags: ["--max-bytes", "24000"], timestamps: true },
	// The most that stays inline once the digest, notices and notes are added. A bigger
	// view is a smaller one in practice: measured at 100 000, the host moved the result
	// to a file and the model was shown its first 2 000 characters.
	verbose: { flags: ["--max-bytes", "27000"], timestamps: true },
	// `--brief` reduces repeats, and this build ignores it when `--timestamps` is set
	// (`run -t` takes the timeline branch first), so this mode drops the timing on
	// purpose: it is the answer for "this output is 40 000 lines of the same thing".
	brief: { flags: ["--max-bytes", "12000", "--brief", "both"], timestamps: false },
};

/** What the plugin's own options (plugin.json `userConfig`) say, before the environment. */
export interface WrapDefaults {
	enabled?: boolean;
	verbosity?: string;
	pty?: string;
	timeoutSeconds?: number;
	idleSeconds?: number;
	unbuffer?: boolean;
	preload?: boolean;
	compactStamps?: boolean;
	stampDigits?: number;
	live?: boolean;
	extraEnv?: string;
}

/** An on/off variable: unset or unrecognised leaves the fallback. */
function readSwitch(raw: string | undefined, fallback: boolean): boolean {
	const value = (raw ?? "").trim().toLowerCase();
	if (value === "1" || value === "on" || value === "true" || value === "yes") return true;
	if (value === "0" || value === "off" || value === "false" || value === "no") return false;
	return fallback;
}

function isOff(raw: string | undefined): boolean {
	const value = (raw ?? "").trim().toLowerCase();
	return value === "0" || value === "off" || value === "false" || value === "no";
}

/**
 * Settings for one call. Precedence, highest first: the session override
 * (`/pi-time verbosity`), the environment (`CLAUDE_MANAGED_TOOLS_*`), the plugin's
 * options, the built-in default.
 *
 * `CLAUDE_MANAGED_TOOLS_WRAP=off` (or 0/false/no) turns the wrapper off entirely.
 */
export function readWrapSettings(env: Env = {}, defaults: WrapDefaults = {}, override?: Verbosity): WrapSettings {
	const wrap = env.CLAUDE_MANAGED_TOOLS_WRAP;
	const enabled = wrap !== undefined && wrap.trim() !== "" ? !isOff(wrap) : defaults.enabled !== false;
	const requested = (override ?? env.CLAUDE_MANAGED_TOOLS_VERBOSITY ?? defaults.verbosity ?? "").trim().toLowerCase();
	const fallback = (defaults.verbosity ?? "").trim().toLowerCase();
	const verbosity = (VERBOSITIES as readonly string[]).includes(requested)
		? (requested as Verbosity)
		: (VERBOSITIES as readonly string[]).includes(fallback)
			? (fallback as Verbosity)
			: "normal";
	return {
		enabled,
		verbosity,
		pty: readPtyMode(env.CLAUDE_MANAGED_TOOLS_PTY ?? defaults.pty),
		timeoutSeconds: readDefaultTimeout(env, defaults.timeoutSeconds),
		idleSeconds: readIdleSeconds(env, defaults.idleSeconds),
		unbuffer: readSwitch(env.CLAUDE_MANAGED_TOOLS_UNBUFFER, defaults.unbuffer !== false),
		preload: readSwitch(env.CLAUDE_MANAGED_TOOLS_PRELOAD, defaults.preload === true),
		compactStamps: readSwitch(env.CLAUDE_MANAGED_TOOLS_COMPACT_STAMPS, defaults.compactStamps !== false),
		stampDigits: readStampDigits(env.CLAUDE_MANAGED_TOOLS_STAMP_DIGITS, defaults.stampDigits),
		live: readSwitch(env.CLAUDE_MANAGED_TOOLS_LIVE, defaults.live !== false),
		extraEnv: parseExtraEnv(env.CLAUDE_MANAGED_TOOLS_EXTRA_ENV ?? defaults.extraEnv),
	};
}

/**
 * How many decimals of an offset the model is shown: 1 to 9, milliseconds unless set.
 *
 * The capture keeps nanoseconds whatever this says (`busybox log` prints them); this is
 * only how much of the number is repeated in a result. `CLAUDE_MANAGED_TOOLS_STAMP_DIGITS`
 * overrides the option; anything that is not a whole number from 1 to 9 leaves the default.
 */
export function readStampDigits(raw: string | undefined, fallback?: number): number {
	const isValid = (value: number) => Number.isInteger(value) && value >= 1 && value <= 9;
	const base = typeof fallback === "number" && isValid(fallback) ? fallback : 3;
	const asked = (raw ?? "").trim();
	return asked !== "" && isValid(Number(asked)) ? Number(asked) : base;
}

/**
 * The silence limit: a command that prints nothing on either stream for this many seconds
 * is stopped, whatever its deadline.
 *
 * The same number as the default deadline, as pi-managed-tools has it. Under the default
 * deadline it changes nothing — the deadline fires first when the two are equal
 * (measured) — so it earns its keep when a caller raises `timeout`: a command given ten
 * minutes that hangs in its first second comes back as `IDLE` after two, not as a
 * `TIMEOUT` after ten. The price is a command that is quiet and working, which is stopped
 * too; the notice says how to run one.
 */
export const DEFAULT_IDLE_SECONDS = 120;

/**
 * `CLAUDE_MANAGED_TOOLS_IDLE` overrides it: seconds, or `0`/`off` for no limit.
 *
 * `fallback` is the plugin's option; 0 there turns the limit off, and anything that is
 * not a number at all leaves the built-in default.
 */
export function readIdleSeconds(env: Env = {}, fallback?: number): number {
	const base = typeof fallback === "number" && Number.isFinite(fallback) && fallback >= 0 ? Math.floor(fallback) : DEFAULT_IDLE_SECONDS;
	const raw = (env.CLAUDE_MANAGED_TOOLS_IDLE ?? "").trim().toLowerCase();
	if (raw === "") return base;
	if (raw === "0" || raw === "off" || raw === "false" || raw === "no" || raw === "none") return 0;
	const seconds = Number(raw);
	return Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : base;
}

/**
 * `CLAUDE_MANAGED_TOOLS_PTY`: `split` (default), `merged`/`on`, `raw`, or `off`.
 *
 * Anything unrecognised is the default, never a silent switch to a tty: a child that
 * sees a terminal behaves differently, so opting in has to be explicit.
 */
export function readPtyMode(raw: string | undefined): PtyMode {
	switch ((raw ?? "").trim().toLowerCase()) {
		case "off":
		case "0":
		case "false":
		case "no":
		case "none":
		case "pipe":
			return "off";
		case "merged":
		case "on":
		case "pty":
		case "yes":
		case "1":
			return "merged";
		case "raw":
			return "raw";
		default:
			return "split";
	}
}

/**
 * True when `run` could not get a pseudo-terminal, and so never started the command.
 *
 * Claude Code's sandbox refuses the allocation (`run: cannot allocate a pty: Operation
 * not permitted`, exit 2). The applet asks for the terminal before it starts the child,
 * so a result that carries this line and no `run=R…` header is a command that did not
 * run — which is what makes running it again on plain pipes safe.
 */
export function ptyWasRefused(text: string): boolean {
	return /^run: cannot allocate a pty\b/m.test(text) && !/^run=R\d+ /m.test(text);
}

/** The flag that gives the child a terminal, or undefined for a plain pipe. */
export function ptyFlags(mode: PtyMode): string[] {
	switch (mode) {
		case "merged":
			return ["--pty"];
		case "raw":
			return ["--pty-raw"];
		case "split":
			return ["--pty-split"];
		default:
			return [];
	}
}

/** `NAME=VALUE,NAME2=VALUE2` — commas brace values, so no comma survives inside one. */
export function parseExtraEnv(raw: string | undefined): Array<[string, string]> {
	const out: Array<[string, string]> = [];
	for (const pair of (raw ?? "").split(",")) {
		const trimmed = pair.trim();
		const eq = trimmed.indexOf("=");
		if (eq <= 0) continue;
		const name = trimmed.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
		out.push([name, trimmed.slice(eq + 1)]);
	}
	return out;
}

/**
 * Quote one argument for a POSIX shell, so the wrapper survives the host's own `sh -c`.
 *
 * Single quotes make every byte literal (newlines, `$`, backticks, `!`), and an
 * embedded quote becomes `'\''`: close, escaped quote, reopen.
 */
export function shellQuote(value: string): string {
	return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * Quote a value only when it needs quoting, so an emitted wrapper stays readable.
 *
 * An env value like `MAVEN_ARGS=-B -ntp` contains a space: left unquoted, the shell
 * splits it and busybox sees `-ntp` as an option. Values made only of safe characters
 * stay bare, so a logged wrapper can be read at a glance.
 */
export function shellValue(value: string): string {
	return /^[A-Za-z0-9_.:=+@/-]+$/.test(value) ? value : shellQuote(value);
}

/**
 * Applets that only *start another command*: `busybox sh -c '…'` is the model's own
 * script in a different shell, not a busybox result to read.
 *
 * These used to count as "already wrapped" along with every other `busybox …` call. In
 * pi-managed-tools ten such calls in one sampled session ran with no timeline, no
 * deadline and no silence limit — exactly the longest commands.
 */
export const RUNNER_APPLETS: readonly string[] = ["sh", "ash", "hush", "env", "timeout", "nice", "nohup", "time"];

/**
 * True when a command is already the wrapper, or a direct `busybox <applet>` call (bare
 * or by path) whose output is the applet's own record (`run`, `log`, `peek`, `json`, …),
 * so a second pass over the same tool call cannot nest two timelines and a
 * `busybox log R12` reads the capture as written.
 *
 * A direct call to a runner applet is not that: it is wrapped like any other command.
 */
export function isWrapped(command: string): boolean {
	const trimmed = command.trimStart();
	if (trimmed.startsWith(CWD_PREAMBLE)) return true;
	const match = /^(?:busybox|'[^']*\/busybox'|[^'\s]*\/busybox)\s+(\S+)/.exec(trimmed);
	if (match === null || RUNNER_APPLETS.includes(match[1] as string)) return false;
	// One applet call only: `busybox waitfor … && npm test` is the model's own script, and
	// used to run with no wrapper, no deadline and no guard.
	const bare = command.replace(/'\\''/g, "").replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""').trim();
	return !/[;&|\n]/.test(bare);
}

/** What a command ends with to come back unwrapped. Spelled like the guard's `# pitime-safe`. */
export const RAW_MARKER = "# pitime-raw";

/**
 * True when the command asks, in so many words, to run outside the wrapper.
 *
 * The escape used to be the shell's own `command` builtin at the start of any segment,
 * and it was taken far more often by accident than on purpose. Measured on real sessions:
 *
 * - `cd repo && … && command cat inv/__init__.py` — a model bypassing an alias, the
 *   ordinary reason anyone writes `command`. In pi, 4 of 13 bash calls in one session lost
 *   their timeline this way, one of them the call that ran the test suite.
 * - One Claude Code session took up the prefix as a habit and ran nearly every call
 *   unwrapped for hours; each result told it so, and it carried on.
 * - `command -v jq`, and `grep -n "a\|command prefix" f` — the word inside a quoted
 *   pattern, after a `|`.
 *
 * And it was never needed for what it was documented for. A pipe into `jq`, a redirect,
 * a checksum: everything *inside* a command already sees exact bytes. Only the result
 * that is read back carries the offsets. So `command x` is now nothing but the builtin —
 * it runs wrapped like any other command — and the escape is a comment nobody writes by
 * accident. Quoted text and heredoc bodies are not looked at.
 */
export function wantsRaw(command: string): boolean {
	const bare = command
		.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g, "")
		.replace(/'[^']*'/g, "''")
		.replace(/"(?:[^"\\]|\\[\s\S])*"/g, '""');
	return /(?:^|\s)#\s*pitime-raw\b/.test(bare);
}

export interface WrapOptions {
	busybox: string;
	/** The shell the host itself would have used; the child keeps it, so `[[ ]]` still works. */
	shell: string;
	verbosity: Verbosity;
	/** Defaults to `off` so the tests here describe plain pipes; the hooks module passes its setting. */
	pty?: PtyMode;
	extraEnv?: Array<[string, string]>;
	/** The deadline for this call, in seconds; emitted verbatim (the caller owns the policy). */
	timeoutSeconds?: number;
	/**
	 * Nine-digit offsets (`--stamp-ns`). Only for a build that has the flag: the caller
	 * reads the binary's own feature list, and an older build is never handed it.
	 */
	stampNs?: boolean;
	/** Stop after this many seconds without output (`--idle-timeout`); same rule as `stampNs`. */
	idleSeconds?: number;
	/** Path to the Ruby prelude; when it exists, RUBYOPT requires it so $stdout.sync is on. */
	rubyPrelude?: string;
	/** Folder holding the Perl prelude; when it exists, PERL5OPT loads it so `$|` is on. */
	perlPrelude?: string;
	/** `stdbuf`'s preload library, when one was found and the person asked for it (Linux). */
	stdbufLib?: string;
	/** False leaves every runtime's buffering as it is: no STREAM_ENV, no prelude, no preload. */
	unbuffer?: boolean;
	/** Skip the wrapper's environment altogether (used by tests). */
	noEnv?: boolean;
	/**
	 * Carry the command's final working directory back to the host's shell.
	 *
	 * Claude Code keeps `cd` between Bash calls when the command succeeds. The wrapped
	 * command runs in a child shell, whose `cd` would otherwise die with it, so the child
	 * writes its last directory to a file and the outer shell moves there on exit 0.
	 */
	carryCwd?: boolean;
	/**
	 * Have the guest shell say how it ended: the exit status of every stage of its last
	 * pipeline, and the folder `run` kept this capture in. They replace guesses on the
	 * result ("the command's own status is unknown") with what happened. See `exitTrap`.
	 */
	report?: boolean;
	/**
	 * A file, known to this call alone, in which the command's shell says where its
	 * capture is and which process group it leads — so the hooks module can show the
	 * output as it arrives and see whether the processor is in use. See live.ts.
	 */
	liveFile?: string;
}

/** First bytes of a wrapper with an epilogue; `isWrapped` recognises its own output by it. */
export const CWD_PREAMBLE = '__pt_f="${TMPDIR:-/tmp}/pitime-cwd.$$"; ';

/** The variable the child reads to know where to leave its final directory. */
export const CWD_FILE_VAR = "PITIME_CWD_FILE";

/** The variable the child reads to know where to leave its facts: pipeline statuses, run folder. */
export const FACTS_FILE_VAR = "PITIME_FACTS_FILE";

/** What the epilogue's facts line starts with; `takeFacts` in guard.ts reads it back. */
export const FACTS_PREFIX = "pitime_facts";

/**
 * An EXIT trap for the child: it keeps the command's own status, and leaves what the
 * outer shell cannot see for itself.
 *
 * - With `carryCwd`, the final directory, for the outer shell to move to.
 * - With `report`, two lines: the exit status of every stage of the last pipeline, and
 *   the run's own folder (`run` hands the guest `$BUSYBOX_RUN_DIR`). The statuses are
 *   read first, before anything else in the trap can overwrite them. bash keeps them in
 *   `PIPESTATUS` and zsh in `pipestatus` (measured: under zsh `${PIPESTATUS[*]}` is
 *   empty); any other shell reports the folder alone.
 *
 * On the command's own first line, never a line of its own: a prelude line would shift
 * every line number the shell reports (`zsh:2: command not found` for a one-line command).
 * A command that sets its own EXIT trap replaces this one, and a syntax error never
 * reaches it — both leave no facts, and the result falls back to saying what it cannot
 * know. Measured in pi-managed-tools: `false | seq 1 100000 | head -1` leaves `1 141 0`,
 * at about 4 ms a call.
 */
export function exitTrap(shell: string, options: { carryCwd?: boolean; report?: boolean }): string {
	if (!options.carryCwd && !options.report) return "";
	const statuses = /(?:^|\/)zsh$/.test(shell) ? "${pipestatus[*]}" : /(?:^|\/)bash$/.test(shell) ? "${PIPESTATUS[*]}" : undefined;
	const steps: string[] = [];
	// In braces with its stderr dropped: under `set -x` the bare assignment printed
	// `+ __pt_ps=0` into the command's own stderr.
	if (options.report && statuses) steps.push(`{ __pt_ps="${statuses}"; } 2>/dev/null`);
	if (options.carryCwd) steps.push(`pwd -P >"$${CWD_FILE_VAR}" 2>/dev/null`);
	if (options.report) {
		steps.push(`printf "%s\\n%s\\n" "${statuses ? "$__pt_ps" : ""}" "\${BUSYBOX_RUN_DIR:-}" >"$${FACTS_FILE_VAR}" 2>/dev/null`);
	}
	return `trap '${steps.join("; ")}' EXIT; `;
}

/**
 * Runs in the child before the command, in `split` mode: stdin back off the terminal.
 *
 * `--pty-split` puts stdin on the pseudo-terminal along with stdout. Only stdout needs to
 * be one (that is what makes libc line-buffer); a stdin that is a terminal makes `python3`
 * start a REPL and `isatty(0)` checks take their interactive path, where the host's own
 * Bash gives a command no terminal to read. The applet's own `--stdin` does not undo it
 * under a pty (measured), so the child does it itself.
 */
const STDIN_PRELUDE = "exec </dev/null; ";

/**
 * The terminal's size, as `COLSxROWS`, for every mode that has one.
 *
 * Fixed, not inherited: left alone the applet copies the size of the terminal Claude Code
 * runs in, so what the model reads would change with how wide the person's window is.
 * Wide, because a program writing to a terminal cuts or wraps at its width (`ps aux`
 * loses its command lines at 80 columns; on a pipe it prints them whole).
 */
export const PTY_SIZE = "200x50";

/**
 * Runs in the outer shell after the wrapper: move on success, hand the facts over, tidy
 * up, keep the status.
 *
 * The facts go to the outer shell's stderr, one line, after `busybox run` has exited: on
 * stdout they could be glued to a view that did not end in a newline, and inside the
 * capture they would be a line of the command's. The hooks module takes the line back
 * out before anyone reads the result.
 */
function epilogue(options: { carryCwd?: boolean; report?: boolean; liveFile?: string }): string {
	const steps = ["; __pt_rc=$?"];
	if (options.carryCwd) steps.push('if [ "$__pt_rc" -eq 0 ] && [ -s "$__pt_f" ]; then cd -- "$(cat "$__pt_f")" 2>/dev/null; fi');
	if (options.report) {
		steps.push(
			`if [ -s "$__pt_f.f" ]; then { IFS= read -r __pt_ps; IFS= read -r __pt_rd; } <"$__pt_f.f"; printf '${FACTS_PREFIX} ps=[%s] dir=%s\\n' "$__pt_ps" "$__pt_rd" >&2; fi`,
		);
	}
	const isTrapped = options.carryCwd === true || options.report === true;
	const spent = [...(isTrapped ? ['"$__pt_f"'] : []), ...(options.report ? ['"$__pt_f.f"'] : []), ...(options.liveFile ? [shellQuote(options.liveFile)] : [])];
	steps.push(`rm -f ${spent.join(" ")}`, '(exit "$__pt_rc")');
	return steps.join("; ");
}

/**
 * Build the replacement command, or undefined when the command should run as written.
 *
 * The shape is `busybox run <flags> --env ... -- <shell> -c '<command>'`. `run` exits
 * with the child's status, so `&&`, `;` and `$?` behave exactly as before. With
 * `carryCwd` or `report` the same line gains a preamble and an epilogue in the outer
 * shell.
 */
export function wrapCommand(command: string, options: WrapOptions): string | undefined {
	if (!command.trim()) return undefined;
	if (isWrapped(command) || wantsRaw(command)) return undefined;

	const parts = runPrefix(options);
	// On the command's own first line, like everything else put in front of it.
	const prelude = ((options.pty ?? "off") === "split" ? STDIN_PRELUDE : "") + (options.liveFile ? LIVE_PRELUDE : "");
	const trap = exitTrap(options.shell, options);
	if (options.liveFile) parts.push("--env", shellQuote(`${LIVE_FILE_VAR}=${options.liveFile}`));
	if (trap === "" && !options.liveFile) {
		parts.push("--", shellQuote(options.shell), "-c", shellQuote(prelude + command));
		return parts.join(" ");
	}
	// Double quotes here, and only here: the outer shell must expand the file's path.
	if (options.carryCwd) parts.push("--env", `"${CWD_FILE_VAR}=$__pt_f"`);
	if (options.report) parts.push("--env", `"${FACTS_FILE_VAR}=$__pt_f.f"`);
	parts.push("--", shellQuote(options.shell), "-c", shellQuote(prelude + trap + command));
	return (trap === "" ? "" : CWD_PREAMBLE) + parts.join(" ") + epilogue(options);
}

/**
 * `busybox run` and its flags, each already quoted for a shell: everything before `--`.
 *
 * Shared by the two ways a command reaches the capture: the wrapper above, which appends
 * the shell and the command, and the shell shim, which appends the host's own line.
 */
export function runPrefix(options: Omit<WrapOptions, "shell" | "carryCwd" | "report" | "liveFile">): string[] {
	const ladder = LADDER[options.verbosity];
	const env = options.noEnv ? [] : envFlags(options);
	const parts = [shellQuote(options.busybox), "run"];
	if (ladder.timestamps) {
		parts.push("--timestamps");
		// Microsecond stamps cannot tell two events in the same microsecond apart, and the
		// clock is finer than that. Older captures stay readable: every parser takes both.
		if (options.stampNs) parts.push("--stamp-ns");
	}
	parts.push(...ladder.flags);
	// The terminal goes after the view flags: it changes how the child buffers, not what
	// the view means.
	const pty = options.pty ?? "off";
	parts.push(...ptyFlags(pty));
	if (pty !== "off") parts.push("--pty-size", PTY_SIZE);
	// No `--prune`: the artifact root is shared by every session on the machine — this
	// plugin's, a subagent's, pi's — and "keep the newest 20" let twenty commands in one
	// of them delete the capture another had just been pointed at. The hooks module sweeps
	// by count *and* age instead (see RUN_RETENTION).
	if (options.timeoutSeconds !== undefined) {
		// Emitted verbatim: the caller decides the number. The hooks module pre-empts the
		// host's own deadline before calling in, so the applet's deadline fires first and
		// still prints the timeline, instead of the host's kill printing nothing.
		parts.push("--timeout", String(Math.max(0, Math.floor(options.timeoutSeconds))));
	}
	if (options.idleSeconds !== undefined && options.idleSeconds > 0) {
		parts.push("--idle-timeout", String(Math.floor(options.idleSeconds)));
	}
	for (const flag of env) parts.push("--env", flag);
	return parts;
}

/** A value made literal inside a shell's double quotes. */
function inDoubleQuotes(value: string): string {
	return value.replace(/[\\"$`]/g, "\\$&");
}

/**
 * The `NAME=VALUE` arguments of the wrapper's environment, each quoted for the shell.
 *
 * Four ways a variable meets what the person already has, because one rule does not fit:
 *
 * - assigned: a switch with one right value here (`PYTHONUNBUFFERED=1`, `TERM=dumb`);
 * - appended: an option list, where theirs must survive and ours comes last
 *   (`"RUBYOPT=${RUBYOPT:+$RUBYOPT }-r…"`) — `RUBYOPT`, `PERL5OPT`, `MAVEN_ARGS`,
 *   `GRADLE_OPTS`;
 * - only if unset: a snippet that cannot be merged with another (`LUA_INIT`);
 * - joined with a colon: a path list (`LD_PRELOAD`).
 *
 * The merging forms are double-quoted so the shell that runs the wrapper expands them:
 * Claude Code's own shell for a tool call, `/bin/sh` in the shim for a `!` command. The
 * person's extra environment comes last, and the last assignment of a name wins.
 */
function envFlags(options: Omit<WrapOptions, "shell" | "carryCwd" | "report" | "liveFile">): string[] {
	const isUnbuffered = options.unbuffer !== false;
	const assign = ([name, value]: readonly [string, string]) => shellValue(`${name}=${value}`);
	const append = (name: string, value: string) => `"${name}=\${${name}:+$${name} }${inDoubleQuotes(value)}"`;
	const flags: string[] = [];
	if (isUnbuffered) flags.push(...STREAM_ENV.map(assign));
	flags.push(...QUIET_ENV.map(assign));
	for (const [name, value] of TOOL_OPTIONS_ENV) flags.push(append(name, value));
	if (isUnbuffered) {
		flags.push(`"LUA_INIT=\${LUA_INIT:-${inDoubleQuotes(LUA_INIT)}}"`);
		// Each only when its file is actually on disk: an option naming a missing file
		// makes every ruby, or every perl, fail to start.
		if (options.rubyPrelude) flags.push(append("RUBYOPT", `-r${options.rubyPrelude}`));
		if (options.perlPrelude) flags.push(append("PERL5OPT", `-I${options.perlPrelude} -M${PERL_PRELUDE_MODULE}`));
		if (options.stdbufLib) {
			flags.push(`"LD_PRELOAD=\${LD_PRELOAD:+$LD_PRELOAD:}${inDoubleQuotes(options.stdbufLib)}"`, assign(["_STDBUF_O", "L"]));
		}
	}
	flags.push(...(options.extraEnv ?? []).map(assign));
	return flags;
}

/**
 * How many run directories are always kept for `busybox log`, whatever their age.
 *
 * The root is shared by every session on the machine, so the number has to cover all of
 * them at once; a run beyond it is only removed once it is also older than RUN_MIN_AGE_MINUTES.
 */
export const RUN_RETENTION = 200;

/** A run younger than this is never swept: a session may still be pointed at it. */
export const RUN_MIN_AGE_MINUTES = 120;

/**
 * Default deadline for every wrapped command, in seconds.
 *
 * A model that hits a hanging command — a loop on a bad path, a server that never exits, a
 * prompt waiting on stdin — otherwise waits until the harness gives up, which can be
 * minutes of nothing. Two minutes is long enough for a real build step and short enough
 * that the model gets a *recoverable* answer instead of silence.
 */
export const DEFAULT_TIMEOUT_SECONDS = 120;

/**
 * `CLAUDE_MANAGED_TOOLS_TIMEOUT` overrides it: seconds, or `0`/`off` for no default.
 *
 * A caller's own timeout always wins (the Bash tool's `timeout` parameter); this is only
 * the default when nobody asked for one. With no default the host's own deadline still
 * applies, and the hooks module still takes it over so the timeline survives.
 */
export function readDefaultTimeout(env: Env = {}, fallback?: number): number {
	const base =
		typeof fallback === "number" && Number.isFinite(fallback) && fallback >= 0
			? Math.floor(fallback)
			: DEFAULT_TIMEOUT_SECONDS;
	const raw = (env.CLAUDE_MANAGED_TOOLS_TIMEOUT ?? "").trim().toLowerCase();
	if (raw === "") return base;
	if (raw === "0" || raw === "off" || raw === "false" || raw === "no" || raw === "none") return 0;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds <= 0) return base;
	return Math.floor(seconds);
}

/**
 * The escape, stated once, for the skill. It is not in the prompt: an escape that is
 * advertised is an escape that is taken, and what it is for almost never happens.
 */
export const RAW_ESCAPE =
	"What runs inside a command already sees exact bytes — a pipe into `jq`, a redirect, a checksum; only the result read back carries the offsets, and `command x` is just the shell builtin, wrapped like anything else. Ending a command with `# pitime-raw` returns that one result unwrapped: no timeline, no stream tags, no timing. Almost never needed.";

/** Plain-English meaning of each level, so choosing one is not a guess. */
export function describeVerbosity(level: Verbosity): string {
	switch (level) {
		case "quiet":
			return "timeline, 6 KB view";
		case "verbose":
			return "timeline, 27 KB view (the most Claude Code shows inline)";
		case "brief":
			return "repeats collapsed, no timeline";
		default:
			return "timeline, 24 KB view";
	}
}

/**
 * Ruby has no environment variable for `$stdout.sync`, but `RUBYOPT` is inherited by
 * every ruby process, so a two-line prelude sets it for the whole tree.
 *
 * This is the only way to un-buffer Ruby from outside the program; Go's `os.Stdout` is
 * already unbuffered (a `bufio.Writer` inside the program is not ours to fix) and
 * Java's `System.out` has no such switch at all.
 */
export const RUBY_PRELUDE = "$stdout.sync = true\n$stderr.sync = true\n";

/** File name of the Ruby prelude, written into the plugin's data folder. */
export const RUBY_PRELUDE_NAME = "pitime-unbuffer.rb";

/**
 * Perl has no variable for `$|` either, but `PERL5OPT` may name a module to load, and a
 * module that sets `$|` at load time sets it on STDOUT, the handle selected then.
 * Perl's STDERR is unbuffered already. (`perl -T` ignores `PERL5OPT`, and so this.)
 */
export const PERL_PRELUDE_MODULE = "PiTimeUnbuffer";

/** The module's file, written into the plugin's data folder and found through `-I`. */
export const PERL_PRELUDE_NAME = `${PERL_PRELUDE_MODULE}.pm`;

export const PERL_PRELUDE = `package ${PERL_PRELUDE_MODULE};\n# Loaded through PERL5OPT by the managed-tools plugin: STDOUT writes each line as it is printed.\n$| = 1;\n1;\n`;
