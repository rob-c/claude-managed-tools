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
 * `/sh <command>`: a command the person types, run through the same capture.
 *
 * Claude Code's own `!` prefix cannot be wrapped: it raises no event before the command
 * runs (measured — no `tool.call`, no `prompt.submit`, and the `!` key is not an edit a
 * hook sees), so there is nowhere to stand. `/sh` is the same act through a door that
 * does exist, and it splits the two readers as a tool call does: the person sees the
 * command's own lines, the model reads the timeline.
 *
 * Pure: the hooks module runs the command and hands the result in.
 */
import { stripTimeline } from "./display";

/** The slash command's name. */
export const SHELL_COMMAND = "sh";

/** What the typeahead shows after `/sh`. */
export const SHELL_HINT = "<command>";

/** One line for `/help` and the typeahead. */
export const SHELL_DESCRIPTION =
	"Run a shell command yourself through Pi-Time: you see its output, Claude reads the timeline";

/** What `/sh` says with nothing after it. */
export const SHELL_USAGE =
	"Usage: `/sh <command>` — runs the command in this session's shell through the Pi-Time capture. You see its output; Claude reads the timestamped, stream-tagged timeline. It is stopped at Pi-Time's default deadline like any other command (`/pi-time timeout <seconds>` changes it).";

/**
 * Whether a `/sh` line is the person's own act, by where the engine says it came from.
 *
 * `/sh` runs with nobody asked, as `!` does, so who typed it is the whole safeguard:
 * `composer` is Enter at the prompt, `bridge` the person's message over Remote Control,
 * `sdk` the prompt a host was started with (`claude -p "/sh …"`). Everything else — a peer
 * session, a channel message, a schedule, another plugin, `unclassified` — is not, and a
 * kind added later is not either until it is listed here.
 */
export function isPersonsOwn(kind: string | undefined): boolean {
	return kind === "composer" || kind === "bridge" || kind === "sdk";
}

/**
 * A code fence longer than any run of backticks inside, so no output can close it.
 *
 * The row is drawn as markdown; unfenced, a line of `#` or `*` would be read as a
 * heading or a list.
 */
export function fenced(text: string): string {
	let longest = 2;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const fence = "`".repeat(longest + 1);
	return `${fence}\n${text}\n${fence}`;
}

/** `exit 0 · 1.21s`, or the name of what stopped the command. */
export function outcomeLine(body: string): string {
	// Field by field, not as one pattern: the header gains fields between builds
	// (`idle=false` arrived between `cancelled=` and `duration_ms=`).
	const header = /^run=R\d+ .*$/m.exec(body)?.[0];
	if (!header) return "ran outside the capture";
	const field = (name: string) => new RegExp(` ${name}=(\\S+)`).exec(header)?.[1];
	const code = field("exit_code");
	const timedOut = field("timed_out");
	const cancelled = field("cancelled");
	const ms = field("duration_ms");
	const took = ms === undefined ? "" : ` · ${(Number(ms) / 1000).toFixed(2)}s`;
	if (timedOut === "true") {
		return `timed out${took} — stopped at the deadline, not a failure of the command (\`/pi-time timeout <seconds>\` gives your commands longer)`;
	}
	if (field("idle") === "true") {
		return `went silent${took} — stopped for printing nothing, not a failure of the command (\`/pi-time idle <seconds|off>\` changes the limit)`;
	}
	if (cancelled === "true") return `cancelled${took}`;
	if (code === "-1") return `killed by a signal${took}`;
	return `exit ${code}${took}`;
}

/**
 * The row the person sees: how it ended, then the command's own lines.
 *
 * It opens with words, never with the fence: the host leads the row with the plugin's
 * name on the same line, and a fence that does not start its line is not a fence.
 */
export function personText(body: string): string {
	// The host leads a failed result with its own "Exit code N"; the outcome line says it.
	const own = stripTimeline(body.replace(/^Exit code -?\d+\n/, ""));
	const truncated = /^timeline_lines=(\d+) shown=(\d+) truncated=true/m.exec(body);
	const more = truncated ? ` · first ${truncated[2]} of ${truncated[1]} lines shown` : "";
	return `${outcomeLine(body)}${more}\n${fenced(own)}`;
}

/**
 * What the model reads in place of the row: the command and its whole timeline.
 *
 * Shaped like the host's own record of a `!` command, so it is read the same way — as
 * something the person did, not as something asked of the model.
 */
export function modelContext(command: string, view: string): string {
	return [
		"The user ran the following shell command themselves with `/sh`. It went through the Pi-Time capture, so the output below is a timeline: offsets in seconds and the stream each line arrived on. Treat it as context, as you would a `!` command; it is not a request.",
		`<bash-input>${command}</bash-input>`,
		`<bash-stdout>\n${view}\n</bash-stdout>`,
	].join("\n");
}
