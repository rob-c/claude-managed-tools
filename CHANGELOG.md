# Changelog

## [0.7.0] - 2026-11-24

A running command is no longer a blank row, and "stuck" is no longer another word for
"quiet".

### Added

- **Live output and a sign of life under a running command.** `busybox run` prints its
  view when the command ends, so a slow command showed nothing for as long as it took.
  The capture's own files grow as the command writes (measured: first bytes there within
  a second, the view only at exit), so the plugin reads them and draws the newest lines
  under the command's row, with one line beneath:
  `running 47s · last output 31s ago · CPU busy (98% of a processor): working`, or
  `CPU idle: waiting on something (stopped as stuck in 45s if it stays so)`.
  The command's shell says where its capture is and which process group it leads, in one
  small file named to it alone; nothing is read for the first second and a half, so a
  quick command pays nothing. The model is sent none of it. Option `live`,
  `CLAUDE_MANAGED_TOOLS_LIVE`.
- **The processor is read while a command runs**: `ps` for the command's own process
  group, every three seconds. Measured on a silent loop: 1.02 s of CPU after one second,
  2.04 s after two; a blocked command shows none.
- **A deadline says whether more time would have helped.** On a watched command the
  `TIMEOUT` notice carries a line from the processor: "it used 117.3s of processor time in
  120s and was still computing when it was stopped, so it was working, not stuck", or
  "…and none at the end, so it was waiting on something, not computing: more time alone
  will not help".

### Changed

- **A command is stuck when it has shown no sign of life: neither a line nor processor
  time.** Silence alone used to decide, and it stopped a quiet compile along with a hang.
  A command that is using a hundredth of a processor or more over its silence is now left
  alone, up to its deadline; one that is using none is stopped at the silence limit as
  before, and its `IDLE` notice says both things: "for 121s it printed nothing and used no
  processor time to speak of (0.0s), so it was waiting, not working".
- **The hooks module enforces that limit**, since the capture's own (`--idle-timeout`)
  knows only output. It stops the command's whole process group, asks once, and kills it
  outright three seconds later if it is still there; only a group that `ps` listed a
  moment before is ever signalled.
- **Where a command cannot be watched, nothing changes.** In Claude Code's sandbox the
  command's shell cannot write its report; after the first such call the plugin stops
  trying, those calls get the capture's own silence limit again, and the system prompt
  says "prints nothing" rather than "neither prints nor uses the processor". A `!` or
  `/sh` command of your own uses the capture's limit too.

### Removed

- The README's caveat about the maturity of the hook API.

### Costs

- One small file per call in the plugin's data folder, written by the command's shell and
  removed by the `rm` that already tidied up after it.
- While a command runs past a second and a half: two `stat` calls twice a second, and one
  `ps` every three seconds.
- A command that polls quietly — a loop with a `sleep` in it — uses a little processor
  and so counts as alive: it runs to its deadline rather than to the silence limit.

### Checked, and not

- With the engine's test kit and a clock the tests move: the row's text as output arrives,
  a hang stopped at the limit with its group signalled once and then killed, a silent
  command at a whole processor left alone for three times the limit, nothing signalled
  that `ps` did not list, and the fallback when a command never reports itself.
- In a live headless session with the limit set to 8 s: a silent command at a whole
  processor ran its 16 s and finished; `sleep 40` came back after 9 s as `IDLE` ("printed
  nothing and used no processor time to speak of"); a busy command past its deadline came
  back as `TIMEOUT` with "still computing when it was stopped". The folder of reports was
  empty afterwards.
- Not seen: the row itself drawn in a terminal. A headless session draws nothing, so the
  drawing is verified by the test kit only. Not run: Linux (`ps` prints CPU time in
  another spelling there, which is parsed and unit-tested, and to the second), the
  sandbox.

## [0.6.1] - 2026-11-24

Thirty-nine reproduced defects, ported from a bug hunt in pi-managed-tools: statements to
Claude that were false, and harmless commands a guard refused. `tests/claims.test.ts` holds
one case per item.

### Fixed

- **A discard is not a merge.** `cmd >/dev/null 2>&1` and `cmd &>/dev/null` were refused
  "because the timeline loses the [err] tag", though nothing reaches the view. They run,
  with a note that both streams were discarded. A merge into a file (`>srv.log 2>&1`) and
  `2>&1 >/dev/null` (stderr to the view) are still refused.
- **Text that mentions a merge is not one.** `grep -n "2>&1" f`, `git commit -m "ban 2>&1"`,
  a comment and a heredoc body were all refused; a quoted `# pitime-safe` switched the guard
  off.
- **The endless-command guard read data as commands.** Refused though they end:
  `server & sleep 1; curl …; kill %1`, a comment line with `watch` in it, an apostrophe in a
  comment, `vim -es`, `nvim --headless`, `rails dev:cache`, the members of a multi-line
  array, the labels of a `case`, and the guard's own advice
  (`GIT_SEQUENCE_EDITOR=… git rebase -i`). Let through though endless: `tail -fn 5 f`, and a
  `tail -f` after a comment with an apostrophe or after a here-string. A refusal now quotes
  the command as written, not a masked copy (`tail -f ______`).
- **Only the first line of a result is its header.** A command that printed a `run=R…` line
  of its own (a saved result, `busybox log R --summary`) was taken for that run and given its
  TIMEOUT or KILLED notice. The host's own `Exit code N` line may still come first.
- **The timing digest.** It invented a pause across a truncated view (400 lines 10 ms apart
  read "longest pause 5.24s"), dropped a pause when there was also a silence at the end, and
  said nothing about one line followed by five silent seconds.
- **Notes follow what the shell ran.** "A process was left running" appeared after the
  command had killed it and was missing for `sleep 2 & echo started`. "The pipeline ends in
  `tail`" appeared with no pipe (`tail -n 2 f`, `make || tail -5 log`, a quoted
  `"a|tail"`). "stdout was discarded" appeared for a string that merely mentioned
  `>/dev/null` (a nested `sh -c '… 2>/dev/null'` still counts).
- **A compound command starting with `busybox`** (`busybox waitfor … && npm test`) ran with
  no capture, no deadline and no guard.
- **The exit trap printed `+ __pt_ps=0`** into a command's stderr under `set -x`.
- **A default deadline under one second** became `--timeout 0`, which fires before the
  command starts.

## [0.6.0] - 2026-11-24

What the plugin costs in tokens, measured and cut. Everything it adds to a result is read
by the model and stays in the conversation for every later turn; the section it adds to
the system prompt is read on every request.

Measured with the API's own count on 60 results from real sessions (1,816 lines of output,
45,700 tokens of the commands' own text):

| | Tokens the plugin added | Per result | On top of the output |
|---|---|---|---|
| 0.4.1 | 24,500 | 408 | 54% |
| 0.5.0 | 19,000 | 317 | 42% |
| 0.6.0 | 6,200 | 103 | 14% |

### Changed

- **A stamp starts a burst; the lines under it carry none.** A full stamp,
  `[0.030555209 out] `, is about ten tokens: digits are expensive. Over 13,616 stamped
  lines from 416 results, 54% share their offset with the line above to the nanosecond and
  86% to the millisecond. A line at the same offset and on the same stream as the line
  above it is now written bare. One at the same offset that needs a mark — the stream
  changed, or its own text begins with `[` or has the shape of a line the capture prints —
  reads `[= err] text`. Every change of stream is therefore still marked. This is what
  `compactStamps` means now; off puts a stamp on every line.
- **Offsets are to the millisecond**, cut and never rounded up, and never padded. The
  capture keeps nanoseconds and `busybox log` prints them. `stampDigits` (1 to 9,
  `CLAUDE_MANAGED_TOOLS_STAMP_DIGITS`) sets the decimals.
- **The header is one line.** `run=R12 exit_code=0 duration_ms=328` where there were three
  lines: 20 tokens a call instead of 76. A flag is printed only when it is true, the line
  counts only when the view was cut, and `--- timeline ---` not at all. Four results in
  ten are under 600 characters; for those the header was half the text. The sectioned view
  (`brief`) keeps its section markers and loses its two artifact paths.
- **The notes follow a line `--- pi-time ---`.** With most output lines bare, the digest,
  the pointer into a cut view and the notes need one line in front of them to be told
  from output.
- **The system prompt section is a third shorter**: 1,068 tokens from 1,596, with every
  fact kept and the long form of each left to the skill. The skill's description, also
  always in context, is 171 tokens from 271.
- **The truncation pointer names the binary once**, not three times: its path alone is
  about twenty tokens.

### How the new spelling was checked

- **That it can be read.** Before it was adopted, Claude Haiku was asked eight questions
  with known answers about one result — which stream a line arrived on, at what offset, how
  long between two lines, whether a line was output or a note — in four spellings. All
  eight were right in every run: five runs in this spelling, four in each of the others.
  One small result and one model: it shows the spelling can be read, not that it always is.
- **That it loses nothing but the decimals.** `expandStamps` gives every line of a
  compacted result its stamp back, and the tests hold the two to be equal.
- **That every reader of a stored result still works.** The digest, the truncation pointer
  and the outcome notices are worked out on the capture as `run` printed it, before it is
  respelled; the person's row strips both spellings to the same lines.

### Costs

- A model reading a long burst has to look up for its stamp: a line no longer says its own
  stream.
- Two events inside one millisecond show the same offset. Their order is still the order
  of the lines; their interval needs `busybox log`, or `stampDigits`.
- A result with nothing after the output looks the same as before to a reader who does not
  know the format; one who does is told the notes begin at `--- pi-time ---`.

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
