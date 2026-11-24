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
 * The shell shim: how a command the person types with `!` reaches the capture.
 *
 * A `!` command raises no event before it runs, so no hook can wrap it. What Claude Code
 * does honour is `CLAUDE_CODE_SHELL`: the program it launches as "the shell". The plugin
 * points that at a small script which *is* the person's shell for everything, and for one
 * recognised case runs that shell inside `busybox run`.
 *
 * The one case is recognised positively, never by elimination. Tool calls, `!` commands,
 * the Monitor tool and a skill's inline commands all launch the shell the same way, and
 * most of them need raw output, so "anything the hooks did not mark" would be the wrong
 * rule. Instead the hooks keep a hash of what is in the prompt box, and the shim wraps a
 * launch only when its command is exactly that text — which is what a `!` command is.
 *
 * Every doubt resolves to the real shell, untouched: a missing file, a session the plugin
 * is not on in, a launch that is not the host's command line, a hash that does not match.
 *
 * Pure: the hooks module writes the files and sets the variable.
 */
import { shellQuote } from "./wrap";

/** The host's command line around the command: `… && eval '<cmd>' < /dev/null && pwd -P >| <file>`. */
const SHIM_LINES = [
	"#!/bin/sh",
	"# Pi-Time shell shim (managed-tools plugin). Rewritten at every session start: do not edit.",
	"#",
	"# Claude Code is pointed at this file as its shell. It is your real shell for everything",
	'# except one case: a command you typed with "!" in a session where the plugin is on.',
	'# That one runs in your real shell inside "busybox run", so it comes back as a timeline.',
	"# Anything unrecognised, and any doubt, runs your real shell untouched.",
	"dir=${0%/*}",
	"case ${0##*/} in zsh) real=/bin/zsh ;; *) real=/bin/bash ;; esac",
	"sid=${CLAUDE_CODE_SESSION_ID:-none}",
	"# PITIME_SHIM_TRACE=<file> records each decision (never the command), for when a `!`",
	"# command is not wrapped and the reason is wanted.",
	'note() { if [ -n "${PITIME_SHIM_TRACE:-}" ]; then echo "$(date +%T) $sid $1" >> "$PITIME_SHIM_TRACE"; fi; }',
	'pass() { note "real shell: $1"; shift; exec "$real" "$@"; }',
	'conf="$dir/conf-$sid.sh"',
	'if [ -r "$conf" ]; then . "$conf"; fi',
	'if [ -n "${PT_REAL:-}" ] && [ -x "$PT_REAL" ]; then real=$PT_REAL; fi',
	'[ "${PT_ENABLED:-0}" = 1 ] || pass "the plugin is not on in this session" "$@"',
	"# Only the host's own command line is a candidate: `-c <line>`, nothing else.",
	'[ "$#" = 2 ] || pass "not a two-argument launch ($#)" "$@"',
	'[ "$1" = "-c" ] || pass "not a -c launch" "$@"',
	"line=$2",
	'head=" && eval "',
	'tail=" < /dev/null && pwd -P >| "',
	'case $line in *"$head"*"$tail"*) ;; *) pass "not the host\'s command line (it ends: ${line##* && })" "$@" ;; esac',
	'rest=${line#*"$head"}',
	"# The command as the host quoted it for its own eval: in quotes, or bare when it is one",
	"# plain word (`pwd`). Expanding that one word gives the command back without running it.",
	'quoted=${rest%"$tail"*}',
	"cmd=$(eval \"printf '%s' $quoted\" 2>/dev/null) || pass \"could not read the command back\" \"$@\"",
	'[ -n "$cmd" ] || pass "an empty command" "$@"',
	"# Wrap it only if it is exactly what was in the prompt box: that is a `!` command.",
	'want=$(cat "$dir/draft-$sid" 2>/dev/null)',
	'[ -n "$want" ] || pass "no draft recorded" "$@"',
	"have=$(printf '%s' \"$cmd\" | tr -d ' \\t\\n\\r' | \"$PT_BUSYBOX\" sha256sum 2>/dev/null | cut -c1-64)",
	'[ "${#have}" = 64 ] || pass "could not hash the command" "$@"',
	'case " $want " in *" $have "*) ;; *) pass "the command is not the prompt box\'s text (have $have, want $want)" "$@" ;; esac',
	"# The same two escapes a tool call has: a direct busybox call, and a command that ends",
	"# with `# pitime-raw`. (`command x` was the escape through 0.4.0; it is the shell's",
	"# builtin and runs captured, here as in a tool call.)",
	'case $cmd in busybox\\ *|/*/busybox\\ *) pass "a direct busybox call" "$@" ;; esac',
	"if printf '%s' \"$cmd\" | grep -Eq '(^|[[:space:]])#[[:space:]]*pitime-raw[[:space:]]*$'; then pass \"the raw marker\" \"$@\"; fi",
	"# A sandbox refuses a pseudo-terminal; ask first, since a refused run starts nothing.",
	"run=$PT_RUN",
	'if [ "${PT_PTY:-0}" = 1 ] && ! "$PT_BUSYBOX" run --pty-split -- /bin/sh -c : >/dev/null 2>&1; then run=$PT_RUN_NOPTY; note "no pseudo-terminal here: plain pipes"; fi',
	'note "wrapped"',
	'eval "set -- $run"',
	'exec "$@" -- "$real" -c "$line"',
];

/** The shim, as written to disk. */
export const SHIM_SOURCE = `${SHIM_LINES.join("\n")}\n`;

/**
 * The shim's file name: Claude Code tells bash from zsh by the shell's name, and reads
 * the matching profile for its snapshot, so the shim must carry the real shell's.
 */
export function shimName(realShell: string): "zsh" | "bash" {
	return /\/zsh$/.test(realShell) ? "zsh" : "bash";
}

/** The folder, under the plugin's data folder, that holds the shim and its session files. */
export function shimDir(dataDir: string): string {
	return `${dataDir.replace(/\/+$/, "")}/shell`;
}

export interface ShimConf {
	/** False while the wrapper is off: the shim is then the real shell and nothing else. */
	enabled: boolean;
	/** The person's real shell, absolute. */
	real: string;
	busybox: string;
	/** `busybox run …` up to, not including, `--`: tokens already quoted for a shell. */
	run: readonly string[];
	/** The same with no pseudo-terminal, for a sandbox that refuses one. */
	runNoPty: readonly string[];
	/** Whether `run` asks for a pseudo-terminal, i.e. whether the shim should check first. */
	hasPty: boolean;
}

/** The per-session file the shim sources: plain assignments, every value quoted. */
export function confText(conf: ShimConf): string {
	return [
		`PT_ENABLED=${conf.enabled ? 1 : 0}`,
		`PT_REAL=${shellQuote(conf.real)}`,
		`PT_BUSYBOX=${shellQuote(conf.busybox)}`,
		`PT_PTY=${conf.hasPty ? 1 : 0}`,
		`PT_RUN=${shellQuote(conf.run.join(" "))}`,
		`PT_RUN_NOPTY=${shellQuote(conf.runNoPty.join(" "))}`,
		"",
	].join("\n");
}

/**
 * A draft reduced to what both sides can compute alike: no spaces, tabs or line ends.
 *
 * The shim strips the same four characters with `tr` before it hashes, so a trailing
 * space or a final newline cannot make a `!` command miss its own draft.
 */
export function draftKey(text: string): string {
	return text.replace(/[ \t\n\r]+/g, "");
}

/**
 * The keys a draft may be run under: as it stands, and without a leading `!`.
 *
 * Typed, the `!` switches the box to shell mode and is not part of the draft; pasted with
 * the rest it may be. Empty drafts have no key: nothing must match "nothing".
 */
export function draftKeys(draft: string): string[] {
	const keys: string[] = [];
	for (const candidate of [draft, draft.replace(/^\s*!/, "")]) {
		const key = draftKey(candidate);
		if (key !== "" && !keys.includes(key)) keys.push(key);
	}
	return keys;
}

/** The text of a session-row block, or undefined when the row is not that block. */
export function bashBlock(text: string, tag: "bash-input" | "bash-stdout"): string | undefined {
	const open = `<${tag}>`;
	const close = `</${tag}>`;
	const start = text.indexOf(open);
	const end = text.lastIndexOf(close);
	return start === 0 && end >= open.length ? text.slice(open.length, end) : undefined;
}

/** A `<bash-stdout>` row with its body replaced, whatever follows the block kept. */
export function withStdout(text: string, body: string): string {
	const close = "</bash-stdout>";
	const end = text.lastIndexOf(close);
	return `<bash-stdout>${body}${text.slice(end)}`;
}
