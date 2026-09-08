/** Ephemeral loopback HTTP transport; owned and closed by one runner. */
import { createServer, type IncomingMessage } from "node:http";
import { SessionSidecarRoutes, type SessionSidecarRoutesOptions } from "./session-sidecar-routes.js";

const MAX_BODY_BYTES = 64 * 1024;
export interface SessionSidecar {
  port: number;
  close(): Promise<void>;
}

export async function startSessionSidecar(options: SessionSidecarRoutesOptions): Promise<SessionSidecar> {
  const routes = new SessionSidecarRoutes(options);
  const server = createServer((req, res) => {
    const respond = (status: number, body: unknown): void => {
      // 応答済み / 切断済みの socket へ二重に書くと ERR_STREAM_WRITE_AFTER_END が
      // 上がり、runner ごと落ちる (この listener は runner と同一プロセス)。
      if (res.headersSent || res.writableEnded) return;
      res.writeHead(status, { "content-type": "application/json; charset=utf-8", connection: "close" });
      res.end(JSON.stringify(body));
    };
    // CLI callers send no Origin. Reject browser requests and DNS rebinding.
    const address = server.address();
    const host = address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
    if (req.headers.origin !== undefined || req.headers.host !== host) {
      respond(403, { error: "loopback CLI requests only" });
      return;
    }
    void (async () => {
      try {
        const body = await readBody(req);
        const reply = await routes.handle(req.method ?? "GET", req.url ?? "/", body);
        if (reply.afterResponse) res.once("finish", reply.afterResponse);
        respond(reply.status, reply.body);
      } catch (error) {
        if (error instanceof InvalidRequest) respond(error.status, { error: error.message });
        // Do not leak coordinator response contents, paths or credentials.
        else respond(502, { error: "Concordia request failed" });
      }
    })();
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      // bind 後の socket エラーには listener が残らない。'error' は
      // EventEmitter の既定で throw されるため、無視しないと runner ごと落ちる。
      server.on("error", () => { /* transport-level noise; the session must survive */ });
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Satelles sidecar did not bind a TCP port");
  }
  let closing: Promise<void> | undefined;
  return {
    port: address.port,
    // 後始末は best-effort。ここで reject すると runner の finally が
    // 元の例外を握り潰し、失敗の原因が listener の close エラーにすり替わる。
    close: () => closing ??= new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

class InvalidRequest extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw new InvalidRequest(413, "request body too large");
    chunks.push(bytes);
  }
  if (size === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new InvalidRequest(400, "invalid JSON body"); }
}
