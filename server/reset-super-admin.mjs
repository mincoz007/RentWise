import { randomBytes, scryptSync } from "node:crypto";
import pg from "pg";

function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const output = process.stdout;
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      reject(new Error("Run this command in an interactive PowerShell terminal."));
      return;
    }

    const wasRaw = input.isRaw;
    let value = "";
    output.write(prompt);
    input.setRawMode(true);
    input.resume();

    const finish = (error) => {
      input.removeListener("data", onData);
      input.setRawMode(wasRaw ?? false);
      output.write("\n");
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          finish(new Error("Password reset cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " " && character !== "\u007f") {
          value += character;
        }
      }
    };

    input.on("data", onData);
  });
}

const email = "enofe4king@gmail.com";
const password = await readHidden("Enter a new RentWise Super Admin password (12+ characters): ");
if (password.length < 12 || password.length > 200) {
  throw new Error("Use a password between 12 and 200 characters.");
}
const confirmation = await readHidden("Enter it again to confirm: ");
if (password !== confirmation) throw new Error("The passwords do not match; no change was made.");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const result = await client.query(
    "SELECT account FROM rentwise_users WHERE lower(email) = $1 AND role = 'super_admin' FOR UPDATE",
    [email],
  );
  const account = result.rows[0]?.account;
  if (!account || account.active !== true) {
    throw new Error("The active Super Admin account was not found; no change was made.");
  }

  const updated = {
    ...account,
    salt: randomBytes(16).toString("hex"),
    passwordHash: "",
  };
  updated.passwordHash = scryptSync(password, updated.salt, 64).toString("hex");
  await client.query(
    "UPDATE rentwise_users SET account = $1::jsonb, updated_at = now() WHERE lower(email) = $2 AND role = 'super_admin'",
    [JSON.stringify(updated), email],
  );
  await client.query("COMMIT");
  console.log("Super Admin password updated. Reload RentWise and sign in with the new password.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
