/** @implements spec/plan/session-sidecar.md — runtime switch reply shape (C-1) */
export default {
  post(result: unknown): true | string {
    const reply = result as { status?: unknown; body?: Record<string, unknown> };
    if (reply?.status === 200) return reply.body?.ok === true && typeof reply.body.message === "string" ? true : "200 without {ok:true, message}";
    if (reply?.status === 400) return typeof reply.body?.error === "string" ? true : "400 without {error}";
    return `unexpected status ${String(reply?.status)}`;
  },
};
