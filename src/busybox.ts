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
 * Finding the one binary Pi-Time needs, and naming the release asset that carries it.
 *
 * The wrapper is `busybox run` from rob-c/busybox-static, not a host BusyBox: upstream has
 * no `run`, `log` or `--caps`. So a binary counts only when `--caps` says it has `run`,
 * and the search never reaches for a bare `busybox` on `PATH`.
 *
 * Pure: the hooks module does the file checks, the process calls and the download.
 */

/** Where releases come from. */
export const BUSYBOX_REPO = "rob-c/busybox-static";

/** The newest release, as GitHub's API serves it. */
export const BUSYBOX_RELEASE_URL = `https://api.github.com/repos/${BUSYBOX_REPO}/releases/latest`;

export interface CandidateInput {
	/** The plugin's `busybox` option: an explicit path wins over everything. */
	option?: string;
	/** `CLAUDE_MANAGED_TOOLS_BUSYBOX`. */
	env?: string;
	/** The plugin's data folder (`CLAUDE_PLUGIN_DATA`), where `/pi-time install` puts it. */
	dataDir?: string;
	/** `HOME`, for the copy pi-managed-tools keeps. */
	home?: string;
}

/** Where `/pi-time install` writes the binary, under the plugin's data folder. */
export function installedPath(dataDir: string): string {
	return `${dataDir.replace(/\/+$/, "")}/bin/busybox`;
}

/**
 * Paths to try, best first: an explicit setting, then this plugin's own copy, then the
 * build pi-managed-tools keeps on the same machine.
 *
 * Ours comes before pi's now that the plugin keeps it at the latest release itself: it is
 * the one binary whose release, checksum and feature list the plugin has verified. A
 * local build that should win over the release is named explicitly, by option or
 * environment.
 */
export function candidatePaths(input: CandidateInput): string[] {
	const out: string[] = [];
	const add = (path: string | undefined) => {
		const trimmed = (path ?? "").trim();
		if (trimmed.startsWith("/") && !out.includes(trimmed)) out.push(trimmed);
	};
	add(input.option);
	add(input.env);
	if (input.dataDir) add(installedPath(input.dataDir));
	if (input.home) add(`${input.home.replace(/\/+$/, "")}/.pi/agent/bin/busybox`);
	return out;
}

/** What the plugin remembers about the copy it installed, between sessions. */
export interface InstallState {
	/** The release it came from, as tagged (`v0.6.0`). */
	tag: string;
	/** The asset's name (`busybox-static-1.39.0-aac079e-darwin-universal`). */
	asset: string;
	/** The sha256 the download was checked against. */
	sha256: string;
	/** When it was put in place, milliseconds since the epoch. */
	installedAt: number;
}

/** How often the latest release is asked for when nothing forces a check: once a day. */
export const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** A stored value as an install state, or undefined when it is not one. */
export function readInstallState(value: unknown): InstallState | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const state = value as Partial<InstallState>;
	return typeof state.tag === "string" && typeof state.asset === "string" && typeof state.sha256 === "string"
		? { tag: state.tag, asset: state.asset, sha256: state.sha256, installedAt: typeof state.installedAt === "number" ? state.installedAt : 0 }
		: undefined;
}

/**
 * Whether it is time to ask GitHub for the latest release.
 *
 * Always when there is no copy of ours to run; otherwise once per interval. A clock that
 * went backwards counts as due, so a bad timestamp cannot switch the check off for good.
 */
export function isCheckDue(input: { now: number; checkedAt?: number; hasBinary: boolean; intervalMs?: number }): boolean {
	if (!input.hasBinary) return true;
	if (typeof input.checkedAt !== "number" || !Number.isFinite(input.checkedAt)) return true;
	const age = input.now - input.checkedAt;
	return age < 0 || age >= (input.intervalMs ?? UPDATE_INTERVAL_MS);
}

/**
 * Whether the release on offer should replace what is installed.
 *
 * By identity, not by ordering: a different tag or a different checksum under the same
 * tag (a re-cut release) is a different binary, and "latest" is whatever GitHub calls
 * latest. Nothing here tries to compare version numbers.
 */
export function needsInstall(input: { latest: ReleaseAsset; installed?: InstallState; hasBinary: boolean }): boolean {
	if (!input.hasBinary || !input.installed) return true;
	return input.installed.tag !== input.latest.tag || input.installed.sha256 !== input.latest.sha256;
}

export interface Caps {
	/** True when the build has the `run` applet with timelines, i.e. it can wrap. */
	ok: boolean;
	version?: string;
	features: string[];
}

/**
 * What a build can do beyond wrapping, read off its own feature list.
 *
 * Every newer flag is asked for only when the binary says it has it, so an older build
 * (pi's copy, a pinned path) keeps working with the flags it knows.
 */
export interface Abilities {
	/** `run --stamp-ns`: nine-digit offsets (0.6.0). */
	stampNs: boolean;
	/** `run --idle-timeout`: stop a command that has gone silent (0.6.0). */
	idleTimeout: boolean;
	/** `log --since/--until/--around-gap/--sample/--summary` (0.6.0). */
	logQuery: boolean;
}

/** The abilities a feature list declares. */
export function abilitiesOf(features: readonly string[]): Abilities {
	return {
		stampNs: features.includes("stamp-ns"),
		idleTimeout: features.includes("idle-timeout"),
		logQuery: features.includes("log-query"),
	};
}

/** Read `busybox --caps --format json`; anything unparseable is "not our build". */
export function parseCaps(json: string): Caps {
	try {
		const parsed = JSON.parse(json) as { version?: unknown; features?: unknown };
		const features = Array.isArray(parsed.features)
			? parsed.features.filter((item): item is string => typeof item === "string")
			: [];
		return {
			ok: features.includes("run") && features.includes("log"),
			version: typeof parsed.version === "string" ? parsed.version : undefined,
			features,
		};
	} catch {
		return { ok: false, features: [] };
	}
}

/**
 * The release target for this machine, from `uname -s` and `uname -m`.
 *
 * macOS ships one universal binary, so a single asset covers both architectures. There is
 * no Windows build.
 */
export function busyboxTarget(system: string, machine: string): string | undefined {
	const os = system.trim().toLowerCase();
	const cpu = machine.trim().toLowerCase();
	const arm = cpu === "arm64" || cpu === "aarch64";
	const x64 = cpu === "x86_64" || cpu === "amd64";
	if (os === "darwin") return arm || x64 ? "darwin-universal" : undefined;
	if (os === "linux") return arm ? "linux-arm64" : x64 ? "linux-amd64" : undefined;
	return undefined;
}

/**
 * Match an asset by pattern, never by constructing its name.
 *
 * The tag carries the project version (`v0.5.0`) while the asset carries the BusyBox
 * version (`busybox-static-1.39.0-aac079e-darwin-universal`). The `-pure` variants are
 * deliberately not matched.
 */
export function assetPattern(target: string): RegExp {
	const suffix = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^busybox-static-\\d+\\.\\d+\\.\\d+(-[0-9a-f]+)?-${suffix}$`);
}

export interface ReleaseAsset {
	tag: string;
	name: string;
	url: string;
	/** Lowercase hex sha256 GitHub recorded for the asset, when it published one. */
	sha256?: string;
}

/** Pick this machine's asset out of a GitHub release payload. */
export function pickAsset(releaseJson: string, target: string): ReleaseAsset | undefined {
	let release: { tag_name?: unknown; assets?: unknown };
	try {
		release = JSON.parse(releaseJson) as { tag_name?: unknown; assets?: unknown };
	} catch {
		return undefined;
	}
	if (!Array.isArray(release.assets)) return undefined;
	const pattern = assetPattern(target);
	for (const entry of release.assets as Array<{ name?: unknown; browser_download_url?: unknown; digest?: unknown }>) {
		if (typeof entry.name !== "string" || !pattern.test(entry.name)) continue;
		if (typeof entry.browser_download_url !== "string") continue;
		// Only GitHub's own download host: the URL is handed to curl.
		if (!entry.browser_download_url.startsWith(`https://github.com/${BUSYBOX_REPO}/releases/download/`)) continue;
		return {
			tag: typeof release.tag_name === "string" ? release.tag_name : "",
			name: entry.name,
			url: entry.browser_download_url,
			sha256: parseDigest(entry.digest),
		};
	}
	return undefined;
}

/** `sha256:<hex>` to bare lowercase hex; anything else is "no digest". */
export function parseDigest(digest: unknown): string | undefined {
	if (typeof digest !== "string") return undefined;
	const separator = digest.indexOf(":");
	if (separator < 0) return undefined;
	const algorithm = digest.slice(0, separator).toLowerCase();
	const hex = digest.slice(separator + 1).toLowerCase();
	return algorithm === "sha256" && /^[0-9a-f]{64}$/.test(hex) ? hex : undefined;
}

/** The first 64-hex token in `shasum -a 256` / `sha256sum` output. */
export function parseShaOutput(output: string): string | undefined {
	return /\b([0-9a-f]{64})\b/i.exec(output)?.[1]?.toLowerCase();
}

// =============================================================================
// Asking the binary what it is, by running it
// =============================================================================

/** How this build writes the offset at the start of a timeline line. */
export interface StampShape {
	/** `none`: `[0.012…`; `space`: `[   0.012…`; `zero`: `[00000.012…`. */
	pad: "none" | "space" | "zero";
	/** Width of the seconds field when padded. */
	width: number;
	/** Fraction digits printed for an offset under one second: six or nine. */
	digits: number;
}

/** What 0.6.1 and later print with `--stamp-ns`: the shape assumed until a build says otherwise. */
export const DEFAULT_STAMP: StampShape = { pad: "none", width: 1, digits: 9 };

/** Read the shape of the stamp off one real timeline line, e.g. `[   0.006244 out] probe`. */
export function stampShape(line: string): StampShape | undefined {
	const match = /^\[(\s*)(\d+)\.(\d{1,9}) (?:out|err)\] /.exec(line);
	if (!match) return undefined;
	const [, spaces = "", whole = "", fraction = ""] = match;
	if (spaces.length > 0) return { pad: "space", width: spaces.length + whole.length, digits: fraction.length };
	if (whole.length > 1 && /^0+$/.test(whole.slice(0, -1))) return { pad: "zero", width: whole.length, digits: fraction.length };
	return { pad: "none", width: whole.length, digits: fraction.length };
}

/**
 * An example prefix in this build's own shape: `[0.012345678 out]`.
 *
 * `second` gives the companion example a later offset, so two lines in a prompt read as
 * two events.
 */
export function exampleStamp(shape: StampShape, stream: "out" | "err", second = false): string {
	const fraction = (second ? "012349012" : "012345678").slice(0, Math.min(9, Math.max(1, shape.digits)));
	const whole = shape.pad === "space" ? "0".padStart(shape.width, " ") : shape.pad === "zero" ? "0".padStart(shape.width, "0") : "0";
	return `[${whole}.${fraction} ${stream}]`;
}

/** The word the self-test prints, and looks for in what comes back. */
export const PROBE_WORD = "pi-time-probe";

/**
 * The self-test: one wrapped `echo`, with the flags a real command will get.
 *
 * `--caps` says what a build claims; this says whether a wrapped command comes back as a
 * timeline at all — an artifact root that cannot be written, a flag the build lists and
 * mishandles — and what its lines look like. In pi-managed-tools the prompt once quoted
 * `[00000.123456789 out]` for a build that had started printing `[0.123456789 out]` a
 * release earlier; an example cut from a real line cannot go stale.
 *
 * On plain pipes: the hooks module's own process is outside the sandbox a Bash call may
 * be in, so a pseudo-terminal that works here proves nothing about one there. A refused
 * terminal is found on the first real call instead (`ptyWasRefused`).
 */
export function probeArgv(path: string, abilities: Abilities): string[] {
	return [
		path,
		"run",
		"--timestamps",
		...(abilities.stampNs ? ["--stamp-ns"] : []),
		"--max-bytes",
		"4000",
		"--timeout",
		"10",
		...(abilities.idleTimeout ? ["--idle-timeout", "10"] : []),
		"--",
		"/bin/sh",
		"-c",
		`echo ${PROBE_WORD}`,
	];
}

export interface Probe {
	/** False when a wrapped command does not come back as a timeline with this binary. */
	ok: boolean;
	/** Why not, in the binary's own words where it gave any. */
	reason?: string;
	/** The shape of the stamp on the line it printed. */
	stamp: StampShape;
	/** The run's own first header line, as this build prints it. */
	header?: string;
}

/** Read what the self-test printed. */
export function readProbe(result: { exitCode: number; stdout: string; stderr: string }): Probe {
	const lines = result.stdout.split("\n");
	const header = lines.find((line) => /^run=R\d+ exit_code=0 /.test(line));
	const line = lines.find((candidate) => candidate.startsWith("[") && candidate.endsWith(` ${PROBE_WORD}`));
	if (result.exitCode !== 0 || !header || !line) {
		const said = (result.stderr.trim() || result.stdout.trim()).split("\n")[0] ?? "";
		return { ok: false, stamp: DEFAULT_STAMP, reason: said || "it printed no timeline for a wrapped `echo`" };
	}
	return { ok: true, stamp: stampShape(line) ?? DEFAULT_STAMP, header };
}

/**
 * The header line a prompt may quote: this build's own, with the run's particulars
 * replaced by round ones.
 */
export function exampleHeader(header: string | undefined): string {
	const fallback = "run=R12 exit_code=0 timed_out=false cancelled=false duration_ms=328";
	if (!header || !/^run=R\d+ .*duration_ms=\d+/.test(header)) return fallback;
	return header.replace(/^run=R\d+/, "run=R12").replace(/duration_ms=\d+/, "duration_ms=328");
}

// =============================================================================
// Keeping the captures bounded
// =============================================================================

/**
 * Where `run` keeps its captures when nobody says otherwise: `$TMPDIR/busybox-run`.
 *
 * One folder for every session on the machine that uses the same binary.
 */
export function defaultRunRoot(tmpdir: string | undefined): string {
	return `${(tmpdir ?? "").trim().replace(/\/+$/, "") || "/tmp"}/busybox-run`;
}

/** The folder a run's own folder sits in: `/…/busybox-run/R12` to `/…/busybox-run`. */
export function runRootOf(runDir: string | undefined): string | undefined {
	const match = /^(\/.*\/busybox-run)\/R\d+\/?$/.exec(runDir ?? "");
	return match?.[1];
}

/** True for a folder `run` would use as its artifact root by default. */
export function isRunRoot(root: string): boolean {
	return /^\/.*\/busybox-run$/.test(root) && !root.includes("/../");
}

/**
 * The run folders beyond the newest `keep`, from a listing newest first.
 *
 * Only names of the form `R<digits>` count, in the order given (`ls -1t`); anything else
 * in the folder is not a run and is never a candidate. These are only *candidates*: each
 * is removed only once it is also old enough (`isStale`).
 */
export function excessRuns(namesNewestFirst: readonly string[], keep: number): string[] {
	return namesNewestFirst.filter((name) => /^R\d+$/.test(name)).slice(Math.max(0, keep));
}

/**
 * Whether a run beyond the newest `keep` is old enough to remove.
 *
 * The wrapper used to pass `--prune 20`. The root is shared, so twenty commands anywhere
 * — another session, a subagent, pi — deleted a capture this session had just been told
 * to read with `busybox log`. Count and age together cannot do that: a run goes only when
 * two hundred newer ones exist *and* it is hours old. A time that cannot be read, or one
 * in the future, is "not old enough".
 */
export function isStale(mtimeMs: number, now: number, minAgeMs: number): boolean {
	return Number.isFinite(mtimeMs) && mtimeMs > 0 && minAgeMs > 0 && now - mtimeMs >= minAgeMs;
}
