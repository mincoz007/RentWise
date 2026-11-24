import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { closeDatabase, database } from "./database.ts";
import { rentwiseApiHandler } from "./auth.ts";

const host = process.env.HOST?.trim() || "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const webRoot = resolve(process.cwd(), "dist");
const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function log(level: "info" | "error", event: string, fields: Record<string, unknown> = {}) {
  const write = level === "error" ? console.error : console.info;
  write(JSON.stringify({ timestamp: new Date().toISOString(), level, service: "api", event, ...fields }));
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

async function serveWeb(request: IncomingMessage, response: ServerResponse) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    json(response, 405, { error: "Method not allowed." });
    return;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://rentwise.local").pathname);
  } catch {
    json(response, 400, { error: "Invalid URL path." });
    return;
  }

  const candidate = resolve(webRoot, `.${pathname}`);
  if (candidate !== webRoot && !candidate.startsWith(`${webRoot}${sep}`)) {
    json(response, 403, { error: "Forbidden." });
    return;
  }

  let filePath = candidate;
  let fileInfo;
  try {
    fileInfo = await stat(filePath);
    if (fileInfo.isDirectory()) {
      filePath = resolve(filePath, "index.html");
      fileInfo = await stat(filePath);
    }
  } catch {
    if (extname(pathname) || pathname.startsWith("/assets/")) {
      json(response, 404, { error: "File not found." });
      return;
    }
    filePath = resolve(webRoot, "index.html");
    try { fileInfo = await stat(filePath); }
    catch {
      json(response, 503, { error: "Production web assets are missing. Run npm run build first." });
      return;
    }
  }

  if (!fileInfo.isFile()) {
    json(response, 404, { error: "File not found." });
    return;
  }

  const body = request.method === "HEAD" ? undefined : await readFile(filePath);
  const isHashedAsset = pathname.startsWith("/assets/");
  response.writeHead(200, {
    "Cache-Control": isHashedAsset ? "public, max-age=31536000, immutable" : "no-cache",
    "Content-Length": fileInfo.size,
    "Content-Type": mimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

async function main() {
  process.env.NODE_ENV ??= "production";
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to start the RentWise API.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port.");

  const server = createServer((request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    const startedAt = performance.now();
    const pathname = new URL(request.url ?? "/", "http://rentwise.local").pathname;
    response.once("finish", () => log("info", "request_complete", {
      method: request.method ?? "?",
      path: pathname,
      status: response.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
    }));

    if (pathname === "/health/live" && request.method === "GET") {
      json(response, 200, { status: "ok" });
      return;
    }
    if (pathname === "/health/ready" && request.method === "GET") {
      void database().query("SELECT 1").then(
        () => json(response, 200, { status: "ready" }),
        () => json(response, 503, { status: "not_ready", dependency: "database" }),
      );
      return;
    }
    if (rentwiseApiHandler(request, response)) return;
    void serveWeb(request, response).catch((error: unknown) => {
      log("error", "static_request_failed", { path: pathname, message: error instanceof Error ? error.message : "Unknown file server error." });
      if (!response.headersSent) json(response, 500, { error: "Could not serve the requested page." });
      else response.end();
    });
  });

  server.requestTimeout = 60_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 5_000;
  server.on("clientError", (error, socket) => {
    log("error", "client_protocol_error", { message: error.message });
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  log("info", "server_started", { host, port, nodeEnv: process.env.NODE_ENV ?? "production" });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "server_stopping", { signal });
    server.close((error) => {
      if (error) log("error", "server_close_failed", { message: error.message });
      void closeDatabase().finally(() => process.exit(error ? 1 : 0));
    });
    server.closeIdleConnections?.();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch(async (error: unknown) => {
  log("error", "server_start_failed", { message: error instanceof Error ? error.message : "Unknown startup error." });
  await closeDatabase().catch(() => undefined);
  process.exitCode = 1;
});
