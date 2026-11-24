---
name: pi-time-guide
user-invocable: false
description: "How to read Pi-Time, the timeline every Bash result comes back as in this session: a `run=R12 exit_code=… duration_ms=…` header, `[0.012 out]` / `[0.340 err]` stamps that each start a burst of lines, notes after `--- pi-time ---`, a `TIMEOUT` or `IDLE` notice, `truncated=true` views. Load it to reason about ordering, duration or which stream a line came from, to read the rest of a truncated or past run with `busybox log`, when a command was refused before it ran, or when you need byte-exact output."
---

# Pi-Time

Pi-Time attaches time itself to every Bash execution — **which stream**, **when**, and
**how long is too long** — because a plain capture cannot say which stream a line came
from, when it arrived, or whether a run that stopped had failed or was stopped.

Every foreground Bash command runs through `busybox run --timestamps`, and comes back
with the stream and the moment each line arrived.

```
run=R134 exit_code=0 duration_ms=8421
[0.011 out] collecting
collected 12 items
ok 1
[2.320 err] FAILED test_x
  assert 3 == 4
[= out] [INFO] retrying
[8.421 out] done
--- pi-time ---
timing: 8.42s total, 7 lines, output from 0.01s, stderr from 2.32s, longest pause 6.10s (2.32s → 8.42s)
```

- **The header** is one line: the run's id (what `busybox log` takes), the command's exit
  code and how long it ran. A field appears only when it says something: `timed_out=true`,
  `idle=true` or `cancelled=true` when the run was stopped, and a second line
  `timeline_lines=3000 shown=724 truncated=true` when the view was cut.
- **A stamp starts a burst.** `[0.011 out]` is seconds since the command started, and the
  stream the line arrived on. Every line under it that has no stamp arrived at that same
  offset on that same stream: `collected 12 items` and `ok 1` are stdout at 0.011 s, and
  `  assert 3 == 4` is stderr at 2.320 s.
- **`[= out]` or `[= err]`** is a line at the same offset as the one above that needed a
  mark of its own: the stream changed, or its own text begins with `[` or looks like a
  line of the capture's. Above, `[INFO] retrying` is stdout at 2.320 s.
- **`--- pi-time ---`** ends the command's output. What follows is the capture's own:
  the `timing:` digest, the pointer into a truncated view, notes on what the command hid.

Offsets are cut to the millisecond, never rounded up. The capture itself keeps nanoseconds,
and `busybox log` prints every line with its full stamp when you read a run back — use it
when two events inside one millisecond have to be told apart.

## Reading it

- **The offsets are facts.** The failure came *after* `ok 1` and *before* `done`. Read
  them before concluding anything about causality, order or duration — never answer
  "undetermined" about something the offsets state.
- **A long burst under one stamp** is a writer that flushed at once rather than
  streaming. That is information about the program, not about the wrapper.
- **Every change of stream is marked.** A line is on the stream of the nearest stamp above
  it; a line with no stamp is never on another stream than the line before it.
- **`timing:`** appears on runs over a second: total, where output began, where stderr
  began, and the longest silence. It is the quickest way to see where the time went.
- **The header's `exit_code`** is the command's own status. In a pipeline it is the last
  stage's, and the result says so when that misleads (`head` closing the pipe, `grep`'s
  1 meaning "no match", a `|| true` mask).
- **The person watching sees the command's own lines**, without the stamps. Do not
  strip or re-print the timeline for them, and do not quote the stamps back unless the
  timing is the point.

## The terminal

stdout is a pseudo-terminal 200 columns by 50 rows, stderr a pipe and stdin empty, so
`isatty(1)` is **true**: Python, Node, Ruby, C stdio and Java line-buffer and their lines
carry real intervals, and stderr keeps its `err` tag. Colour, pagers and prompts are
switched off through the environment (`NO_COLOR`, `TERM=dumb`, `PAGER=cat`,
`GIT_TERMINAL_PROMPT=0`, `PYTHONUNBUFFERED=1`, and the like).

A program that formats for a terminal does so here, when it is the last stage of the
command:

- `ls` prints names in tab-separated columns — `ls -1` gives one per line;
- `ps` cuts each line at 200 columns — `ps -ww` gives whole command lines;
- anything that draws to the terminal's width (test runners' rules, tables) uses 200.

A stage that writes into a pipe (`ls | sort`, `ps aux | grep x`) sees a pipe, as always.

Inside Claude Code's sandbox no pseudo-terminal can be allocated. The wrapper then runs
the command on plain pipes: the tags and the order of stderr are still exact, and stdout's
timing is what the next section says for a pipe.

## When stdout is not the terminal

Only the last stage of a command writes to the terminal. A stage inside a pipeline
(`make | tee build.log`, `./server | grep ERROR`), or output redirected to a file, writes
to a pipe or a file — and a program that block-buffers there holds its lines until its
buffer fills or it exits, so they all carry the offset of the flush.

The wrapper switches that off through the environment wherever a runtime allows it (the
system prompt says which apply on this machine):

| Runtime | On a pipe or into a file |
|---|---|
| Node, Deno, Bun, PHP, Go, Rust, Java, Tcl, R, Elixir, shell builtins | always written as printed |
| Python, Ruby, Perl, Lua | written as printed (set by the wrapper) |
| C stdio — `grep`, `sed`, `awk`, `cut`, `tr`, `jq`, compiled C, Swift | macOS: written as printed. Linux: in blocks, unless the preload is on |
| Haskell (GHC), OCaml `Printf`, `mawk` | in blocks; nothing outside the program changes it |

Where a stage still writes in blocks and its timing matters, make that stage flush:
`grep --line-buffered`, `sed -u`, `mawk -W interactive`, `stdbuf -oL cmd`, or the
program's own flush. A burst of lines sharing one offset is the sign.

A line at a time is slower for bulk output. For millions of lines into a file or a pipe
from a C tool on macOS, give that one command its block buffer back:
`STDBUF1=F sort big.txt > sorted.txt`.

A log file a background program writes (`./server > srv.log &`) can be read while the
program runs for the same reason: its lines reach the file as they are printed.

## Never merge the streams

A merge (`2>&1`, `|&`, `&>`) happens *inside the command*, before anything can be tagged:
every line then arrives as `out`, and the warning you needed to see as `err` has lost its
identity. The two streams are already captured separately — keep them separate.

| Instead of merging to… | Do this |
|---|---|
| silence noise | redirect only the stream you do not want: `cmd >/dev/null` keeps stderr tagged |
| see the errors | run it plainly and read the `err` lines |
| filter stderr of a past run | `busybox log R12 --stream stderr --match <literal>` |
| log a background server | two files: `cmd >srv.log 2>srv.err &` |
| test an exit status quietly | `cmd >/dev/null` |

A merge at the very end of a command is **refused before it runs**, with the rewrite in
the refusal: write the replacement rather than retrying the same text. A merge deep
inside a script you authored is left alone. If a merge is genuinely intended and you will
not read that output back as evidence, append `# pitime-safe`; the result then says its
tags are not evidence.

## Deadlines

A call with no `timeout` has a default deadline (120 s unless configured otherwise). When
a deadline fires the result *opens* with the notice — before the header and the output —
and its first words are `TIMEOUT — not a failure of the command`:

- the command was *stopped*, it did not error — `exit_code=-1` and "Exit code 3" are the
  kill status;
- everything it printed before the kill is in the result, and the capture is complete;
- a line beginning `CPU:` says what the processor was doing, when the command was watched:
  "it used 117.3s of processor time in 120s and was still computing" means it was working
  and needs longer; "…and none at the end" means it was waiting, and more time alone will
  not help;
- the next move is a larger `timeout` (milliseconds), a narrower command, or
  `run_in_background: true` — not a debugging detour.

Three other notices name an ending that is not the command's own exit, each with
`exit_code=-1` in the header:

- **`IDLE`** — the command showed no sign of life for the silence limit (120 s unless
  configured otherwise; the system prompt gives the number when one is in force) and was
  stopped as stuck. A sign of life is a line on either stream *or* processor time, so the
  notice says both: "for 121s it printed nothing and used no processor time to speak of".
  It was waiting, not working, and the limit holds whatever `timeout` the call named, so a
  larger `timeout` does not help. It was not waiting on standard input: stdin is empty
  here and a read returns end-of-file at once (the notice says so when that is not true of
  the terminal mode in use). Look at what else blocks — a lock, a socket, a child that
  never exits, a prompt that opens the terminal itself (`sudo`, `ssh`). A command that is
  meant to wait belongs in `run_in_background: true`. (Where a command could not be
  watched — the system prompt then says "prints nothing" rather than "neither prints nor
  uses the processor" — silence alone decided, and a quiet command that was working may
  have been stopped: make it report progress.)
- **`CANCELLED`** — stopped on request (an interrupt), not by a failure.
- **`KILLED`** — the command's shell was ended by a signal.

Background commands are not wrapped: they return at once and are read from their own
output file, with no timeline.

## Commands that are refused before they run

Nobody can press a key or Ctrl-C for a command here. So a command that only ends that way
is refused before it runs, with what to write instead: a pager at the end of a pipeline
(`git log | less`), an editor, `watch`, `top`, `tail -f`, `git rebase -i`, `git add -p`,
and a foreground server (`npm run dev`, `python3 -m http.server`, `docker compose up`).
Do what the refusal says rather than retrying the same line:

- drop the pager — the output is captured whole;
- read what is there now (`tail -n 50 file`) instead of following;
- start what must keep running with `run_in_background: true`, and stop it when done.

The same goes for a prompt: a `[y/N]` question reads end-of-file and takes its default or
fails, so put the answer in the command (`printf 'y\n' | cmd`, a `--yes` flag).

If a refused command really does end on its own, append `# pitime-safe` to it. A stream
merge at a command's tail (`2>&1`, `|&`, `&>`) is refused the same way and has the same
override.

## Reading more of a run

A view marked `truncated=true` shows the head and the tail of the output, with one line
between them marking the cut (`... [timeline truncated: 724 of 3000 lines shown (2276
omitted) …] ...`). What you lack is the middle. The line after the view says which lines
those are, how many of them are on stderr — a view with no `[err]` line is not proof of no
errors until that count says "none" — and the command that reads from the gap. The capture
is complete on disk: captures are kept for at least two hours, and the newest 200 for
longer. The forms are:

```sh
busybox log R12 --stream timeline --lines 2960:3000   # the end, interleaved, with offsets
busybox log R12 --match "FAILED"                      # stdout lines containing a literal
busybox log R12 --stream stderr                       # one stream alone
busybox log R12 --meta                                # exit status, duration, sizes
```

A build from busybox-static 0.6.0 on (the system prompt names these when it is one) also
answers questions about a run's shape without printing the run:

```sh
busybox log R12 --sample 20                 # the first 20 and the last 20 lines
busybox log R12 --since 30 --until 45       # the timeline between two offsets, in seconds
busybox log R12 --around-gap 1              # the widest silences of a second or more
busybox log R12 --summary                   # one line: lines, stderr, longest gap, exit
```

Call the binary by the path the result or the system prompt gives: the packaged build is
not on `PATH`, and a host `busybox` has no `log` applet.

## Byte-exact output

You almost never need to do anything. What runs *inside* a command sees exact bytes — a
pipe into `jq`, a redirect, `sha256sum dist.tgz` — because the offsets are added to the
result you read back, not to the command. `command x` is the ordinary shell builtin and is
captured like anything else.

If one result itself must come back unprefixed, end the command with `# pitime-raw`:

```sh
jq -r .version package.json # pitime-raw
```

That call returns no timeline, no stream tags and no timing, so it is the last thing to
reach for, not a habit.

## What a result cannot show, it says

A command that discards a stream (`>/dev/null`, `2>/dev/null`), leaves a process running
in the background, declares a merge, or ran unwrapped gets a line on its result naming
exactly what you cannot know from it. Treat those lines as the edges of your evidence.
The first time a note appears it is a full sentence; after that it comes back in a few
words (``exit_code is `head`'s, not the command's.``) and means the same.

The exit code in the header is the *last pipeline stage's*. When the stages disagree, the
result says what each one returned:

```
pipeline stage statuses: 1 141 0 — the exit_code shown is the last stage's; 141 is a stage
ended by SIGPIPE because the next stage stopped reading, not a failure of its own; an
earlier stage failed (1) and the header does not show it.
```

Read it left to right against the pipeline as written. No such line on a pipeline's result
means every stage exited 0. (The statuses come from the command's own shell; a command
that sets its own `EXIT` trap gets the older caveat instead — "its own status is unknown".)

## Commands the person runs themselves

A command the person runs with `/sh` goes through the capture and reaches you as a
timeline in a `<bash-stdout>` block, with the same header, offsets, digest and notes as a
Bash result. Read it the same way. It is context, not a request.

The default deadline covers these commands too. When one of theirs comes back as a
`TIMEOUT`, it was stopped, it did not fail — and there is no `timeout` parameter to raise,
because no call was made. What gives it longer is theirs to type:
`/pi-time timeout <seconds>` for the session, or `/pi-time timeout off`. Say that, rather
than re-running the command for them unasked.

A command the person types with `!` normally goes through the capture too, and its
`<bash-stdout>` block is then the same timeline: look for the `run=R…` header. The system
prompt says which is in force. When a `!` block has no header and no offsets it ran
outside the capture: both streams arrive inside `<bash-stdout>` and their order there is
not evidence. If timing or stream identity matters for such a command, say that the block
cannot show it, and suggest `/sh <command>`.

## Switches

`/pi-time` shows the state. `/pi-time verbosity quiet|normal|verbose|brief` changes the
view for the session (6 KB, 24 KB, 27 KB, or repeats collapsed with no per-line timing —
the answer for forty thousand lines of the same thing). `/pi-time off` runs Bash unwrapped.
