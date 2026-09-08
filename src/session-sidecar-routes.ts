/** Lictor-compatible requests bound to one registered Satelles session. */
import { z } from "zod";
import type { ConcordiaClient } from "./concordia-client.js";

const chatSchema = z.object({
  channel: z.enum(["chitchat", "consultation", "報告", "ぼやき", "system", "genius"]),
  text: z.string().min(1).max(2000),
  scope: z.enum(["world", "local"]).optional(),
  in_reply_to: z.number().int().positive().optional(),
  attachment_paths: z.array(z.string().min(1).max(500)).max(10).optional(),
});
const reportSchema = z.object({ monologue: z.string().min(1).max(32_000) });
const filesSchema = z.object({
  files: z.array(z.string().min(1).max(500)).min(1).max(10),
  caption: z.string().min(1).max(2000).optional(),
});
const taskSchema = z.object({ branch: z.string().max(500).optional(), desc: z.string().max(4000).optional() })
  .refine((value) => value.branch !== undefined || value.desc !== undefined);

export interface SidecarReply { status: number; body: unknown; afterResponse?: () => void }
export interface SessionSidecarRoutesOptions {
  sessionId: string;
  concordia: Pick<ConcordiaClient, "chat" | "report" | "patchSession">;
  requestShutdown: () => void;
}

export class SessionSidecarRoutes {
  private task: { branch: string | null; desc: string | null } = { branch: null, desc: null };

  constructor(private readonly options: SessionSidecarRoutesOptions) {}

  async handle(method: string, path: string, body: unknown): Promise<SidecarReply> {
    const { sessionId, concordia } = this.options;
    if (method === "GET" && path === "/v1/health") {
      return { status: 200, body: { ok: true, runtime: "satelles" } };
    }
    if (method === "GET" && path === "/v1/concordia/session") {
      return { status: 200, body: { session_id: sessionId, concordia_enabled: true, runtime: "satelles" } };
    }
    if (method === "GET" && path === "/v1/lictor/task") {
      return { status: 200, body: { ok: true, task: this.task } };
    }
    if (method === "POST" && path === "/v1/shutdown") {
      return { status: 200, body: { ok: true, shutdown_requested: true }, afterResponse: this.options.requestShutdown };
    }
    if (method === "POST" && path === "/v1/chat") {
      const parsed = chatSchema.safeParse(body);
      if (!parsed.success) return invalidBody();
      return { status: 200, body: await concordia.chat(sessionId, parsed.data) };
    }
    if (method === "POST" && path === "/v1/report") {
      const parsed = reportSchema.safeParse(body);
      if (!parsed.success) return invalidBody();
      return { status: 200, body: await concordia.report(sessionId, parsed.data.monologue) };
    }
    if (method === "POST" && path === "/v1/internal/send-file") {
      const parsed = filesSchema.safeParse(body);
      if (!parsed.success) return invalidBody();
      // Cc applies its canonical attachment path guard and resolves the session's destination.
      return { status: 200, body: await concordia.chat(sessionId, {
        channel: "system", text: parsed.data.caption ?? "添付資料", attachment_paths: parsed.data.files,
      }) };
    }
    if (method === "POST" && path === "/v1/lictor/task") {
      const parsed = taskSchema.safeParse(body);
      if (!parsed.success) return invalidBody();
      const { branch, desc } = parsed.data;
      await concordia.patchSession(sessionId, {
        ...(branch !== undefined ? { branch } : {}),
        ...(desc !== undefined ? { current_task: desc } : {}),
      });
      this.task = { branch: branch ?? this.task.branch, desc: desc ?? this.task.desc };
      return { status: 200, body: { ok: true, task: this.task } };
    }
    return { status: 404, body: { error: "unsupported Satelles sidecar route" } };
  }
}

function invalidBody(): SidecarReply {
  return { status: 400, body: { error: "invalid request body" } };
}
