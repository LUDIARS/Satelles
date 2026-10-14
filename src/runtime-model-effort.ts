/**
 * Runtime model / reasoning-effort switch requested through the session sidecar.
 *
 * Lictor applies the same request by typing `/model` `/effort` into a TUI. Satelles
 * has no TUI: app-server accepts `model` / `effort` on every `turn/start`, so the
 * request is stored here and the runner hands it to the next turn. A running turn
 * is never interrupted.
 *
 * @implements SPEC-RUNTIME-MODEL-EFFORT (Lictor-compatible body and reply shape)
 */
import { VALID_EFFORT, MODEL_ID_RE } from "./config.js";
import { contract } from './contract-runtime.js'; /* augur-inject:import:c75d9852 */
import augurContract_5183c274 from './contracts/runtime-model-effort-reply.contract.js'; /* augur-inject:contract-predicate:225efbc2 */
import augurContract_2376832a from './contracts/turn-start-model-effort.contract.js'; /* augur-inject:contract-predicate:981696ab */

export interface RuntimeModelEffortRequest {
  model: string;
  effort: string;
}

export type RuntimeModelEffortResult =
  | { ok: true; status: 200; message: string }
  | { ok: false; status: 400; error: string; message?: string };

/** Overrides for the next `turn/start`; null means "keep the thread's current value". */
export interface TurnModelEffort {
  model: string | null;
  effort: string | null;
}

export class RuntimeModelEffortState {
  private latest: TurnModelEffort = { model: null, effort: null };

  /** Validate and store a switch. It takes effect from the next turn. */
  apply(request: RuntimeModelEffortRequest): RuntimeModelEffortResult {
    const model = request.model.trim();
    const effort = request.effort.trim().toLowerCase();
    if (model.length > 100 || !MODEL_ID_RE.test(model)) return { ok: false, status: 400, error: "invalid_model" };
    if (!VALID_EFFORT.has(effort)) return { ok: false, status: 400, error: "invalid_effort" };
    this.latest = { model, effort };
    return {
      ok: true,
      status: 200,
      message: `Codex model=${model}, effort=${effort} を次のターンから適用します。`,
    };
  }

  /** Values to send on the next `turn/start` (re-sent every turn; app-server treats them idempotently). */
  forNextTurn(): TurnModelEffort {
    return { ...this.latest };
  }
}

export interface RuntimeModelEffortReply { status: number; body: unknown }

/**
 * HTTP-shape adapter for `POST /v1/runtime/model-effort` (body / reply identical to
 * Lictor sidecar, so Concordia keeps one client).
 */
export function handleRuntimeModelEffort(
  state: Pick<RuntimeModelEffortState, "apply">,
  body: unknown,
): RuntimeModelEffortReply {
  const payload = (body ?? {}) as { model?: unknown; effort?: unknown };
  if (typeof payload.model !== "string" || typeof payload.effort !== "string") {
    return { status: 400, body: { error: "body.model and body.effort (string) are required" } };
  }
  const result = state.apply({ model: payload.model, effort: payload.effort });
  if (!result.ok) {
    return { status: result.status, body: { error: result.error, ...(result.message ? { message: result.message } : {}) } };
  }
  return { status: 200, body: { ok: true, message: result.message } };
}
// @ts-expect-error augur-inject
handleRuntimeModelEffort = contract(handleRuntimeModelEffort, { ...augurContract_5183c274, contractId: 'C-1', mode: 'observe', sample: 1, where: 'src/runtime-model-effort.ts:57', rule: 'contract-wrap', id: '5183c274' }); /* augur-inject:contract-wrap:5183c274 */

/** `turn/start` params for a switch; unset values are omitted so the thread keeps its own. */
export function turnStartModelEffort(next: { model?: string | null; effort?: string | null }): { model?: string; effort?: string } {
  return {
    ...(next.model ? { model: next.model } : {}),
    ...(next.effort ? { effort: next.effort } : {}),
  };
}
// @ts-expect-error augur-inject
turnStartModelEffort = contract(turnStartModelEffort, { ...augurContract_2376832a, contractId: 'C-2', mode: 'observe', sample: 1, where: 'src/runtime-model-effort.ts:73', rule: 'contract-wrap', id: '2376832a' }); /* augur-inject:contract-wrap:2376832a */
