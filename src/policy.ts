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
 * Deadline and shell policy: the two decisions the hooks module makes per call that are
 * about Claude Code rather than about the wrapper.
 *
 * `wrap.ts` is a formatter — a number in is the same number out. Who owns the deadline,
 * and by how much the applet pre-empts the host, is decided here and nowhere else (the
 * pi package once subtracted the grace in two places and turned a 3s deadline into 1s).
 */

/** Claude Code's own default for a Bash call with no `timeout`, in milliseconds. */
export const HOST_DEFAULT_TIMEOUT_MS = 120_000;

/** Claude Code's ceiling for a foreground Bash call, in milliseconds. */
export const HOST_MAX_TIMEOUT_MS = 600_000;

/** How long the host waits past the applet's own deadline when the plugin set both. */
export const HOST_GRACE_SECONDS = 5;

export interface DeadlineInput {
	/** The Bash tool's `timeout` parameter for this call, in milliseconds, when the model gave one. */
	askedMs?: number;
	/** The plugin's default deadline in seconds; 0 means "none of ours, the host's applies". */
	defaultSeconds: number;
	/** `BASH_DEFAULT_TIMEOUT_MS`, when the environment sets it. */
	hostDefaultMs?: number;
	/** `BASH_MAX_TIMEOUT_MS`, when the environment sets it. */
	hostMaxMs?: number;
}

export interface DeadlinePlan {
	/** `busybox run --timeout`: the applet's deadline, in seconds. */
	budgetSeconds: number;
	/** The `timeout` to pass on the re-issued Bash call; undefined leaves the host's default. */
	hostTimeoutMs: number | undefined;
	/** Which deadline this is, so a notice can name the right one. */
	source: "caller" | "default" | "host";
}

function positive(value: number | undefined): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Decide the applet's deadline and the host's, so the applet's always fires first.
 *
 * When the applet's own `--timeout` fires it stops the child's process group and still
 * prints the timeline. When the host's fires first the model gets no timeline at all, so
 * in every branch the applet's number is the smaller one.
 *
 * - The model asked for N ms: the applet takes N-1s and the host keeps N.
 * - Nobody asked, the plugin has a default D: the applet takes D and the host is given
 *   D + grace, clamped to the host's ceiling (and D with it).
 * - Nobody asked and the plugin's default is off: the host's own default applies and the
 *   applet takes it over one second early.
 */
export function planDeadline(input: DeadlineInput): DeadlinePlan {
	const hostDefaultMs = positive(input.hostDefaultMs) ?? HOST_DEFAULT_TIMEOUT_MS;
	// The effective ceiling is the larger of the two, as the host itself computes it.
	const ceilingMs = Math.max(positive(input.hostMaxMs) ?? HOST_MAX_TIMEOUT_MS, hostDefaultMs);
	const asked = positive(input.askedMs);
	if (asked !== undefined) {
		const hostTimeoutMs = Math.min(Math.floor(asked), ceilingMs);
		return {
			budgetSeconds: Math.max(1, Math.floor(hostTimeoutMs / 1000) - 1),
			hostTimeoutMs,
			source: "caller",
		};
	}
	const wanted = positive(input.defaultSeconds);
	if (wanted !== undefined) {
		const most = Math.max(1, Math.floor(ceilingMs / 1000) - HOST_GRACE_SECONDS);
		const budgetSeconds = Math.min(Math.floor(wanted), most);
		return {
			budgetSeconds,
			hostTimeoutMs: (budgetSeconds + HOST_GRACE_SECONDS) * 1000,
			source: "default",
		};
	}
	return {
		budgetSeconds: Math.max(1, Math.floor(hostDefaultMs / 1000) - 1),
		hostTimeoutMs: undefined,
		source: "host",
	};
}

/** Shells the wrapped child may use, in the order tried when nothing better is known. */
export const FALLBACK_SHELLS: readonly string[] = ["/bin/bash", "/usr/bin/bash", "/usr/local/bin/bash", "/bin/sh"];

/**
 * The shells to try for the wrapped child, best first.
 *
 * Claude Code runs a Bash call in the person's own shell when that is bash or zsh
 * (`CLAUDE_CODE_SHELL` overrides `SHELL`). The child keeps the same one, so a command
 * that works unwrapped — zsh globbing, `[[ ]]`, arrays — works wrapped. Any other login
 * shell (fish, nu) is not what the host would have used either, so bash is next.
 */
export function shellCandidates(env: Readonly<Record<string, string | undefined>> = {}): string[] {
	const out: string[] = [];
	for (const candidate of [env.CLAUDE_CODE_SHELL, env.SHELL]) {
		const path = (candidate ?? "").trim();
		if (path.startsWith("/") && /\/(?:bash|zsh)$/.test(path) && !out.includes(path)) out.push(path);
	}
	for (const path of FALLBACK_SHELLS) if (!out.includes(path)) out.push(path);
	return out;
}
