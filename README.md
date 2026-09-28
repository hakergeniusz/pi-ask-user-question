# pi-ask-user-question

Claude Code-style interactive questioning for [pi](https://github.com/earendil-works/pi).

Lets the model ask 1-4 multiple-choice questions (2-4 options each) mid-turn, with
tabs, descriptions, an inline editor for "Other", and free-text fallback.

## What makes it different

- **Hard 3-minute timeout.** The whole call must be answered in time. The TUI shows a
  live countdown, and on expiry the dialog closes itself and returns
  `Timeout - user did not reply within 3 minutes. Do not retry.` so the model stops
  re-asking. RPC dialogs receive the remaining time.
- **Two modes.** `sync` (default) blocks the turn until answered, declined, or timed
  out. `async` returns immediately, leaves the question open, and pushes the answer
  back into the session with `pi.sendUserMessage()` when the user responds -- so the
  agent keeps working and is notified either way.
- **`/ask-pending [id]`** inspects questions still waiting on the user.
- Starts only one dialog at a time: a new question withdraws an older pending one.

## Install

```bash
pi install git:github.com/hakergeniusz/pi-ask-user-question
```

## Attribution

Independent implementation. Prior art, credited as inspiration rather than as a
source: Amos Blomqvist's pi-config ships an `ask-user-question` extension for the same
feature. A line-level comparison found 59 shared non-blank lines out of 669 / 964 and
zero matching blocks of five or more consecutive lines -- shared idioms and statements
forced by pi's extension API, not a shared implementation. No code was copied and none
is inherited. `pi-config` carries no license; this project is MIT.

MIT licensed.
