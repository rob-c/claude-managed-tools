/**
 * The shell shim's pure half: the file it sources, and how a draft becomes a key.
 *
 * The script itself is exercised against a real shell and a real busybox (see the README);
 * these pin the parts both sides must compute alike.
 */
import { describe, expect, test } from "claude-code/testing";
import { bashBlock, confText, draftKey, draftKeys, SHIM_SOURCE, shimDir, shimName, withStdout } from "../src/shim";
import { runPrefix } from "../src/wrap";

describe("the prompt box's text as a key", () => {
	test("spaces, tabs and line ends do not count, so a stray one cannot lose the match", () => {
		expect(draftKey("  echo  hi \n")).toBe("echohi");
		expect(draftKey("a\tb\r\nc")).toBe("abc");
		// Exactly the four characters the shim strips with tr; nothing else is touched.
		expect(draftKey("é ü")).toBe("éü");
	});

	test("a draft answers to itself and to itself without a leading `!`", () => {
		expect(draftKeys("ls -la")).toEqual(["ls-la"]);
		expect(draftKeys("!ls -la")).toEqual(["!ls-la", "ls-la"]);
		expect(draftKeys("  ! ls")).toEqual(["!ls", "ls"]);
	});

	test("an empty box has no key: nothing must match nothing", () => {
		expect(draftKeys("")).toEqual([]);
		expect(draftKeys("  \n")).toEqual([]);
		expect(draftKeys("!")).toEqual(["!"]);
	});
});

describe("the file the shim sources", () => {
	const base = { busybox: "/data dir/bin/busybox", verbosity: "normal" as const, extraEnv: [] as Array<[string, string]> };
	const conf = confText({
		enabled: true,
		real: "/bin/zsh",
		busybox: base.busybox,
		run: runPrefix({ ...base, pty: "split" }),
		runNoPty: runPrefix({ ...base, pty: "off" }),
		hasPty: true,
	});

	test("is plain assignments, every value quoted once more than the tokens inside it", () => {
		expect(conf).toMatch(/^PT_ENABLED=1\nPT_REAL='\/bin\/zsh'\nPT_BUSYBOX='\/data dir\/bin\/busybox'\nPT_PTY=1\nPT_RUN='/);
		// The prefix's own quotes survive as '\'' inside the outer pair.
		expect(conf).toMatch(/PT_RUN=''\\''\/data dir\/bin\/busybox'\\'' run --timestamps --max-bytes 24000 --pty-split --pty-size 200x50 --env /);
		expect(conf).toMatch(/\nPT_RUN_NOPTY=''\\''\/data dir\/bin\/busybox'\\'' run --timestamps --max-bytes 24000 --env /);
	});

	test("carries no deadline of the plugin's: a person's own command is the host's to time", () => {
		expect(conf).not.toMatch(/--timeout/);
	});

	test("off is off: the shim is then the real shell and nothing else", () => {
		expect(confText({ enabled: false, real: "/bin/bash", busybox: "", run: [], runNoPty: [], hasPty: false })).toMatch(/^PT_ENABLED=0\nPT_REAL='\/bin\/bash'\n/);
	});
});

describe("the shim itself", () => {
	test("carries the real shell's name, because the host tells bash from zsh by it", () => {
		expect(shimName("/bin/zsh")).toBe("zsh");
		expect(shimName("/opt/homebrew/bin/zsh")).toBe("zsh");
		expect(shimName("/bin/bash")).toBe("bash");
		expect(shimName("/bin/sh")).toBe("bash");
		expect(shimDir("/data/")).toBe("/data/shell");
	});

	test("every way out that is not the wrapped run is the real shell, with the same arguments", () => {
		const exits = SHIM_SOURCE.split("\n").filter((line) => /\bexec\b/.test(line));
		// One exec inside pass(), one for the wrapped run; no third way to leave.
		expect(exits).toHaveLength(2);
		expect(exits[0]).toMatch(/pass\(\) \{ .*exec "\$real" "\$@"; \}/);
		expect(exits[1]).toBe('exec "$@" -- "$real" -c "$line"');
	});

	test("wraps only on a positive match, and checks the session is on before anything else", () => {
		const source = SHIM_SOURCE;
		const order = ["PT_ENABLED", '"$#" = 2', '"$1" = "-c"', "not the host", "no draft recorded", "is not the prompt box", "a direct busybox call", "the raw marker", 'note "wrapped"'];
		let at = -1;
		for (const mark of order) {
			const next = source.indexOf(mark, at + 1);
			expect(next > at).toBe(true);
			at = next;
		}
	});

	test("the one escape is the marker a tool call has: `command` is the shell's builtin, not a way out", () => {
		// Through 0.4.0 a `!` command with `command` at the start of a segment ran outside
		// the capture; 0.4.1 retired that for tool calls and left it here, while the README
		// already promised `# pitime-raw` for `!`. The shim now has the marker and only it.
		expect(SHIM_SOURCE).not.toMatch(/the command escape|\bcommand\[\[:space:\]\]/);
		const marker = SHIM_SOURCE.split("\n").find((line) => line.includes("the raw marker")) ?? "";
		expect(marker).toMatch(/grep -Eq '\(\^\|\[\[:space:\]\]\)#\[\[:space:\]\]\*pitime-raw\[\[:space:\]\]\*\$'/);
	});

	test("never writes the command anywhere: the trace names decisions and hashes only", () => {
		// The words handed to note/pass are what reaches the trace file.
		const messages = Array.from(SHIM_SOURCE.matchAll(/\b(?:note|pass) \\?"((?:[^"\\]|\\.)*)\\?"/g), (match) => match[1] ?? "");
		expect(messages.length > 8).toBe(true);
		for (const message of messages) {
			expect(message).not.toMatch(/\$cmd|\$quoted|\$2\b|\$line\b|\$rest/);
		}
	});
});

describe("a `!` command's rows", () => {
	test("the input and output blocks are read out of the host's own tags", () => {
		expect(bashBlock("<bash-input>ls -la</bash-input>", "bash-input")).toBe("ls -la");
		expect(bashBlock("<bash-stdout>a\nb</bash-stdout><bash-stderr></bash-stderr>", "bash-stdout")).toBe("a\nb");
		expect(bashBlock("plain text", "bash-stdout")).toBe(undefined);
		expect(bashBlock("said <bash-input>x</bash-input>", "bash-input")).toBe(undefined);
	});

	test("the output is replaced inside its tags, and what follows them is kept", () => {
		expect(withStdout("<bash-stdout>old</bash-stdout><bash-stderr>e</bash-stderr>", "new\nmore")).toBe(
			"<bash-stdout>new\nmore</bash-stdout><bash-stderr>e</bash-stderr>",
		);
	});
});
