import { closeDatabase, database } from "./database.ts";
import { startRentWiseBackgroundJobs } from "./auth.ts";

function log(level: "info" | "error", event: string, fields: Record<string, unknown> = {}) {
  const write = level === "error" ? console.error : console.info;
  write(JSON.stringify({ timestamp: new Date().toISOString(), level, service: "worker", event, ...fields }));
}

async function main() {
  process.env.NODE_ENV ??= "production";
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to start the RentWise worker.");
  await database().query("SELECT 1");
  const stopJobs = startRentWiseBackgroundJobs(true);
  log("info", "worker_started", { intervalSeconds: 60 });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log("info", "worker_stopping", { signal });
    stopJobs();
    void closeDatabase().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch(async (error: unknown) => {
  log("error", "worker_start_failed", { message: error instanceof Error ? error.message : "Unknown startup error." });
  await closeDatabase().catch(() => undefined);
  process.exitCode = 1;
});
