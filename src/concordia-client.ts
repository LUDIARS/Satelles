/**
 * Concordia API の Satelles が使うサブセット。Lictor `concordia.ts` からの
 * 移植 + pending-question POST を統合。
 *
 * Concordia 連携は best-effort — coordinator 停止でランナー本体を殺さない。
 * (登録失敗だけは呼び出し側が fail とするか選べる。)
 */

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 11111;
const POST_TIMEOUT_MS = 10_000;

export interface ConcordiaConfig {
  host: string;
  port: number;
  baseUrl: string;
  enabled: boolean;
}

export function loadConcordiaConfig(env: NodeJS.ProcessEnv = process.env): ConcordiaConfig {
  const host = env.CONCORDIA_HOST?.trim() || DEFAULT_HOST;
  const port = Number(env.CONCORDIA_PORT) || DEFAULT_PORT;
  const enabled = env.SATELLES_DISABLE_CONCORDIA !== "1";
  return { host, port, baseUrl: `http://${host}:${port}`, enabled };
}

export interface SessionRegisterPayload {
  id: string;
  provider: string;
  repo_path: string;
  host: string;
  branch?: string | null;
  metadata?: Record<string, unknown>;
}

export interface PendingQuestionPayload {
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export class ConcordiaClient {
  constructor(public readonly cfg: ConcordiaConfig) {}

  async register(payload: SessionRegisterPayload): Promise<void> {
    await this.fetchJson("POST", "/v1/sessions", payload);
  }

  /** Best-effort — server may already have GC'd the session. */
  async unregister(id: string): Promise<void> {
    try {
      await this.fetchJson("DELETE", `/v1/sessions/${encodeURIComponent(id)}`);
    } catch {
      /* best-effort */
    }
  }

  async patchSession(id: string, patch: Record<string, unknown>): Promise<void> {
    await this.fetchJson("PATCH", `/v1/sessions/${encodeURIComponent(id)}`, patch);
  }

  async event(id: string, payload: { kind: string; payload?: unknown }): Promise<void> {
    await this.fetchJson("POST", `/v1/sessions/${encodeURIComponent(id)}/event`, payload);
  }

  /**
   * ask マーカー由来の質問を Concordia の pending-question パイプラインへ流す。
   * 戻り値は Concordia 側 question_id。失敗は null (best-effort — Concordia
   * 停止で質問が Discord に出ないのは仕方ないが、ランナーは落とさない)。
   */
  async postPendingQuestion(id: string, pq: PendingQuestionPayload): Promise<number | null> {
    try {
      const json = await this.fetchJson<{ question_id?: unknown }>(
        "POST",
        `/v1/sessions/${encodeURIComponent(id)}/pending-question`,
        { question: pq.question, options: pq.options, multi_select: pq.multiSelect === true },
      );
      return typeof json?.question_id === "number" ? json.question_id : null;
    } catch {
      return null;
    }
  }

  openLiveness(
    id: string,
    enrollment: string | null,
    onMessage?: (msg: unknown) => void,
  ): LivenessHandle {
    return new LivenessHandle(this.cfg, id, enrollment, onMessage);
  }

  private async fetchJson<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.cfg.baseUrl}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), POST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const res = await fetch(url, {
        method,
        headers: body !== undefined ? { "content-type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Concordia ${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`Concordia ${method} ${path}: non-JSON response`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export function buildLivenessUrl(
  cfg: Pick<ConcordiaConfig, "host" | "port">,
  sessionId: string,
  enrollment: string | null,
): string {
  const params = new URLSearchParams({ session: sessionId });
  if (enrollment) params.set("enrollment", enrollment);
  return `ws://${cfg.host}:${cfg.port}/ws?${params.toString()}`;
}

export function isTerminalLivenessClose(code: number): boolean {
  // Concordia uses WebSocket policy violation (1008) for a missing or invalid
  // enrollment — reconnecting can only repeat the same failure.
  return code === 1008;
}

/**
 * Concordia への liveness WebSocket。active な WS が heartbeat 代替になる。
 * onMessage で eventBus broadcast (session.inject / question.answered 等) を受ける。
 * 予期しない切断は指数バックオフ (上限 30s) で再接続。
 */
export class LivenessHandle {
  private ws: WebSocket | null = null;
  private closed = false;
  private retryMs = 1000;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: ConcordiaConfig,
    private readonly sessionId: string,
    private readonly enrollment: string | null,
    private readonly onMessage?: (msg: unknown) => void,
  ) {
    this.connect();
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.closed) return;
    const wsUrl = buildLivenessUrl(this.cfg, this.sessionId, this.enrollment);
    try {
      // Node 22+ ships a global WebSocket.
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.retryMs = 1000;
      });
      ws.addEventListener("close", (event) => {
        this.ws = null;
        if (isTerminalLivenessClose(event.code)) {
          this.closed = true;
          try {
            process.stderr.write(
              "satelles: Concordia WebSocket authentication failed; reconnect disabled for this session.\n",
            );
          } catch {
            /* best-effort */
          }
          return;
        }
        if (!this.closed) this.scheduleReconnect();
      });
      ws.addEventListener("error", () => {
        // close も発火する — 再接続は close 側に任せる。
      });
      if (this.onMessage) {
        ws.addEventListener("message", (ev) => {
          if (!this.onMessage) return;
          try {
            const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
            this.onMessage(JSON.parse(raw));
          } catch {
            /* malformed messages are dropped */
          }
        });
      }
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    this.timer.unref?.();
  }
}
