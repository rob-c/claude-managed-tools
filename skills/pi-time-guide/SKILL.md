---
name: pi-time-guide
user-invocable: false
description: "How to read and work with Pi-Time, the timeline every Bash result comes back as in this session: lines prefixed `[0.012345 out]` / `[0.012349 err]` (or padded, `[   0.012345 out]`; or `[= out]` for a line at the same offset as the one above), a `run=R12 exit_code=… duration_ms=…` header, a `timing:` digest, a `TIMEOUT` notice, `truncated=true` views. Load it when a Bash result carries those prefixes and you need to reason about ordering, duration, which stream a line came from, a deadline, or how to read the rest of a truncated or past run with `busybox log`; when a command was refused for a stream merge at its tail; or when you need byte-exact output. Never merge stderr into stdout — the merge happens before the timeline can tag anything."
---

# Pi-Time

Pi-Time attaches time itself to every Bash execution — **which stream**, **when**, and
**how long is too long** — because a plain capture cannot say which stream a line came
from, when it arrived, or whether a run that stopped had failed or was stopped.

Every foreground Bash command runs through `busybox run --timestamps`: one interleaved
line per record, with its offset and the stream it arrived on.

```
run=R134 exit_code=0 timed_out=false cancelled=false duration_ms=8421
timeline_lines=3 shown=3 truncated=false
--- timeline ---
[0.011354208 out] ok 1
[2.320004125 err] FAILED test_x
[8.421130000 out] done
timing: 8.42s total, 3 lines, output from 0.01s, stderr from 2.32s, longest pause 6.10s (2.32s → 8.42s)
```

The offset is seconds since the command started, as a decimal number: nine decimals
(nanoseconds, where two events in the same microsecond still keep their order) on a
current build. Other builds pad the number to a fixed width (`[   0.011354 out]`,
`[00000.011354208 out]`) or print fewer decimals (`[0.011354 out]`, `[1.225 out]`). It is
the same field in every shape.

A line that arrived at the same offset as the line above it carries `[= out]` or
`[= err]` instead of the digits: the same instant, said once. Three lines flushed together
read `[0.011354208 out] a`, `[= out] b`, `[= err] c` — one burst, with the stream still
named on each. (`busybox log` prints every offset in full when you read a run back.)

## Reading it

- **The offsets are facts.** The failure came *after* `ok 1` and *before* `done`. Read
  them before concluding anything about causality, order or duration — never answer
  "undetermined" about something the offsets state.
- **A burst of lines sharing one offset** is a writer that flushed at exit rather than
  streaming. That is information about the program, not about the wrapper.
- **`timing:`** appears on runs over a second: total, where output began, where stderr
  began, and the longest silence. It is the quickest way to see where the time went.
- **The header's `exit_code`** is the command's own status. In a pipeline it is the last
  stage's, and the result says so when that misleads (`head` closing the pipe, `grep`'s
  1 meaning "no match", a `|| true` mask).
- **The person watching sees the command's own lines**, without the prefixes. Do not
  strip or re-print the timeline for them, and do not quote the prefixes back unless the
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
- the next move is a larger `timeout` (milliseconds), a narrower command, or
  `run_in_background: true` — not a debugging detour.

Three other notices name an ending that is not the command's own exit, each with
`exit_code=-1` in the header:

- **`IDLE`** — the command printed nothing on either stream for the silence limit (120 s
  unless configured otherwise; the system prompt gives the number when one is in force)
  and was taken to be stuck. The limit holds whatever `timeout` the call named, so a
  larger `timeout` does not help. It was not waiting on standard input: stdin is empty
  here and a read returns end-of-file at once (the notice says so when that is not true of
  the terminal mode in use). Look at what else blocks — a lock, a socket, a child that
  never exits, a prompt that opens the terminal itself (`sudo`, `ssh`). If it was working
  quietly, make it report progress (a verbose flag; any line on either stream resets the
  clock) or use `run_in_background: true`.
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
