# Session-local compatibility transport

Value: scheduled workers can execute their existing report/task/clock-out instructions.
Owner: concordia-link owns HTTP input and session identity; runner-orchestration owns lifetime and shutdown.

The runner listens on OS-assigned port 0 at 127.0.0.1 after Concordia registration.
This is an ephemeral per-session endpoint, not a catalog service port. It supplies
LICTOR_PORT and LICTOR_SESSION_ID to app-server; it never borrows another runner's identity.

Supported Lictor-compatible routes: GET /v1/health, GET /v1/concordia/session,
GET/POST /v1/lictor/task, POST /v1/chat, POST /v1/report, POST /v1/shutdown,
POST /v1/runtime/model-effort.
POST /v1/internal/send-file accepts files/caption and stamps channel=system;
Concordia's canonical attachment guard validates paths before accepting delivery.
Other routes return explicit 404. This is a compatibility subset, not a Lictor process.
Chat identity is fixed to the registered session; caller-supplied session IDs,
Discord destinations and arbitrary metadata are not forwarded.

Shutdown finishes the active turn, flushes its transcript, and skips further input.
An idle input wait is woken by the shutdown request. Socket/registration resources
are released on app-server bootstrap failure as well as normal/error termination.

WSL receives identity variables explicitly. The listener lives on the Windows host:
WSL tasks must use Windows curl.exe (or mirrored loopback networking) to reach it.
No host-wide listener or firewall change is made to make NAT loopback work.

## Runtime model / effort switch (actio:088870fb-3989-4646-b3a2-f96dca021aa6)

POST /v1/runtime/model-effort takes Lictor's body `{model, effort}` and replies
`{ok: true, message}` or `{error[, message]}` (400 for missing/invalid values).
Satelles has no TUI: the accepted pair is stored and sent as `model` / `effort` on
the next `turn/start`; a running turn is not interrupted. Codex effort vocabulary
(minimal/low/medium/high/xhigh/ultra) is accepted, matching `--effort`.

After binding, the runner PATCHes `metadata.satelles_sidecar_port` (best-effort).
It is deliberately not `lictor_port`: Concordia uses that key for Lictor-only
operations (force-exit, PTY rename, relictor) this subset does not serve. Concordia
resolves `satelles_sidecar_port` only for the runtime switch.
