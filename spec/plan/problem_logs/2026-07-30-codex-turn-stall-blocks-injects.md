# Codex turn stall blocks later Satelles injects

- Date: 2026-07-30
- Status: unresolved
- Area: Satelles runner / Codex app-server turn lifecycle
- Severity: high — an interactive Discord session remains marked active but no longer responds

## Summary

Satelles session `satelles-794da12b-a3d2-4b8f-8725-57e2e4e430c7`
stopped producing transcript frames during an in-progress Codex turn. Discord
messages continued to reach Concordia successfully, but Satelles did not process
them because the current turn never completed.

The task the stalled session was executing was an Anatomia data-schema review,
not Satelles work. That in-progress work is preserved locally at commit
`8e8a7ad` in the `.wt-Anatomia-data-schema-review` worktree under the LUDIARS
workspace root; the feature branch was not pushed and no pull request was
created. No fix for the stall described here exists in that commit.

## Evidence

- Session start: 2026-07-30 20:21:08 JST.
- Last transcript frame: 2026-07-30 20:36:09 JST, sequence 63, assistant
  commentary announcing the next push and PR-creation step.
- The turn started at 20:21:42 JST and has no later `codex_turn_completed` frame.
- Concordia accepted later Discord injects at 20:57:37, 20:57:58, and 20:59:46
  JST, including `hello`.
- At 21:11 JST Concordia still reported the session as `active`, with
  `last_seen_at` corresponding to 20:36:09.
- At 21:14 JST the processes started with the session were still alive:
  Satelles Node PIDs 2084 and 24456, and Codex PID 4260.
- PID 2084 retained an established TCP connection to Concordia on its catalog
  port, so the failure is not a simple Satelles process exit or relay outage.
- Concordia health was OK and Discord ingress logged HTTP 200 for every later
  inject.

Relevant code:

- `src/runner.ts`: `runRunner` awaits `session.runTurn(...)` before taking the
  next item from `InputQueue`.
- `src/codex-session.ts`: `runTurn` waits for the Codex turn terminal status
  (`turn/completed`), with a default timeout of four hours
  (`DEFAULT_TURN_TIMEOUT_MS`). The timeout is absolute; there is no
  no-progress/idle bound on the event stream.
- `src/runner.ts`: `InputQueue` is an unbounded in-memory FIFO, so injects
  arriving during a stall are retained in order — but only for the lifetime of
  the Satelles process. Restarting the process drops them.
- Satelles implements no turn-cancel RPC: only `turn/start` is sent, and the
  sole interruption path is `session.terminate()`, which kills the
  `codex app-server` child and ends the thread.

## Regression Context

No prior identical Satelles incident was established during this investigation.
The behavior is nevertheless user-visible as a stale active session: ingress
accepts work that cannot be consumed until the stuck turn exits.

## Cause

The immediate cause is an in-progress Codex app-server turn that stopped
emitting events after sequence 63 without reaching a terminal status. The exact
underlying Codex transport or model-side reason is not yet known.

Satelles then amplifies the stall: later `session.inject` messages are queued,
but the single-turn loop cannot consume them while `runTurn` is still awaiting
completion. The four-hour timeout is too long for an interactive session to
surface this failure promptly.

## Fix Requirements

- Detect a turn whose event stream has made no progress for a configurable
  interactive-session interval.
- Surface a clear stalled/degraded state to Concordia instead of leaving the
  session apparently active. Satelles sends no session status today — `active`
  is derived Concordia-side — so this needs an explicit signal over the existing
  `patchSession` or `/event` endpoint.
- Provide a safe cancel or restart path that preserves queued injects and the
  Codex thread identity when possible. This requires new work: no turn-cancel
  RPC is wired up, and the in-memory `InputQueue` does not survive a process
  restart, so in-process recovery is the only option that keeps queued injects.
- Ensure a stalled turn does not silently block later Discord input for hours.
- Preserve the existing absolute turn timeout as a final safety bound.

## Verification

- Add a test where Codex emits a turn start and then no further events; assert
  that Satelles reports the stall within the configured interval.
- Add a test that injects arriving during the stall remain ordered and are
  available after recovery.
- Add a test for explicit cancellation/recovery and one for failure to recover.
- Verify the Concordia status card shows a visible degraded or failed state
  instead of remaining indefinitely `active`. This one is a manual check: it
  needs a live Concordia and a real stalled session, so the automated tests
  above cannot cover it.

No tests or service restarts were run during this diagnosis.

## Follow-up

- Operationally recover or replace the stale session before resuming work.
- Resume the preserved Anatomia commit, then push the branch and create its PR.
- Capture Codex app-server diagnostics during the next occurrence to determine
  whether the underlying stall is transport-, account-, or model-side.
