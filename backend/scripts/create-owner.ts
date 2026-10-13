/**
 * `create-owner` — the only way the first owner exists (DEPLOYMENT_AND_OPERATIONS §9.2).
 *
 * No default credentials exist anywhere: this prints a **one-time** invite URL (72 h,
 * single use) which the operator hands to the owner out of band. The owner sets their own
 * password and then enrolls TOTP.
 *
 *   npm run create-owner -- --username owner --full-name "Academy Owner" [--phone 0771234567]
 */
import { config } from "../src/config.js";
import { inviteExpiry, generateOpaqueToken, normalizePhone } from "../src/auth/tokens.js";
import { uuidv7 } from "../src/ids.js";
import { parseArgs, recordCliAudit, requireString, withCliTransaction } from "./lib/cli-db.js";
import { config as loadEnv } from "dotenv";

loadEnv();

const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = requireString(args, "username").toLowerCase();
  const fullName = typeof args["full-name"] === "string" ? args["full-name"].trim() : "Academy Owner";
  const phoneInput = typeof args["phone"] === "string" ? args["phone"] : undefined;

  if (!USERNAME_PATTERN.test(username)) {
    throw new Error(
      "--username must be 3-32 characters of a-z, 0-9, dot, underscore or hyphen (ADR-018)",
    );
  }
  let phone: string | null = null;
  if (phoneInput) {
    try {
      phone = normalizePhone(phoneInput);
    } catch {
      throw new Error("--phone is not a valid phone number");
    }
  }

  const token = generateOpaqueToken();
  const expiresAt = inviteExpiry();
  const userId = uuidv7();

  const existing = await withCliTransaction(async (client) =>
    client.query<{ id: string }>("select id from users where username = $1", [username]),
  );
  if (existing.rows.length > 0) {
    throw new Error(
      `username "${username}" already exists. Usernames are immutable; use "${username}2" or run reset-owner.`,
    );
  }

  await withCliTransaction(async (client) => {
    await client.query(
      `insert into users (id, username, full_name, phone_e164, role, status)
       values ($1, $2, $3, $4, 'owner', 'invited')`,
      [userId, username, fullName, phone],
    );
    await client.query(
      `insert into user_invites (id, user_id, token_hash, purpose, expires_at)
       values ($1, $2, $3, 'invite', $4)`,
      [uuidv7(), userId, token.hash, expiresAt],
    );
    await recordCliAudit(client, {
      action: "user.create",
      entityType: "user",
      entityId: userId,
      after: { username, role: "owner", status: "invited" },
      reason: "create-owner CLI",
    });
  });

  console.log("owner created (status: invited — set a password via the link below)");
  console.log(`  username : ${username}`);
  console.log(`  invite   : ${config.appBaseUrl}/accept-invite?token=${token.token}`);
  console.log(`  expires  : ${expiresAt.toISOString()} (72 h, single use — shown only once)`);
  console.log("next: owner sets a password, then enrolls TOTP from the profile screen");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
