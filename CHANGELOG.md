# Changelog

## [0.5.0] - 2026-11-24

What pi-managed-tools 0.23.0's hardening pass found, applied here: each item was a thing
the model was told that was false, a command that escaped the wrapper, or a result that
was easy to misread. Each was measured against the installed binary or met in a live
session; what was not run live is listed at the end.

### False things the model was told

- **The truncation pointer pointed at lines the model already had.** `run` keeps the head
  *and* the tail of a long timeline and marks the cut between them; the hint said "head
  only … read the end" and named the last forty lines. It now names the omitted range, the
  command that reads from inside it, and how many of the omitted lines are on stderr
  (`log --summary`, asked of the root the run reported): `724 of 3000 lines shown — the
  first 548 and the last 176. Lines 549-2824 are omitted, none of them on stderr.` The
  prompt and the skill said "head only" too.
- **A command that printed the words `truncated=true` was called truncated.** A diff that
  quoted them came back with "137 of 137 lines shown, head only". Truncation, like every
  other outcome, is now read off the run's own header lines and nowhere else.
- **"The last 20 runs are kept" was not true of a machine with two sessions on it.** The
  artifact root is shared by every session that uses the binary — this plugin's, a
  subagent's, pi's — and every run passed `--prune 20`. No run prunes now. The plugin
  sweeps at session start and every 25 commands, and removes a run only when 200 newer
  ones exist *and* it is more than two hours old: each one a folder named `R<digits>`
  directly under a folder named `busybox-run`, handed to `rm` by its full path.
- **The `IDLE` notice offered "give it the input it was waiting for".** Measured with a
  `read` behind a prompt: on plain pipes and in the `split` and `merged` terminal modes
  the read returns end-of-file at once, so that is the one thing a silent command cannot
  have been waiting for. The notice rules stdin out and names what does block (a lock, a
  socket, a child that never exits, a prompt that opens the terminal). In `raw` a read
  does wait, and there the notice and the prompt say that instead.
- **The prompt's example lines were chosen by rule, not read off the build.** At session
  start the binary is now run once — a wrapped `echo`, with the flags a command gets — and
  the header and the offsets the model is shown are in the shape that run printed.

### Commands that escaped the wrapper

- **`busybox sh -c '…'` is wrapped.** Any direct `busybox` call counted as already
  wrapped, so a script handed to its shell ran with no timeline, no deadline and no
  silence limit. Only the applets whose output is their own record (`run`, `log`, `peek`,
  …) are left as written; `sh`, `ash`, `hush`, `env`, `timeout`, `nice`, `nohup` and
  `time` are commands like any other.
- **A `!` command's escape is `# pitime-raw`, as the README already said.** 0.4.1 retired
  the `command` prefix for tool calls and left it in the shell shim, so `! command -v jq`
  still ran outside the capture and `! pytest # pitime-raw` did not.
- **A build that cannot wrap is passed over instead of failing every call.** `--caps` says
  what a build declares; the session-start run says whether a wrapped command comes back
  as a timeline at all. If it does not, Bash runs as written and `/pi-time` gives the
  build's own words for why.

### Results that are harder to misread

- **How a run ended comes first** when that was not the command's own exit. A timeout used
  to open with `exit_code=-1`, then up to 24 KB of output, and only then say that nothing
  had failed. `TIMEOUT`, `IDLE`, `CANCELLED` and `KILLED` now stand in front of the host's
  "Exit code 3" and the output.
- **A pipeline's stages report their own statuses.** The child shell's EXIT trap leaves the
  statuses of its last pipeline (`PIPESTATUS` under bash, `pipestatus` under zsh), and the
  result states them when they say something the header does not:
  `pipeline stage statuses: 1 141 0 — … 141 is a stage ended by SIGPIPE …; an earlier
  stage failed (1) and the header does not show it.` A `cmd | head` whose stages all
  exited 0 gets no note at all; before, every one carried two lines about a status that
  was fine. A command that sets its own EXIT trap falls back to the old caveat.
- **A note is given in full once.** The second time it is a few words
  (``exit_code is `head`'s, not the command's.``): the same two lines on every call are
  read once and then skimmed past.
- **A `grep` that matched earns no "exit 1 means no match"**, and notes are made about
  this call's shell only: a heredoc's body and quoted text are no longer read as commands
  (a script that mentioned `|| true` in a string earned the `|| true` caveat).
- **An offset is printed once per burst.** A line at the same offset as the line above it
  reads `[= out]`; the stream tag stays on every line. Measured in pi: stamps were a
  quarter of all Bash-result bytes. Lossless — the digest, the truncation pointer and the
  person's view read both spellings. Option `compactStamps`,
  `CLAUDE_MANAGED_TOOLS_COMPACT_STAMPS`.
- **A command that cannot end is refused before it runs**, with the rewrite: a pager at
  the end of a pipeline, an editor, `watch`, `top`, `tail -f`, `git rebase -i`,
  `git add -p`, a foreground server. It would otherwise run to the deadline and come back
  as a `TIMEOUT` with nothing learned. Narrow on purpose — only a statement's command
  word, never a backgrounded statement or one under `timeout`, never quoted text or a
  heredoc — and overridden by `# pitime-safe`. It shares the `guard` option. The prompt
  states the two facts behind it: a read on stdin returns end-of-file at once, and nobody
  can press a key.

### Found here, and also true of pi-managed-tools 0.23.0

- Its EXIT trap reads `PIPESTATUS` for zsh as well as bash. Under zsh that array is empty
  (measured); the statuses are in `pipestatus`.

### Costs

- One more process at session start (the wrapped `echo`, about 15 ms) and one capture
  folder for it.
- A `log --summary` call on a truncated result only, to count its stderr lines.
- About 4 ms a call for the EXIT trap, and one line of the wrapper's on stderr, which the
  plugin removes from the result. Another plugin's `PostToolUse` hook sees it on the
  wrapped spelling of a call.
- Up to 200 captures are kept where 20 were. Most are a few kilobytes; one can be 64 MiB a
  stream.

### Checked, and not

- Live, in two headless sessions on macOS (arm64, zsh) against busybox-static 0.6.1: the
  pipeline statuses (`1 141 0`, and no note for an all-zero pipeline), the truncation
  pointer with its stderr count, `[= out]`, the refusal of `tail -f /dev/null`, a `TIMEOUT`
  with its notice first, a failed command, a carried `cd`, and `busybox sh -c` wrapped.
  That run is also what found that Claude Code's Bash hands a command's stderr back inside
  `stdout`: the child shell's report was first looked for in `stderr` alone, and leaked
  into the result.
- Measured directly: the wrapper's trap and epilogue under zsh, bash and `sh`; what a read
  on stdin gets in each terminal mode; the shim's test for `# pitime-raw` with the real
  `grep`, and the shim script under `sh -n`.
- Not run: a `!` command typed after this change; a sweep that had anything to remove (the
  root here never reached 200 runs, so that rule is tested against a fake file system
  only); an `IDLE` ending; Linux; the sandbox.

## [0.4.1] - 2026-11-24

`command` is no longer an escape from the capture. `# pitime-raw` is.

### Changed

- **The per-call escape is a comment, `# pitime-raw`, at the end of the command.** It used
  to be the shell's `command` builtin at the start of any `&&`/`;`/`|` segment, and that
  was taken far more often by accident than on purpose: a model bypassing an alias
  (`… && command cat file`) lost the timeline for the whole call; `command -v jq` did;
  `grep "a\|command prefix" f` did, through a quoted pattern; and one long session took the
  prefix up as a habit and ran nearly every call unwrapped, each result saying so.
  `command x` now runs captured like any other command.
- **The escape is no longer in the prompt.** In its place the prompt says the thing a model
  reaches for an escape to get: what runs inside a command already sees exact bytes (a pipe,
  a redirect, a checksum); only the result read back carries the offsets. The marker is in
  the skill, in the README, and in the one refusal message that needs it.
- The note on an unwrapped result names the marker and says why it is rarely wanted.

## [0.4.0] - 2026-11-24

Buffering is switched off for every runtime that can be told from outside, so an offset
is the write and not the flush.

### Added

- **`STDBUF1=L`**: on macOS (and FreeBSD) the C library itself reads this and line-buffers
  descriptor 1, which covers every C-stdio program at once — compiled C and Swift, `grep`,
  `sed`, `awk`, `cut`, `tr`, `jq`. Measured: all late on a pipe before, all live now.
- **A Perl prelude**: `PERL5OPT` loads a one-line module of the plugin's that sets `$|`.
- **`LUA_INIT`** line-buffers stdout for `lua` and `luajit`; **`NSUnbufferedIO=YES`** for
  Foundation programs.
- **`preloadStdbuf`** (off by default): on Linux, where glibc reads no variable, preload
  GNU coreutils' `libstdbuf.so` so the same C-stdio programs line-buffer there. Off
  because a preload reaches every program a command starts; an AddressSanitizer build
  refuses to run under one.
- **`unbuffer`** (on by default): one switch for all of the above and for
  `PYTHONUNBUFFERED` and the Ruby prelude.
- The model is told what this means for the machine it is on: which programs write as they
  print inside a pipeline or into a file, which still write in blocks, and the flag that
  fixes each (`grep --line-buffered`, `sed -u`, `stdbuf -oL`).
- `/pi-time` says what is switched off and by which means.

### Changed

- **Option lists you already have are added to, not replaced.** `RUBYOPT`, `MAVEN_ARGS`
  and `GRADLE_OPTS` were assigned outright, so a `GRADLE_OPTS=-Xmx4g` a build depended on
  was lost under the wrapper. They, and `PERL5OPT`, are now appended to; `LUA_INIT` is set
  only when you have none.
- `extraEnv` comes after every variable of the wrapper's, so a pair there wins.

### Costs, measured

- Line-buffering is a system call per line. On macOS with `STDBUF1=L`, five million lines
  through `seq | awk | grep` took 5.5 s instead of 1.9 s, and `seq 1 5000000 > file`
  15.5 s instead of 0.6 s: about 3 µs a line. `STDBUF1=F cmd` exempts one command.

### Not fixable from outside

- Haskell (GHC) on a pipe, OCaml's `Printf`, and `mawk`'s input buffer (Debian's default
  `awk`). On Linux without the preload, C-stdio programs on a pipe.

## [0.3.1] - 2026-11-24

The silence limit is on by default, as in pi-managed-tools.

### Changed

- **`idleSeconds` defaults to 120** (it was 0, off). A command that prints nothing on
  either stream for that long is stopped and comes back as `IDLE`, whatever its deadline.
  Under the default deadline nothing changes: with the two equal the deadline fires first
  (measured). It bites when a call raises its `timeout` — a command given ten minutes that
  hangs at once now comes back after two — and it also stops a command that is silent and
  working. 0, or `CLAUDE_MANAGED_TOOLS_IDLE=off`, removes it.
- The limit rides with a deadline, as it does in pi. A tool call and a `/sh` command
  always have one; a `!` command has none while the default deadline is off, and then has
  no silence limit either.
- The `IDLE` notice says that a larger `timeout` cannot help a quiet command, and what
  does: progress on either stream, or `run_in_background`. On the person's own command it
  names their switch instead.

### Added

- **`/pi-time idle <seconds|off>`**: the silence limit for the rest of the session.

## [0.3.0] - 2026-11-24

busybox-static 0.6.1, and the default deadline on every command.

### Changed

- **The 120 s default deadline now covers the commands you run yourself.** A `!` command
  and a `/sh` command are stopped at the same default as a Bash call that names no
  `timeout`, and come back as a `TIMEOUT`. Before, `!` had no deadline and `/sh` had the
  longest Claude Code allows (ten minutes). The notice on such a result names the switch
  the person has, since there is no call whose `timeout` could be raised. A call's own
  `timeout` still wins; background commands and the `command ` escape are not wrapped and
  are unchanged.
- **Every shape of offset is read.** busybox-static 0.6.1 prints `[0.019841 out]` where
  0.6.0 printed `[   0.019841 out]`, and without `-n` it prints fewer decimals as the
  offset grows (measured: `[1.022 out]`, `[10.23 out]`). The wrapper asks for nanosecond
  stamps whenever a build has them, and those stay nine digits, so results from 0.6.1 were
  already read correctly; a shortened line would have matched neither the six-digit nor
  the nine-digit pattern and dropped out of the `timing:` digest. A fraction is now one to
  nine digits, read as a decimal fraction, in every parser. Nothing in `busybox --caps`
  says which shape a build prints, so all are accepted rather than one chosen.
- The model is shown offsets in the unpadded shape for a build with nanosecond stamps, and
  told that one build zero-pads them.

### Added

- **`/pi-time timeout <seconds|off>`**: the default deadline for the rest of the session,
  for Claude's calls and your own commands alike. `off` leaves Claude Code's own default
  on Bash calls and no deadline on yours.

## [0.2.0] - 2026-11-24

The plugin keeps its own busybox at the latest release, and uses what busybox-static
0.6.0 added.

### Added

- **The binary is fetched and kept current by the plugin.** On the first session, and at
  most once a day after, the latest rob-c/busybox-static release is looked up behind the
  session and this machine's build — `darwin-universal`, `linux-amd64` or `linux-arm64` —
  replaces the plugin's own copy when it differs. The download is checked against the
  published sha256, made runnable and asked for its feature list before it is moved into
  place. `/pi-time update` checks now; `/pi-time install` replaces regardless; the
  `autoUpdate` option or `CLAUDE_MANAGED_TOOLS_UPDATE=off` turns it off. `wget` is used
  where there is no `curl`.
- **Nanosecond offsets** (`run --stamp-ns`), when the build has them: two events in the
  same microsecond keep their order. Every parser reads six digits or nine.
- **`IDLE`**, a fourth outcome beside `TIMEOUT`, `CANCELLED` and `KILLED`: a command
  stopped for printing nothing (`run --idle-timeout`). Off unless `idleSeconds` or
  `CLAUDE_MANAGED_TOOLS_IDLE` asks for it.
- The model is told about `log --sample`, `--since/--until` and `--around-gap` when the
  build has them, and shown offsets in the width this build prints.
- `/pi-time` names the release in use and what the build can do.

### Changed

- **The plugin's own copy is used before pi's.** It is the one whose release and checksum
  the plugin has verified; `~/.pi/agent/bin/busybox` is the fallback. A local build is
  named explicitly (`busybox` option or `CLAUDE_MANAGED_TOOLS_BUSYBOX`).
- Every newer flag is gated on the binary's own feature list (`busybox --caps`), so an
  older build is never handed one it does not know.
- An outcome is read from the run's header line alone, field by field: a command that
  prints `timed_out=true` has not timed out, and a header that gains a field (`idle=`)
  changes nothing.

### Fixed

- A run stopped for silence printed `exit_code=-1` and would have been reported as
  `KILLED` by a signal.

## [0.1.0] - 2026-11-23

First release: Pi-Time, ported from pi-managed-tools 0.22.0 to Claude Code.

### Added

- Every foreground Bash command runs inside `busybox run --timestamps`, so its result is
  a timeline: a stream tag and a microsecond offset per line.
- The wrapper is applied at `tool.run`, after the call has been allowed as the model
  wrote it, so permission rules, modes and prompts judge the original command.
- A `timing:` digest on runs over a second, a pointer to the rest of a truncated view,
  a `TIMEOUT` / `CANCELLED` notice, and notes naming what a command hid from its own
  result (a discarded stream, a background process, whose exit code a pipeline shows).
- A default 120 s deadline, owned by the applet so the timeline survives the kill; a
  caller's `timeout` is taken over one second early.
- The tail-merge guard: `2>&1`, `|&` or `&>` at a command's end is refused before the
  permission check, with `# pitime-safe` as the declared override.
- On screen, results are drawn without the timeline; the stored result keeps it.
- A system prompt section describing the timeline, sent only while the wrapper is on.
- `/pi-time` (status, on, off, verbosity, pty, install) and plugin options for the same.
- `/pi-time install`: fetches the busybox-static build for this machine, verified against
  the published sha256.
- `/sh <command>`: a command the person types, through the same capture. The person's row
  is the command's own lines; the model reads the timeline. It runs only for the person
  (their Enter, Remote Control, or a host's starting prompt).
- `!command` through the capture, by a shell shim. Claude Code's `!` prefix raises nothing
  a plugin can hook, so the plugin points `CLAUDE_CODE_SHELL` at a script that is the
  person's real shell for every launch and runs that shell inside `busybox run` for a
  `!` command — recognised by a hash of the prompt box's text, never by elimination. The
  stored result gets the same digest and notes as a tool result. Option `wrapBang`;
  `PITIME_SHIM_TRACE` records the shim's decisions.

### Differences from the pi package

- A successful `cd` is carried back to the host's shell, since Claude Code keeps the
  working directory between Bash calls and pi does not.
- The `normal` view is 24 KB (pi: 48 KB) and `verbose` 27 KB (pi: 200 KB), to stay under
  Claude Code's inline result limit.
- In Claude Code's sandbox a pseudo-terminal cannot be allocated; the wrapper detects the
  refusal, which happens before the command starts, and falls back to plain pipes.
- Background commands are passed through unwrapped.
- Notices name the binary by absolute path: it is not on `PATH` here.
- The pi warning that a stdin-reading command hangs is dropped: measured under Claude
  Code, the child's stdin is already at end-of-file.
- In `split` mode stdin is taken back off the pseudo-terminal (`exec </dev/null`), so
  `python3` with no script does not start a REPL and `isatty(0)` is false, as it is for an
  unwrapped Bash call.
- The pseudo-terminal has a fixed size, 200x50, instead of inheriting the window's: what
  the model reads no longer depends on how wide the person's terminal is.
- The wrapper's prelude shares the command's first line, so the shell's own line numbers
  in error messages (`zsh:1: command not found`) are the command's.
- `verbose` is 27 KB: at 100 KB Claude Code moved the result to a file and showed the model
  2 KB of it.

### Found while testing, and also true of pi-managed-tools 0.22.0

- A timeline line ending in a carriage return (a CRLF file) did not parse, and dropped out
  of the `timing:` digest. Fixed here with the `s` flag on the line pattern.
- The `head`/`tail` note said the command "is killed by SIGPIPE". That is only sometimes
  true of `head` and never of `tail`; they now have a sentence each.
- The sectioned view of `brief` mode was never cleaned for the screen, because the check
  for "is this a wrapped result" looked only for timeline lines.
- A shell ended by a signal came back as `exit_code=-1` with no explanation; it now gets a
  `KILLED` notice.
