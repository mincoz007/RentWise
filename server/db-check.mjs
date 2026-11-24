import { readFile } from "node:fs/promises";
import pg from "pg";

try {
  for (const line of (await readFile(new URL("../.env", import.meta.url), "utf8")).split(/\r?\n/)) {
    const match = line.match(/^\s*DATABASE_URL\s*=\s*(.*?)\s*$/);
    if (match && !process.env.DATABASE_URL) process.env.DATABASE_URL = match[1].replace(/^['"]|['"]$/g, "");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing. Copy .env.example to .env and configure PostgreSQL first.");
  process.exitCode = 1;
} else {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query("SELECT current_database() AS database, current_user AS user, version() AS version");
    console.log(`Connected to PostgreSQL database '${result.rows[0].database}' as '${result.rows[0].user}'.`);
  } catch (error) {
    const details = error?.message || error?.code || error?.name || "unknown connection error";
    console.error(`PostgreSQL connection failed: ${details}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
