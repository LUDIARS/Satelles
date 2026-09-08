# Satelles parttimer has no session sidecar

- Date: 2026-09-09
- Status: fixed in working tree
- Area: runner / Concordia link / child environment
- Severity: scheduled work can stop before reporting or clocking out

## Summary

neco reports that scheduled Satelles workers do not work because LICTOR_PORT is missing.

## Evidence

- Concordia's `src/delegation/parttimer-prompts.ts` requests POST `$LICTOR_PORT/v1/chat`.
- `src/delegation/parttimer-inject.ts` requires POST `$LICTOR_PORT/v1/shutdown`.
- Satelles `src/runner.ts` only registers with Concordia and starts app-server; no local listener exists. `buildCodexChildEnv(process.env)` cannot create a session endpoint.

## Regression Context

The headless provider retained Lictor-oriented instructions without implementing their transport contract. A missing port must not be replaced with a parent session's port.

## Cause

Missing session-owned HTTP transport, not just a missing environment copy.

## Fix Requirements

- Offer a loopback listener in the existing runner process before app-server starts.
- Override inherited LICTOR_PORT / LICTOR_SESSION_ID with the current session's identity; standalone must remove inherited identity.
- Stamp outgoing reports with the registered session, reject browser-origin calls, limit request bodies, and expose only explicit routes.
- Shutdown acknowledges a request and ends after the current turn and transcript flush. Close listener/liveness on startup failure and normal/error termination.
- Keep no additional child process, PTY, or filesystem watcher.

## Verification

Added regression tests for HTTP identity isolation, upstream failure handling, invalid/oversized bodies, browser-origin rejection, response-before-shutdown ordering, file routing, environment replacement, WSL export and shutdown during an ask wait. Startup-failure cleanup was statically reviewed. TypeScript no-emit checks passed for production sources and changed tests; git diff --check passed. Tests are authored but not executed here, per the Revisor workflow. No live agent or service was started by this session.

## Follow-up

Build the merged Satelles main checkout before the next scheduled launch. Existing runners do not gain a new listener without being replaced.
