/**
 * The view-correctness guard: keep the model's picture of a run honest.
 *
 * A stream merge (`2>&1` and friends) inside a command makes the timeline lie — stderr
 * arrives tagged `[out]` — so the reflex is blocked *before* the command runs and the
 * model is asked to rewrite it, rather than being told afterwards that it fooled itself.
 *
 * The scope is deliberately narrow: only the command's **tail** — the last two lines,
 * the last ~24 characters of each — is checked. A `2>&1` deep inside a long heredoc the
 * model authored is first-order scripting, left alone (the override marker exists for
 * the honest tail case anyway). A rule that nags on complex scripts gets disabled by its
 * users; a rule that catches `cmd >log 2>&1 &` at the point of reflex does not.
 */

/** Patterns that merge the two streams inside the child, defeating the tags. */
const MERGE_PATTERNS: { pattern: RegExp; label: string }[] = [
	{ pattern: /2>\s*&1/, label: "2>&1" },
	{ pattern: /\|&/, label: "|&" },
	{ pattern: /(?:^|\s)&>>?/, label: "&>" },
];

/** Declaring a merge intentional: the marker survives as a comment on any shell. */
export const OVERRIDE_MARKER = "# pitime-safe";

const TAIL_LINES = 2;
const TAIL_CHARS = 24;

/**
 * The only region the guard inspects: the tail of each of the last two lines.
 * `server … 2>&1 &` on the second-to-last line (before an `echo started`) is the other
 * reflex shape the benchmark caught, hence two lines and not one.
 */
export function tailZone(command: string): string[] {
	const lines = command.replace(/\s+$/, "").split("\n");
	return lines.slice(-TAIL_LINES).map((line) => line.slice(-TAIL_CHARS));
}

export interface MergeHit {
	label: string;
	excerpt: string;
}

/** The merge sitting at the command's tail, if there is one. */
export function detectTailMerge(command: string): MergeHit | undefined {
	for (const zone of tailZone(command)) {
		for (const { pattern, label } of MERGE_PATTERNS) {
			const match = pattern.exec(zone);
			if (match) return { label, excerpt: zone.trim() };
		}
	}
	return undefined;
}

/** The model's explicit declaration that a merge is intentional. */
export function hasOverride(command: string): boolean {
	return /(?:^|\s)#\s*pitime-safe\b/.test(command);
}

/**
 * `CLAUDE_MANAGED_TOOLS_GUARD=off` disables the block; the notes are not affected.
 * Unset, the plugin's own `guard` option decides (on by default).
 */
export function guardEnabled(env: Readonly<Record<string, string | undefined>> = {}, fallback = true): boolean {
	const raw = (env.CLAUDE_MANAGED_TOOLS_GUARD ?? "").trim().toLowerCase();
	if (raw === "") return fallback;
	return !(raw === "0" || raw === "off" || raw === "false" || raw === "no");
}

/** The refusal the model receives, so a rewrite — not a retry of the same — follows. */
export function blockReason(hit: MergeHit, busybox = "busybox"): string {
	return [
		`Blocked before running: \`${hit.label}\` at the command's tail (\`${hit.excerpt}\`) merges stderr into stdout inside the child, so the timeline loses the [err] tag — Pi-Time forbids it.`,
		`Rewrite instead: silence one stream only (\`cmd >/dev/null\` keeps stderr tagged), read warnings from the [err] lines or \`${busybox} log <R> --stream stderr --match <literal>\`, and log a background server as \`cmd >srv.log 2>srv.err &\`.`,
		`If the merge is genuinely intended and you will not read that output back as evidence, append \`${OVERRIDE_MARKER}\` to the command and say why in a comment.`,
	].join("\n");
}

/** What the guest shell left behind about how it ended (see the EXIT trap in wrap.ts). */
export interface RunFacts {
	/** Exit status of every stage of the last pipeline, in order. */
	pipestatus?: number[];
	/** The run's own folder, as `run` named it to the guest (`$BUSYBOX_RUN_DIR`). */
	runDir?: string;
}

/** The line the wrapper's epilogue prints on stderr, after the capture: the guest's facts. */
const FACTS_LINE = /^pitime_facts ps=\[([0-9 ]*)\] dir=(.*)$/;

/**
 * Take the facts line out of a text, and say what it carried.
 *
 * The line is the wrapper's, not the command's: it is printed by the outer shell after
 * `busybox run` has exited, so it can never sit inside a timeline and it is always the
 * last such line. It is written to stderr, and where it turns up is the host's choice:
 * measured, Claude Code's Bash hands a command's stderr back inside `stdout`, after what
 * the command printed there — so the caller looks in both. Only the last such line is
 * the wrapper's, and only that one is removed.
 */
export function takeFacts(text: string): { text: string; facts?: RunFacts } {
	if (!text.includes("pitime_facts ps=[")) return { text };
	const lines = text.split("\n");
	for (let index = lines.length - 1; index >= 0; index--) {
		const match = FACTS_LINE.exec(lines[index] as string);
		if (!match) continue;
		const statuses = (match[1] as string).trim();
		const dir = (match[2] as string).trim();
		lines.splice(index, 1);
		return {
			text: lines.join("\n"),
			facts: {
				...(statuses !== "" ? { pipestatus: statuses.split(/\s+/).map(Number) } : {}),
				...(dir.startsWith("/") ? { runDir: dir } : {}),
			},
		};
	}
	return { text };
}

export interface NoteOptions {
	/** The whole call ran unwrapped: it ended with `# pitime-raw`. */
	escaped?: boolean;
	/**
	 * The wrapper carried the final directory back to the host's shell, so `cd` behaves
	 * as it does without the wrapper and needs no note.
	 */
	cwdCarried?: boolean;
	/**
	 * Notes already given in full this session. A note seen before comes back in a few
	 * words: the same two lines on every `| head` call are read once and then skimmed
	 * past, which is the opposite of what a caveat is for.
	 */
	seen?: Set<string>;
	/** What the run itself reported, when it did: a fact replaces a guess. */
	facts?: RunFacts;
	/** The header's exit code, so a note about a status is only made when it applies. */
	exitCode?: number;
}

/** One line for a pipeline's stage statuses, or undefined when they say nothing new. */
export function describePipestatus(pipestatus: number[], exitCode?: number): string | undefined {
	if (pipestatus.length < 2) return undefined;
	// The trap sees the *last* pipeline. If the script went on to exit with something
	// else (`a | b; exit 7`), these are not the statuses behind the header's code.
	if (exitCode !== undefined && pipestatus[pipestatus.length - 1] !== exitCode) return undefined;
	// All zero: nothing in the pipeline disagrees with the header.
	if (pipestatus.every((status) => status === 0)) return undefined;
	const earlier = pipestatus.slice(0, -1);
	const parts = [`pipeline stage statuses: ${pipestatus.join(" ")} — the exit_code shown is the last stage's`];
	if (earlier.includes(141)) parts.push("141 is a stage ended by SIGPIPE because the next stage stopped reading, not a failure of its own");
	const failed = earlier.filter((status) => status !== 0 && status !== 141);
	if (failed.length > 0) parts.push(`an earlier stage failed (${failed.join(", ")}) and the header does not show it`);
	return `${parts.join("; ")}.`;
}

/**
 * What the result should state about what the model *cannot* know from it.
 *
 * The timeline says what arrived; it cannot say what was thrown away. A discarded
 * stream, a backgrounded process and a declared merge each leave a hole in the picture,
 * and naming the hole is what makes the remaining view correct.
 *
 * Where the run reported a fact (`options.facts`), the fact is stated instead of the
 * caveat: "pipeline stage statuses: 1 141 0" replaces "its own status is unknown", and a
 * pipeline whose stages all exited 0 gets no note at all.
 */
export function resultNotes(command: string, options: NoteOptions = {}): string[] {
	const notes: string[] = [];
	// A heredoc's body is data, and what is quoted is an argument: neither is this call's
	// shell. Met in use: a script written through `<<'EOF'` that mentioned `|| true` in a
	// string earned the `|| true` caveat on a call that had none. The stream checks keep
	// quoted text, since `sh -c 'cmd 2>/dev/null'` does discard the stream.
	const code = stripHeredocs(command);
	const bare = maskQuotes(code);
	const note = (key: string, full: string, short: string) => {
		const isRepeat = options.seen?.has(key) === true;
		options.seen?.add(key);
		notes.push(isRepeat ? short : full);
	};
	if (hasOverride(command)) {
		note(
			"override",
			`\`${OVERRIDE_MARKER}\` declared on this call: stream identity in this output was merged or discarded by design — do not read the [out]/[err] tags as evidence about the program.`,
			`\`${OVERRIDE_MARKER}\` declared: the [out]/[err] tags here are not evidence.`,
		);
	}
	if (/(?:^|[\s;&(])1?>\s*\/dev\/null/.test(code)) {
		note("stdout", "stdout was discarded by this command (`>/dev/null`): its content is unknown to you.", "stdout was discarded (`>/dev/null`): unknown.");
	}
	if (/(?:^|[\s;&(])2>\s*\/dev\/null/.test(code)) {
		note("stderr", "stderr was discarded by this command (`2>/dev/null`): its content is unknown to you.", "stderr was discarded (`2>/dev/null`): unknown.");
	}
	if (/(?:^|[\s;])&\s*(?:#.*)?$/m.test(bare) && !/\bwaitfor\b|\bwait\b/.test(bare)) {
		note(
			"background",
			"a process was left running in the background; the timeline stops at this call's exit — check on it before assuming it finished.",
			"a process was left in the background: check on it.",
		);
	}
	if (options.escaped) {
		note(
			"escaped",
			"this call ran unwrapped (`# pitime-raw`): no timeline, no stream tags, no timing. What runs inside a command sees exact bytes anyway; leave the marker off unless this result itself must be unprefixed.",
			"ran unwrapped (`# pitime-raw`): no timeline.",
		);
	}
	// The exit code in the header is the *last pipeline stage's* — three stages make it
	// read wrong more often than right. `head` closes the pipe early (the first command
	// dies of SIGPIPE); `grep` makes exit 1 mean "no match"; and `|| true` replaces a
	// failure with success by design.
	const stage = lastPipelineStage(bare);
	const stages = options.facts?.pipestatus;
	if (stages !== undefined) {
		// Known: say what each stage returned, and nothing when they all returned 0.
		const fact = describePipestatus(stages, options.exitCode);
		if (fact) notes.push(fact);
	} else if (/^head\b/.test(stage)) {
		// Two different facts, so two sentences: `head` can end the command early
		// (SIGPIPE), `tail` never does — it reads to the end and only replaces the status.
		note(
			"head",
			"the pipeline ends in `head`: the exit_code shown is `head`'s, not the command's — and if `head` closed the pipe early the command was ended by SIGPIPE, so its own status is unknown.",
			"exit_code is `head`'s, not the command's.",
		);
	} else if (/^tail\b/.test(stage)) {
		note(
			"tail",
			"the pipeline ends in `tail`: the exit_code shown is `tail`'s, not the command's — the command ran to its end, but its own status is not in this result.",
			"exit_code is `tail`'s, not the command's.",
		);
	}
	// Only when it applies: with the header's code known, a `grep` that matched (0) needs
	// no caveat at all.
	if (/^grep\b/.test(stage) && (options.exitCode === undefined || options.exitCode === 1)) {
		note("grep", "the pipeline ends in `grep`: exit_code 1 means no match, not a failed command.", "`grep` exit 1 = no match.");
	}
	if (/\|\|\s*(?:true|:)(?:\s|;|\)|$)/m.test(bare)) {
		note(
			"or-true",
			"a segment's failure may be hidden by `|| true`: the exit_code shown is `true`'s, not that command's.",
			"`|| true` may hide a failure.",
		);
	}
	// Without the carry a `cd` dies with the wrapped child shell, and the next call
	// starts back where the host's shell was. First line only: heredoc bodies and nested
	// `sh -c` strings are not this call's shell.
	const firstLine = bare.split("\n")[0] ?? "";
	if (!options.cwdCarried && !options.escaped && /(?:^|[;&]\s)cd\s/.test(firstLine.trim())) {
		note(
			"cd",
			"`cd` affects this call only; the next Bash call starts back where this one began — write files where a later call can find them (absolute paths).",
			"`cd` does not carry to the next call.",
		);
	}
	return notes;
}

/**
 * The final pipeline stage of the last line: the stage whose exit status the header shows.
 *
 * A trailing `&` and comment are stripped first. The caller hands in the command with
 * its quoted text blanked, so a `|` inside a pattern separates nothing.
 */
function lastPipelineStage(command: string): string {
	const last = command.trimEnd().split("\n").pop() ?? "";
	const stripped = last.replace(/\s*&\s*$/, "").replace(/\s*#.*$/, "");
	const segments = stripped.split("|");
	return (segments[segments.length - 1] ?? "").trim();
}

// =============================================================================
// Commands that cannot end
// =============================================================================

export interface EndlessHit {
	/** What kind of command it is, in a few words. */
	label: string;
	/** The statement that was recognised. */
	excerpt: string;
	/** What to write instead. */
	rewrite: string;
}

/** Words that run the next word as the command: skipped to find the real one. */
const PREFIX_WORDS = /^(?:sudo|exec|nohup|time|nice|env|stdbuf\s+\S+|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+/;

/** Remove heredoc bodies: they are data, not this call's shell (`cat > notes <<EOF … watch the logs … EOF`). */
function stripHeredocs(command: string): string {
	const out: string[] = [];
	let terminator: string | undefined;
	let stripTabs = false;
	for (const line of command.split("\n")) {
		if (terminator !== undefined) {
			if ((stripTabs ? line.replace(/^\t+/, "") : line) === terminator) terminator = undefined;
			continue;
		}
		out.push(line);
		const start = /<<(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_]*))/.exec(line);
		if (start) {
			stripTabs = start[1] === "-";
			terminator = start[2] ?? start[3] ?? start[4];
		}
	}
	return out.join("\n");
}

/**
 * Blank out everything inside quotes, keeping the length and the line breaks.
 *
 * What is quoted is an argument, not syntax: a `|`, `;` or `&&` in there separates
 * nothing, and a word in there is not in command position. The state carries across
 * lines, so a multi-line `python3 -c '…'` body is blanked whole. A backslash escapes the
 * next character outside single quotes, as the shell has it.
 */
export function maskQuotes(command: string): string {
	let out = "";
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i++) {
		const char = command[i] as string;
		if (quote === undefined) {
			if (char === "\\" && i + 1 < command.length) {
				out += "__";
				i++;
			} else if (char === "'" || char === '"') {
				quote = char;
				out += "_";
			} else out += char;
			continue;
		}
		if (quote === '"' && char === "\\" && i + 1 < command.length) {
			out += command[i + 1] === "\n" ? "_\n" : "__";
			i++;
		} else if (char === quote) {
			quote = undefined;
			out += "_";
		} else out += char === "\n" ? "\n" : "_";
	}
	return out;
}

const SERVER_HINT =
	"run the call with `run_in_background: true` and read its output as it arrives, then stop it when done; or background it inside the command with its output in files (`cmd >srv.log 2>srv.err &`) and check on it in a later call";

/** The rule for one pipeline stage, given whether it is the pipeline's last. */
function endlessStage(stage: string, isLast: boolean): Omit<EndlessHit, "excerpt"> | undefined {
	let words = stage.trim();
	while (PREFIX_WORDS.test(words)) words = words.replace(PREFIX_WORDS, "");
	// Bounded by construction.
	if (/^(?:busybox\s+)?timeout\s/.test(words)) return undefined;
	const [name = "", ...rest] = words.split(/\s+/);
	const args = rest.join(" ");
	const has = (pattern: RegExp) => pattern.test(` ${args} `);
	const base = name.replace(/^.*\//, "");
	if (/--(?:help|version)\b/.test(args)) return undefined;
	switch (base) {
		case "watch":
			return { label: "`watch` repeats until interrupted", rewrite: "run the command once; to wait for a condition, poll it in a bounded loop (`for i in $(seq 30); do cmd && break; sleep 2; done`)" };
		case "vi":
		case "vim":
		case "nvim":
		case "nano":
		case "pico":
			return { label: "an editor waits for keys nobody can press", rewrite: "change files with the Edit tool and read them with the Read tool" };
		case "emacs":
			if (has(/\s--?batch\s/)) return undefined;
			return { label: "an editor waits for keys nobody can press", rewrite: "change files with the Edit tool; `emacs --batch` for a script" };
		case "less":
		case "more":
		case "most":
			if (!isLast) return undefined;
			return { label: "a pager waits for keys nobody can press", rewrite: "drop the pager: the output is captured whole (or read the file with the Read tool)" };
		case "htop":
		case "btop":
			return { label: "a full-screen monitor never exits", rewrite: "`ps aux` (or `top -l 1` on macOS, `top -b -n 1` on Linux) prints once" };
		case "top":
			if (has(/\s-(?:l|b|n)\b/)) return undefined;
			return { label: "`top` redraws until interrupted", rewrite: "`top -l 1` on macOS or `top -b -n 1` on Linux prints once; `ps aux` also does" };
		case "tail":
			if (!isLast || !has(/\s(?:-[A-Za-z0-9]*[fF]\b|--follow\b)/) || has(/\s--pid\b/)) return undefined;
			return { label: "`tail -f` follows until interrupted", rewrite: "read what is there now (`tail -n 50 FILE`); to follow it, run the call with `run_in_background: true`; inside a pipeline that ends (`tail -f FILE | grep -m1 ready`) it is fine" };
		case "journalctl":
			if (!isLast || !has(/\s(?:-[A-Za-z]*f\b|--follow\b)/)) return undefined;
			return { label: "`journalctl -f` follows until interrupted", rewrite: "drop `-f` and bound it (`-n 100`, `--since`)" };
		case "yes":
			if (!isLast) return undefined;
			return { label: "`yes` prints for ever", rewrite: "pipe it into the command that needs the answers (`yes | cmd`), or give the answer once (`printf 'y\\n' | cmd`)" };
		case "sleep":
			if (!has(/\s(?:infinity|inf)\s/)) return undefined;
			return { label: "`sleep infinity` never returns", rewrite: "sleep for a number of seconds, or poll a condition in a bounded loop" };
		case "git":
			if (has(/\srebase\s(?:.*\s)?(?:-i|--interactive)\s/)) {
				return { label: "an interactive rebase opens an editor", rewrite: "`git rebase <base>` without `-i`, or script the todo list with `GIT_SEQUENCE_EDITOR`" };
			}
			if (has(/\sadd\s(?:.*\s)?(?:-i|-p|--interactive|--patch)\s/)) {
				return { label: "`git add -p`/`-i` asks questions nobody can answer", rewrite: "`git add <paths>`, or apply a prepared patch with `git apply --cached`" };
			}
			return undefined;
		case "docker":
		case "podman":
			if (isLast && has(/\slogs\s(?:.*\s)?(?:-[A-Za-z]*f\b|--follow\b)/)) {
				return { label: "`logs -f` follows until interrupted", rewrite: "drop `-f` and bound it (`--tail 100`, `--since 5m`)" };
			}
			if (isLast && has(/\scompose\s(?:.*\s)?up\s/) && !has(/\s(?:-d|--detach|--wait|--abort-on-container-exit|--exit-code-from)\b/)) {
				return { label: "`compose up` stays attached to its containers", rewrite: `\`compose up -d\` (then \`compose logs --tail 50\`), or ${SERVER_HINT}` };
			}
			return undefined;
		case "kubectl":
			if (isLast && has(/\slogs\s(?:.*\s)?(?:-[A-Za-z]*f\b|--follow\b)/)) {
				return { label: "`logs -f` follows until interrupted", rewrite: "drop `-f` and bound it (`--tail=100`, `--since=5m`)" };
			}
			if (isLast && has(/\sport-forward\s/)) return { label: "`port-forward` runs until interrupted", rewrite: SERVER_HINT };
			return undefined;
		case "python":
		case "python3":
			if (isLast && has(/\s-m\s+http\.server\b/)) return { label: "a web server runs until stopped", rewrite: SERVER_HINT };
			return undefined;
		case "php":
			if (isLast && has(/\s-S\s/)) return { label: "a web server runs until stopped", rewrite: SERVER_HINT };
			return undefined;
		case "npm":
		case "yarn":
		case "pnpm":
		case "bun":
			if (isLast && has(/^\s(?:run\s+)?(?:dev|serve|start|watch)\s*$/)) {
				return { label: `\`${base} ${args.trim()}\` starts something that runs until stopped`, rewrite: SERVER_HINT };
			}
			return undefined;
		case "nodemon":
		case "uvicorn":
		case "gunicorn":
			return isLast ? { label: "a server runs until stopped", rewrite: SERVER_HINT } : undefined;
		case "flask":
		case "rails":
		case "hugo":
		case "jekyll":
		case "next":
		case "vite":
			if (isLast && has(/^\s(?:run|s|server|serve|dev)\b/)) return { label: "a development server runs until stopped", rewrite: SERVER_HINT };
			return undefined;
		default:
			return undefined;
	}
}

/**
 * A statement of this command that cannot end on its own here, if there is one.
 *
 * Nobody can press `q`, Ctrl-C or a key at a prompt, so a pager, an editor, `tail -f`, a
 * foreground server all run until the deadline and come back as a TIMEOUT two minutes
 * later — with nothing learned. Refusing first costs nothing and carries the rewrite.
 *
 * Deliberately narrow. Only the first word of a statement or pipeline stage is judged,
 * heredoc bodies are skipped, a backgrounded statement and anything under `timeout` are
 * left alone, and "last stage only" rules let `tail -f log | grep -m1 ready` through.
 * Quoted text is blanked before anything is split: in pi-managed-tools the first real
 * session refused `grep -n "PIPESTATUS\|tail -f /dev/null" notes.md`, because the `|`
 * inside the pattern was read as a pipe and what followed it as a command.
 * `# pitime-safe` overrides it, and a call made with `run_in_background` never reaches it.
 */
export function detectEndless(command: string): EndlessHit | undefined {
	for (const line of maskQuotes(stripHeredocs(command)).split("\n")) {
		const code = line.replace(/\s+#.*$/, "");
		for (const statement of code.split(/&&|\|\||;/)) {
			const trimmed = statement.trim();
			// Backgrounded: the call returns, whatever the process does.
			if (trimmed === "" || /&\s*$/.test(trimmed)) continue;
			const stages = trimmed.split(/\|(?!\|)/);
			for (const [index, stage] of stages.entries()) {
				const hit = endlessStage(stage, index === stages.length - 1);
				if (hit) return { ...hit, excerpt: trimmed.length > 60 ? `${trimmed.slice(0, 59)}…` : trimmed };
			}
		}
	}
	return undefined;
}

/** The refusal for a command that cannot end, with what to write instead. */
export function endlessReason(hit: EndlessHit): string {
	return [
		`Blocked before running: \`${hit.excerpt}\` does not end on its own here (${hit.label}), and nobody can press a key or Ctrl-C — it would run until the deadline and come back as a TIMEOUT with nothing learned.`,
		`Instead: ${hit.rewrite}.`,
		`If this one does end by itself, append \`${OVERRIDE_MARKER}\` to the command.`,
	].join("\n");
}
