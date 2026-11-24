/**
 * Tests for the timeline wrapper: the argv it builds, when it declines to wrap, and
 * the environment it adds.
 *
 * The wrapper is the one change that touches every bash command, so the cases that
 * matter here are the ones that would silently break a working command: quoting,
 * nesting, the raw escape, deadlines, and the opt-out.
 */
import { describe, expect, test } from "claude-code/testing";
import {
	CWD_PREAMBLE,
	describeVerbosity,
	exitTrap,
	FACTS_FILE_VAR,
	isWrapped,
	LUA_INIT,
	parseExtraEnv,
	PERL_PRELUDE,
	PERL_PRELUDE_NAME,
	PTY_MODES,
	PTY_SIZE,
	ptyWasRefused,
	RAW_ESCAPE,
	RAW_MARKER,
	readPtyMode,
	readWrapSettings,
	RUBY_PRELUDE,
	RUN_MIN_AGE_MINUTES,
	RUN_RETENTION,
	RUNNER_APPLETS,
	shellQuote,
	shellValue,
	STDBUF_LIBS,
	STREAM_ENV,
	TOOL_OPTIONS_ENV,
	UNBUFFERED_ENV,
	VERBOSITIES,
	wantsRaw,
	wrapCommand,
} from "../src/wrap";

const BASE = { busybox: "/agent/bin/busybox", shell: "/bin/bash", verbosity: "normal" as const };

describe("quoting", () => {
	test("every byte is literal, including quotes, dollars and newlines", () => {
		expect(shellQuote("plain")).toBe("'plain'");
		// Close, escaped quote, reopen: the only POSIX-safe form.
		expect(shellQuote("it's")).toBe(`'it'\\''s'`);
		expect(shellQuote("$HOME `id` !x")).toBe("'$HOME `id` !x'");
		expect(shellQuote("a\nb")).toBe("'a\nb'");
	});
});

describe("when it declines to wrap", () => {
	test("empty, already-wrapped and raw commands are left alone", () => {
		expect(wrapCommand("   ", BASE)).toBe(undefined);
		// Nested timelines would double every prefix.
		expect(wrapCommand("busybox run -t -- ls", BASE)).toBe(undefined);
		expect(wrapCommand("'/agent/bin/busybox' run -t -- ls", BASE)).toBe(undefined);
		// The escape, and the builtin that used to be one.
		expect(wrapCommand("jq -r .a f.json # pitime-raw", BASE)).toBe(undefined);
		expect(wantsRaw("jq -r .a f.json # pitime-raw")).toBe(true);
		expect(wantsRaw("jq -r .a f.json")).toBe(false);
		expect(wrapCommand("command jq -r .a f.json", BASE) ?? "").toMatch(/ run /);
	});

	test("isWrapped recognises every spelling of a direct busybox call", () => {
		expect(isWrapped(`'/agent/bin/busybox' run --timestamps -- ls`)).toBe(true);
		expect(isWrapped("busybox peek f.ts")).toBe(true);
		// The notices name the binary by path, so a `log` by path must not be wrapped again.
		expect(isWrapped("/agent/bin/busybox log R12 --stream timeline --lines 1:40")).toBe(true);
		expect(isWrapped(`'/agent dir/bin/busybox' log R12`)).toBe(true);
		expect(isWrapped("ls -la")).toBe(false);
		// A path that merely ends in busybox-something is another program.
		expect(isWrapped("/opt/busybox-tools/run ls")).toBe(false);
	});

	test("an applet that only starts another command is wrapped like any command", () => {
		// `busybox sh -c '…'` is a script in a different shell, not a record to read back.
		// Counted as "already wrapped", it ran with no timeline, no deadline, no silence limit.
		for (const applet of RUNNER_APPLETS) {
			expect(isWrapped(`busybox ${applet} -c 'make all'`)).toBe(false);
			expect(isWrapped(`/agent/bin/busybox ${applet} make`)).toBe(false);
			expect(isWrapped(`'/agent dir/bin/busybox' ${applet} make`)).toBe(false);
		}
		expect(wrapCommand("busybox sh -c 'for f in *; do wc -l $f; done'", { ...BASE, noEnv: true })).toMatch(/ run --timestamps .* -- '\/bin\/bash' -c 'busybox sh -c /);
		// The applets whose output is their own record stay as written.
		for (const applet of ["run", "log", "peek", "json", "waitfor"]) expect(isWrapped(`busybox ${applet} x`)).toBe(true);
	});
});

describe("the wrapper itself", () => {
	test("timestamps, the view budget, the shell pi would have used, and the command", () => {
		const out = wrapCommand("ls -la", { ...BASE, noEnv: true });
		expect(out).toBe(`'/agent/bin/busybox' run --timestamps --max-bytes 24000 -- '/bin/bash' -c 'ls -la'`);
	});

	test("no run prunes the captures: the root is every session's, and the sweep is by count and age", () => {
		// `--prune 20` let twenty commands in one session delete the capture another had
		// just been pointed at. The hooks module sweeps instead, by both of these.
		for (const verbosity of ["quiet", "normal", "verbose", "brief"] as const) {
			expect(wrapCommand("ls", { ...BASE, verbosity })).not.toMatch(/--prune/);
		}
		expect(RUN_RETENTION).toBe(200);
		expect(RUN_MIN_AGE_MINUTES).toBe(120);
	});

	test("the child keeps bash, so [[ ]] and arrays still work", () => {
		// pi runs /bin/bash; substituting sh here would break commands that work today.
		const out = wrapCommand("if [[ -f x ]]; then echo yes; fi", BASE);
		expect(out ?? "").toMatch(/-- '\/bin\/bash' -c /);
	});

	test("verbosity changes the view budget, and brief trades timing for volume", () => {
		expect(wrapCommand("x", { ...BASE, verbosity: "quiet", noEnv: true }) ?? "").toMatch(/--max-bytes 6000/);
		expect(wrapCommand("x", { ...BASE, verbosity: "verbose", noEnv: true }) ?? "").toMatch(/--max-bytes 27000/);
		const brief = wrapCommand("x", { ...BASE, verbosity: "brief", noEnv: true }) ?? "";
		expect(brief).toMatch(/--brief both/);
		// This build takes the timeline branch first and silently ignores --brief, so the
		// brief mode must not claim to do both.
		expect(brief.includes("--timestamps")).toBe(false);
	});

	test("the deadline is emitted as given, and absent when the caller gave none", () => {
		// The pre-emption of the host's own deadline lives in policy.ts, so this
		// module stays a formatter: a number in is the same number out.
		expect(wrapCommand("x", { ...BASE, timeoutSeconds: 30, noEnv: true }) ?? "").toMatch(/--timeout 30/);
		expect(wrapCommand("x", { ...BASE, timeoutSeconds: 0, noEnv: true }) ?? "").toMatch(/--timeout 0/);
		expect(Boolean(!(wrapCommand("x", { ...BASE, noEnv: true }) ?? "").includes("--timeout"))).toBe(true);
	});

	test("the unbuffered environment is passed per command, not exported globally", () => {
		const out = wrapCommand("python3 app.py", BASE) ?? "";
		for (const [name, value] of UNBUFFERED_ENV) {
			expect(Boolean(out.includes(`--env ${shellValue(`${name}=${value}`)}`))).toBe(true);
		}
		expect(Boolean(out.includes("--env PYTHONUNBUFFERED=1"))).toBe(true);
		// Extra pairs are appended and can override a default.
		const extra = wrapCommand("x", { ...BASE, extraEnv: [["PYTHONUNBUFFERED", "0"], ["MY_VAR", "a b"]] }) ?? "";
		expect(extra).toMatch(/--env PYTHONUNBUFFERED=0/);
		// A value with a space is quoted so the shell cannot split it into an option.
		expect(extra).toMatch(/--env 'MY_VAR=a b'/);
	});
});

describe("carrying cd back to the host's shell", () => {
	const carried = wrapCommand("cd build && make", { ...BASE, noEnv: true, carryCwd: true }) ?? "";

	test("the child leaves its last directory in a file the outer shell names", () => {
		// The file's path is expanded by the outer shell, once, and handed to the child.
		expect(carried.startsWith(CWD_PREAMBLE)).toBe(true);
		expect(carried).toMatch(/--env "PITIME_CWD_FILE=\$__pt_f" -- '\/bin\/bash' -c 'trap /);
		// An EXIT trap, so the command's own status is what the child exits with.
		expect(carried).toMatch(/-c 'trap '\\''pwd -P >"\$PITIME_CWD_FILE" 2>\/dev\/null'\\'' EXIT; cd build && make'/);
		// One line: a prelude on a line of its own would shift every line number the shell reports.
		expect(carried.split("\n")).toHaveLength(1);
	});

	test("the outer shell moves only on success, tidies up, and keeps the status", () => {
		expect(carried).toMatch(/; __pt_rc=\$\?; if \[ "\$__pt_rc" -eq 0 \] && \[ -s "\$__pt_f" \]; then cd -- "\$\(cat "\$__pt_f"\)"/);
		expect(carried).toMatch(/rm -f "\$__pt_f"; \(exit "\$__pt_rc"\)$/);
	});

	test("its own output is recognised, so it is never wrapped twice", () => {
		expect(isWrapped(carried)).toBe(true);
		expect(wrapCommand(carried, { ...BASE, carryCwd: true })).toBe(undefined);
	});

	test("without the carry the line is the bare wrapper", () => {
		const bare = wrapCommand("cd build && make", { ...BASE, noEnv: true }) ?? "";
		expect(bare).not.toMatch(/__pt_/);
		expect(bare).not.toMatch(/trap/);
	});
});

describe("settings", () => {
	test("off is off, in every spelling", () => {
		for (const value of ["off", "0", "false", "no", "OFF"]) {
			expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_WRAP: value }).enabled).toBe(false);
		}
		expect(readWrapSettings({}).enabled).toBe(true);
		expect(readWrapSettings({}).verbosity).toBe("normal");
	});

	test("the session override wins over the environment, and a bad value falls back", () => {
		expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_VERBOSITY: "quiet" }).verbosity).toBe("quiet");
		expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_VERBOSITY: "quiet" }, {}, "verbose").verbosity).toBe("verbose");
		expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_VERBOSITY: "shouty" }).verbosity).toBe("normal");
	});

	test("the plugin's options are the defaults under the environment", () => {
		const options = { enabled: false, verbosity: "quiet", pty: "off", timeoutSeconds: 30, extraEnv: "A=1" };
		const fromOptions = readWrapSettings({}, options);
		// No idle option given: the built-in silence limit, the same number pi uses.
		expect(fromOptions).toEqual({ enabled: false, verbosity: "quiet", pty: "off", timeoutSeconds: 30, idleSeconds: 120, unbuffer: true, preload: false, compactStamps: true, stampDigits: 3, live: true, extraEnv: [["A", "1"]] });
		expect(readWrapSettings({}, { ...options, idleSeconds: 0 }).idleSeconds).toBe(0);
		expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_IDLE: "off" }, options).idleSeconds).toBe(0);
		const fromEnv = readWrapSettings(
			{
				CLAUDE_MANAGED_TOOLS_WRAP: "on",
				CLAUDE_MANAGED_TOOLS_VERBOSITY: "verbose",
				CLAUDE_MANAGED_TOOLS_PTY: "merged",
				CLAUDE_MANAGED_TOOLS_TIMEOUT: "off",
				CLAUDE_MANAGED_TOOLS_EXTRA_ENV: "B=2",
			},
			options,
		);
		expect(fromEnv).toEqual({ enabled: true, verbosity: "verbose", pty: "merged", timeoutSeconds: 0, idleSeconds: 120, unbuffer: true, preload: false, compactStamps: true, stampDigits: 3, live: true, extraEnv: [["B", "2"]] });
		// A running command is shown and watched unless told otherwise.
		expect(readWrapSettings({}, { live: false }).live).toBe(false);
		expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_LIVE: "off" }).live).toBe(false);
		// Milliseconds unless told otherwise; anything that is not 1 to 9 leaves the default.
		expect(readWrapSettings({}, { stampDigits: 9 }).stampDigits).toBe(9);
		expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_STAMP_DIGITS: "6" }, { stampDigits: 9 }).stampDigits).toBe(6);
		for (const bad of ["0", "12", "2.5", "many", ""]) expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_STAMP_DIGITS: bad }).stampDigits).toBe(3);
		expect(readWrapSettings({}, { stampDigits: 0 }).stampDigits).toBe(3);
		// One offset per burst unless told otherwise.
		expect(readWrapSettings({}, { compactStamps: false }).compactStamps).toBe(false);
		expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_COMPACT_STAMPS: "off" }).compactStamps).toBe(false);
		expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_COMPACT_STAMPS: "on" }, { compactStamps: false }).compactStamps).toBe(true);
		// Buffering stays switched off unless told otherwise; the preload is the other way round.
		expect(readWrapSettings({}, { unbuffer: false }).unbuffer).toBe(false);
		expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_UNBUFFER: "on" }, { unbuffer: false }).unbuffer).toBe(true);
		expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_UNBUFFER: "off" }).unbuffer).toBe(false);
		expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_UNBUFFER: "maybe" }).unbuffer).toBe(true);
		expect(readWrapSettings({}, { preload: true }).preload).toBe(true);
		expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_PRELOAD: "1" }).preload).toBe(true);
		expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_PRELOAD: "off" }, { preload: true }).preload).toBe(false);
		// A value the environment spells wrong falls back to the option, not past it.
		expect(readWrapSettings({ CLAUDE_MANAGED_TOOLS_VERBOSITY: "shouty" }, options).verbosity).toBe("quiet");
	});

	test("extra env parsing rejects malformed pairs rather than passing them on", () => {
		expect(parseExtraEnv("A=1,B=two")).toEqual([
			["A", "1"],
			["B", "two"],
		]);
		expect(parseExtraEnv("NOEQUALS,=x,1BAD=2")).toEqual([]);
		expect(parseExtraEnv("SPACED = v ")).toEqual([["SPACED", " v"]]);
		expect(parseExtraEnv(undefined)).toEqual([]);
	});

	test("each verbosity is described in words a reader can act on", () => {
		for (const level of VERBOSITIES) {
			const text = describeVerbosity(level);
			expect(Boolean(text.length > 5)).toBe(true);
		}
		expect(describeVerbosity("brief")).toMatch(/no timeline/);
		expect(RAW_ESCAPE).toMatch(/`# pitime-raw`/);
		expect(RAW_MARKER).toBe("# pitime-raw");
	});
});

describe("runtime buffering", () => {
	test("the Ruby prelude is wired in only when the file is given", () => {
		const without = wrapCommand("ruby app.rb", { ...BASE }) ?? "";
		expect(without.includes("RUBYOPT")).toBe(false);
		const withPrelude = wrapCommand("ruby app.rb", { ...BASE, rubyPrelude: "/agent/pitime-unbuffer.rb" }) ?? "";
		// Added to a RUBYOPT the person already has, never in place of it.
		expect(withPrelude.includes(' --env "RUBYOPT=${RUBYOPT:+$RUBYOPT }-r/agent/pitime-unbuffer.rb" ')).toBe(true);
		// The prelude itself must be valid Ruby and touch both streams.
		expect(RUBY_PRELUDE).toMatch(/\$stdout\.sync = true/);
		expect(RUBY_PRELUDE).toMatch(/\$stderr\.sync = true/);
	});

	test("the Perl prelude is a module PERL5OPT loads, wired in only when its folder is given", () => {
		expect((wrapCommand("perl x.pl", BASE) ?? "").includes("PERL5OPT")).toBe(false);
		const out = wrapCommand("perl x.pl", { ...BASE, perlPrelude: "/agent" }) ?? "";
		expect(out.includes(' --env "PERL5OPT=${PERL5OPT:+$PERL5OPT }-I/agent -MPiTimeUnbuffer" ')).toBe(true);
		expect(PERL_PRELUDE_NAME).toBe("PiTimeUnbuffer.pm");
		expect(PERL_PRELUDE).toMatch(/^package PiTimeUnbuffer;\n/);
		// `$|` set at load time is set on STDOUT; a module must end true.
		expect(PERL_PRELUDE).toMatch(/\n\$\| = 1;\n1;\n$/);
	});

	test("C stdio, Foundation and Lua are switched by the environment alone", () => {
		const out = wrapCommand("make | tee build.log", BASE) ?? "";
		// macOS and FreeBSD libc read this for descriptor 1; glibc ignores it.
		expect(out).toMatch(/ --env STDBUF1=L /);
		expect(out).toMatch(/ --env NSUnbufferedIO=YES /);
		// Lua's snippet carries no quote, and stands down for a LUA_INIT the person has.
		expect(LUA_INIT).toBe("io.stdout:setvbuf[[line]]");
		expect(out.includes(' --env "LUA_INIT=${LUA_INIT:-io.stdout:setvbuf[[line]]}" ')).toBe(true);
		// Stderr is left as every runtime has it: unbuffered already.
		expect(out).not.toMatch(/STDBUF2|STDBUF=/);
	});

	test("the stdbuf preload is added to an LD_PRELOAD already there, and only when given", () => {
		expect((wrapCommand("grep x f", BASE) ?? "").includes("LD_PRELOAD")).toBe(false);
		const out = wrapCommand("grep x f", { ...BASE, stdbufLib: "/usr/libexec/coreutils/libstdbuf.so" }) ?? "";
		expect(out.includes(' --env "LD_PRELOAD=${LD_PRELOAD:+$LD_PRELOAD:}/usr/libexec/coreutils/libstdbuf.so" --env _STDBUF_O=L ')).toBe(true);
		expect(STDBUF_LIBS.every((path) => path.startsWith("/usr/") && path.endsWith("/coreutils/libstdbuf.so"))).toBe(true);
	});

	test("switched off, no runtime's buffering is touched and the rest of the environment stays", () => {
		const out =
			wrapCommand("python3 app.py", { ...BASE, unbuffer: false, rubyPrelude: "/agent/pitime-unbuffer.rb", perlPrelude: "/agent", stdbufLib: "/usr/libexec/coreutils/libstdbuf.so" }) ?? "";
		expect(out).not.toMatch(/PYTHONUNBUFFERED|STDBUF|NSUnbufferedIO|LUA_INIT|RUBYOPT|PERL5OPT|LD_PRELOAD/);
		expect(out).toMatch(/ --env PYTHONIOENCODING=utf-8 .* --env TERM=dumb /);
		expect(STREAM_ENV.map(([name]) => name)).toEqual(["PYTHONUNBUFFERED", "STDBUF1", "NSUnbufferedIO"]);
	});

	test("a value that needs it is made literal inside the double quotes", () => {
		const out = wrapCommand("ruby x.rb", { ...BASE, rubyPrelude: '/data/$HOME/a"b`c\\d/pitime-unbuffer.rb' }) ?? "";
		expect(out.includes('-r/data/\\$HOME/a\\"b\\`c\\\\d/pitime-unbuffer.rb"')).toBe(true);
	});

	test("the person's extra environment comes last, so it wins over every default", () => {
		const out = wrapCommand("sort big > out", { ...BASE, rubyPrelude: "/agent/pitime-unbuffer.rb", extraEnv: [["STDBUF1", "F"]] }) ?? "";
		expect(out.lastIndexOf("--env STDBUF1=F") > out.indexOf("--env STDBUF1=L")).toBe(true);
		expect(out.lastIndexOf("--env STDBUF1=F") > out.indexOf("RUBYOPT")).toBe(true);
	});

	test("build tools that draw progress bars are told not to, on top of the person's own options", () => {
		const out = wrapCommand("mvn test", BASE) ?? "";
		// In quotes: unquoted, the space would split it and busybox would see -ntp as an option.
		expect(out.includes(' --env "MAVEN_ARGS=${MAVEN_ARGS:+$MAVEN_ARGS }-B -ntp" ')).toBe(true);
		// Appended, so a GRADLE_OPTS=-Xmx4g the build depends on survives the wrapper.
		expect(out.includes(' --env "GRADLE_OPTS=${GRADLE_OPTS:+$GRADLE_OPTS }-Dorg.gradle.console=plain -Dorg.gradle.daemon=false" ')).toBe(true);
		expect(TOOL_OPTIONS_ENV.map(([name]) => name)).toEqual(["MAVEN_ARGS", "GRADLE_OPTS"]);
	});
});

describe("the escape is a marker nobody writes by accident", () => {
	test("the shell's `command` builtin is not an escape, wherever it stands", () => {
		// Each of these lost its timeline under the old rule, in a real session:
		for (const command of [
			"cd /repo && python3 --version && ls -la inv tools && command cat inv/__init__.py",
			'for f in cases/*.json; do echo "=== $f"; command cat "$f"; done',
			"cd /repo && command node scripts/gauntlet.mjs --selftest",
			"command -v jq",
			"command -v python3 && make test",
			'grep -n "ran unwrapped\\|command prefix" src/guard.ts',
			"command jq -r .a f.json",
			"true; command sha256sum f",
			"ls | command sort",
		]) {
			expect(wantsRaw(command)).toBe(false);
			expect(wrapCommand(command, BASE) ?? "").toMatch(/ run /);
		}
	});

	test("`# pitime-raw` at the end of the command is", () => {
		expect(wantsRaw("jq -r .a f.json # pitime-raw")).toBe(true);
		expect(wantsRaw("cd /repo && jq -r .a f.json  #pitime-raw")).toBe(true);
		expect(wantsRaw(["make test", "# pitime-raw"].join("\n"))).toBe(true);
		expect(wrapCommand("cd /repo && jq -r .a f.json # pitime-raw", BASE)).toBe(undefined);
	});

	test("the words in a string, a heredoc or another comment are not", () => {
		expect(wantsRaw('echo "append # pitime-raw to escape"')).toBe(false);
		expect(wantsRaw("echo 'x # pitime-raw'")).toBe(false);
		expect(wantsRaw(["cat > notes.md <<'EOF'", "end a command with # pitime-raw", "EOF"].join("\n"))).toBe(false);
		expect(wantsRaw("echo a#pitime-raw")).toBe(false);
		expect(wantsRaw("make test # pitime-rawhide")).toBe(false);
		expect(wantsRaw("make test # pitime-safe")).toBe(false);
	});
});

describe("the child's terminal", () => {
	test("split is the default: stdout on a pty, stderr on a pipe", () => {
		// Line buffering is what makes the timeline honest for Python/Node/Ruby/Java, and
		// stderr is unbuffered anyway so it keeps its own pipe (and its `err` tag).
		expect(readWrapSettings({}).pty).toBe("split");
		expect(wrapCommand("x", { ...BASE, pty: "split", noEnv: true }) ?? "").toMatch(/--pty-split/);
	});

	test("every mode maps to one flag, and off maps to none", () => {
		expect(wrapCommand("x", { ...BASE, pty: "merged", noEnv: true }) ?? "").toMatch(/ --pty /);
		expect(wrapCommand("x", { ...BASE, pty: "raw", noEnv: true }) ?? "").toMatch(/--pty-raw/);
		expect(Boolean(!(wrapCommand("x", { ...BASE, pty: "off", noEnv: true }) ?? "").includes("--pty"))).toBe(true);
		// No setting means no terminal in this module; the extension decides.
		expect(Boolean(!(wrapCommand("x", { ...BASE, noEnv: true }) ?? "").includes("--pty"))).toBe(true);
	});

	test("a refused terminal is told apart from a command that printed the same words", () => {
		// The sandbox's refusal: no run header, because no run started.
		expect(ptyWasRefused("Exit code 2\nrun: cannot allocate a pty: Operation not permitted")).toBe(true);
		expect(ptyWasRefused("run: cannot allocate a pty: Operation not permitted\n")).toBe(true);
		// A command that ran and happened to print that line must never be run again.
		expect(
			ptyWasRefused("run=R9 exit_code=1 timed_out=false cancelled=false duration_ms=4\n--- timeline ---\n[   0.001000 err] run: cannot allocate a pty: nope"),
		).toBe(false);
		expect(ptyWasRefused("Exit code 2\nrun=R9 exit_code=2 timed_out=false\nrun: cannot allocate a pty")).toBe(false);
		expect(ptyWasRefused("Exit code 2\nmake: *** No rule to make target")).toBe(false);
	});

	test("an unrecognised value falls back to split, never to a silent tty surprise", () => {
		expect(readPtyMode(undefined)).toBe("split");
		expect(readPtyMode("shouty")).toBe("split");
		expect(readPtyMode("OFF")).toBe("off");
		expect(readPtyMode("on")).toBe("merged");
		expect(readPtyMode("pipe")).toBe("off");
	});
});

describe("what the child's terminal is, beyond being one", () => {
	test("in split mode stdin is taken back off the terminal, on the command's own line", () => {
		const split = wrapCommand("python3", { ...BASE, pty: "split", noEnv: true }) ?? "";
		// Only stdout has to be a terminal; a terminal on stdin starts a REPL.
		expect(split).toMatch(/-c 'exec <\/dev\/null; python3'$/);
		// With the carry, both preludes share the first line with the command.
		const carried = wrapCommand("python3", { ...BASE, pty: "split", noEnv: true, carryCwd: true }) ?? "";
		expect(carried).toMatch(/-c 'exec <\/dev\/null; trap [^\n]+ EXIT; python3'/);
	});

	test("the modes that ask for a whole terminal, or none, keep the stdin they have", () => {
		for (const pty of ["merged", "raw", "off"] as const) {
			expect(wrapCommand("python3", { ...BASE, pty, noEnv: true }) ?? "").toMatch(/-c 'python3'$/);
		}
	});

	test("the terminal has a fixed size, so the view does not follow the person's window", () => {
		for (const pty of ["split", "merged", "raw"] as const) {
			expect(wrapCommand("x", { ...BASE, pty, noEnv: true }) ?? "").toMatch(new RegExp(` --pty-size ${PTY_SIZE} `));
		}
		expect(wrapCommand("x", { ...BASE, pty: "off", noEnv: true }) ?? "").not.toMatch(/--pty-size/);
		expect(PTY_SIZE).toBe("200x50");
	});
});
