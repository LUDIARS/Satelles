import { z } from "zod";
import type { CodexRpcNotification } from "./codex-app-server-client.js";
import type { TranscriptFrameInput } from "./transcript-sink.js";

const ParamsSchema = z.object({
  threadId: z.string().optional(),
  turnId: z.string().optional(),
  turn: z.object({
    id: z.string(),
    status: z.string().optional(),
    error: z.unknown().optional(),
    // usage の形は app-server の実装差で揺れる (null / 別の入れ子)。ここで
    // 形を宣言すると、揺れが ParamsSchema 全体の parse 失敗になり、
    // turn/completed の検出まで巻き添えで死ぬ (turn が停滞扱いで終わる)。
    // 中身の取り出しは parseTurnUsage 側で個別に型を見る。
    usage: z.unknown().optional(),
  }).passthrough().optional(),
  usage: z.unknown().optional(),
  item: z.object({
    id: z.string(),
    type: z.string(),
  }).passthrough().optional(),
  error: z.object({
    message: z.string(),
    codexErrorInfo: z.unknown().optional(),
  }).passthrough().optional(),
}).passthrough();

export interface CodexMappedFrame extends TranscriptFrameInput {
  dedupKey: string;
}

export interface CodexTurnCompletion {
  threadId: string;
  turnId: string;
  status: string;
  errorMessage: string | null;
}

export function notificationThreadId(notification: CodexRpcNotification): string | null {
  const parsed = ParamsSchema.safeParse(notification.params);
  return parsed.success ? parsed.data.threadId ?? null : null;
}

/**
 * notification が属する turn id (`turnId` 直下、無ければ `turn.id`)。
 * 打ち切った turn の後追いイベントを識別するのに使う。
 */
export function notificationTurnId(notification: CodexRpcNotification): string | null {
  const parsed = ParamsSchema.safeParse(notification.params);
  if (!parsed.success) return null;
  return parsed.data.turnId ?? parsed.data.turn?.id ?? null;
}

/** Converts authoritative App Server completion events to allowlisted frames. */
export class CodexEventFrameMapper {
  private readonly seen = new Set<string>();

  constructor(private readonly expectedThreadId: string) {}

  map(notification: CodexRpcNotification): CodexMappedFrame | null {
    const parsed = ParamsSchema.safeParse(notification.params);
    if (!parsed.success) return null;
    const params = parsed.data;
    if (params.threadId !== this.expectedThreadId) return null;

    const mapped = mapNotification(notification.method, params);
    if (!mapped || this.seen.has(mapped.dedupKey)) return null;
    this.seen.add(mapped.dedupKey);
    return mapped;
  }
}

export interface CodexTurnUsage {
  threadId: string;
  turnId: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
}

type CodexTurnUsageTokenField = Exclude<keyof CodexTurnUsage, "threadId" | "turnId">;

/**
 * 出力キーと、それを供給しうる実測キー。実測の語彙は snake_case
 * (`input_tokens` / `cached_input_tokens` / …) だが、camelCase を返す実装差に
 * 当たっても落とさないよう両方見る。
 */
const USAGE_TOKEN_FIELDS: Array<readonly [CodexTurnUsageTokenField, string, string]> = [
  ["inputTokens", "input_tokens", "inputTokens"],
  ["cachedInputTokens", "cached_input_tokens", "cachedInputTokens"],
  ["cacheWriteInputTokens", "cache_write_input_tokens", "cacheWriteInputTokens"],
  ["outputTokens", "output_tokens", "outputTokens"],
  ["reasoningOutputTokens", "reasoning_output_tokens", "reasoningOutputTokens"],
  ["totalTokens", "total_tokens", "totalTokens"],
];

/** 有限な数値だけ採る。NaN / Infinity はコストの一次ソースとして無意味。 */
function pickTokenCount(source: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * turn/completed の usage を取り出す。
 *
 * Concordia のコスト集計は codex-cli を rollout JSONL の後追いで拾うが、
 * codex-sdk セッションは走査対象外 (rollout tail を持たないのが Satelles の
 * 存在意義)。そこで app-server が turn ごとに返す usage を一次ソースとして
 * transcript frame に載せ、Cc がそこから集計できるようにする。
 * usage が無い / 読めない turn は無害にスキップする (null)。欠けた項目は
 * 「取れなかった」として出さない (0 と区別する — 0 は「キャッシュが
 * 効かなかった」の実測値)。
 */
export function parseTurnUsage(
  notification: CodexRpcNotification,
  expectedThreadId: string,
): CodexTurnUsage | null {
  if (notification.method !== "turn/completed") return null;
  const parsed = ParamsSchema.safeParse(notification.params);
  if (!parsed.success || parsed.data.threadId !== expectedThreadId || !parsed.data.turn) return null;
  const raw = parsed.data.turn.usage ?? parsed.data.usage;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  const fields: CodexTurnUsage = {
    threadId: expectedThreadId,
    turnId: parsed.data.turn.id,
  };
  let found = 0;
  for (const [target, snakeKey, camelKey] of USAGE_TOKEN_FIELDS) {
    const value = pickTokenCount(usage, snakeKey, camelKey);
    if (value === undefined) continue;
    fields[target] = value;
    found++;
  }
  // トークンが 1 つも読めなければ、載せる中身が無い。
  return found > 0 ? fields : null;
}

export function parseTurnCompletion(
  notification: CodexRpcNotification,
  expectedThreadId: string,
): CodexTurnCompletion | null {
  if (notification.method !== "turn/completed") return null;
  const parsed = ParamsSchema.safeParse(notification.params);
  if (!parsed.success || parsed.data.threadId !== expectedThreadId || !parsed.data.turn) return null;
  const turn = parsed.data.turn;
  return {
    threadId: expectedThreadId,
    turnId: turn.id,
    status: turn.status ?? "unknown",
    errorMessage: extractErrorMessage(turn.error),
  };
}

function mapNotification(
  method: string,
  params: z.infer<typeof ParamsSchema>,
): CodexMappedFrame | null {
  if ((method === "turn/started" || method === "turn/completed") && params.turn) {
    return {
      dedupKey: `${params.threadId}:${params.turn.id}:${method}`,
      kind: "raw",
      payload: {
        type: method === "turn/started" ? "codex_turn_started" : "codex_turn_completed",
        thread_id: params.threadId,
        turn_id: params.turn.id,
        status: params.turn.status ?? null,
        error: extractErrorMessage(params.turn.error),
      },
    };
  }
  if (method === "error" && params.error) {
    return {
      dedupKey: `${params.threadId}:${params.turnId ?? "none"}:error:${params.error.message}`,
      kind: "raw",
      payload: {
        type: "codex_error",
        thread_id: params.threadId,
        turn_id: params.turnId ?? null,
        message: params.error.message.slice(0, 2_000),
        code: safeErrorCode(params.error.codexErrorInfo),
      },
    };
  }
  if (method !== "item/completed" || !params.item) return null;

  const item = params.item;
  const baseKey = `${params.threadId}:${params.turnId ?? "none"}:${item.id}:completed`;
  switch (item.type) {
    case "userMessage": {
      const text = extractUserMessageText(item.content);
      if (!text) return null;
      return {
        dedupKey: baseKey,
        kind: "text",
        payload: { role: "user", text, item_id: item.id, turn_id: params.turnId ?? null },
      };
    }
    case "agentMessage": {
      if (typeof item.text !== "string" || !item.text.trim()) return null;
      return {
        dedupKey: baseKey,
        kind: "text",
        payload: {
          role: "assistant",
          text: item.text,
          phase: typeof item.phase === "string" ? item.phase : null,
          item_id: item.id,
          turn_id: params.turnId ?? null,
        },
      };
    }
    case "reasoning": {
      const summary = extractReasoningSummary(item);
      if (!summary) return null;
      return {
        dedupKey: baseKey,
        kind: "thinking",
        payload: { text: summary, item_id: item.id, turn_id: params.turnId ?? null },
      };
    }
    case "commandExecution":
      return {
        dedupKey: baseKey,
        kind: "tool",
        payload: {
          type: "command_execution",
          item_id: item.id,
          turn_id: params.turnId ?? null,
          command: typeof item.command === "string" ? item.command : null,
          cwd: typeof item.cwd === "string" ? item.cwd : null,
          status: typeof item.status === "string" ? item.status : null,
          exit_code: typeof item.exitCode === "number" ? item.exitCode : null,
          duration_ms: typeof item.durationMs === "number" ? item.durationMs : null,
        },
      };
    case "fileChange":
      return {
        dedupKey: baseKey,
        kind: "tool",
        payload: {
          type: "file_change",
          item_id: item.id,
          turn_id: params.turnId ?? null,
          status: typeof item.status === "string" ? item.status : null,
          changes: extractFileChanges(item.changes),
        },
      };
    case "mcpToolCall":
      return {
        dedupKey: baseKey,
        kind: "tool",
        payload: {
          type: "mcp_tool_call",
          item_id: item.id,
          turn_id: params.turnId ?? null,
          server: typeof item.server === "string" ? item.server : null,
          tool: typeof item.tool === "string" ? item.tool : null,
          status: typeof item.status === "string" ? item.status : null,
          error: extractErrorMessage(item.error),
        },
      };
    default:
      return {
        dedupKey: baseKey,
        kind: "raw",
        payload: {
          type: "codex_item_completed",
          item_type: item.type,
          item_id: item.id,
          turn_id: params.turnId ?? null,
          keys: Object.keys(item).filter(isSafeUnknownKey).sort(),
        },
      };
  }
}

function extractUserMessageText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const entry of content) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string" && value.text.trim()) {
      texts.push(value.text);
    }
  }
  return texts.length > 0 ? texts.join("\n") : null;
}

function extractReasoningSummary(item: Record<string, unknown>): string | null {
  const candidates = [item.summary, item.text];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (Array.isArray(candidate)) {
      const text = candidate.filter((value): value is string => typeof value === "string").join("\n");
      if (text.trim()) return text;
    }
  }
  return null;
}

function extractFileChanges(changes: unknown): Array<{ path: string; kind: string | null }> {
  if (!Array.isArray(changes)) return [];
  const safe: Array<{ path: string; kind: string | null }> = [];
  for (const change of changes) {
    if (!change || typeof change !== "object") continue;
    const value = change as Record<string, unknown>;
    if (typeof value.path !== "string") continue;
    safe.push({ path: value.path, kind: typeof value.kind === "string" ? value.kind : null });
  }
  return safe;
}

function extractErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message.slice(0, 2_000) : null;
}

function safeErrorCode(info: unknown): string | null {
  if (typeof info === "string") return info;
  if (!info || typeof info !== "object") return null;
  const keys = Object.keys(info as Record<string, unknown>);
  return keys.length === 1 ? keys[0] ?? null : null;
}

function isSafeUnknownKey(key: string): boolean {
  return !/(?:token|authorization|secret|password|argument|content|output|diff)/iu.test(key);
}
