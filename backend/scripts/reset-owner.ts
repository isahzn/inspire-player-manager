/**
 * `reset-owner` — lockout recovery for an owner (AUTH_AND_PERMISSIONS §1).
 *
 * Invite links are handed over out of band and there is no email service in v1, so an
 * owner who loses their password (or their authenticator, combined with a lost password)
 * is recovered by an operator running this on the server. It issues a fresh 72 h reset
 * link and revokes every existing session of that user.
 *
 * TOTP is deliberately left enabled: disabling a second factor is an owner decision made
 * from inside the app (AUTH-07 disable) or, if truly unrecoverable, by an operator
 * clearing it with a documented database action — never silently by this script.
 *
 *   npm run reset-owner -- --username owner [--disable-totp-confirm]
 */
import { config } from "../src/config.js";
import { generateOpaqueToken, inviteExpiry } from "../src/auth/tokens.js";
import { uuidv7 } from "../src/ids.js";
import { parseArgs, recordCliAudit, requireString, withCliTransaction } from "./lib/cli-db.js";
import { config as loadEnv } from "dotenv";

loadEnv();

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const username = requireString(args, "username").toLowerCase();
  const disableTotp = args["disable-totp-confirm"] === true;

  const token = generateOpaqueToken();
  const expiresAt = inviteExpiry();

  const result = await withCliTransaction(async (client) => {
    const user = await client.query<{ id: string; role: string; status: string; totp_enabled: boolean }>(
      "select id, role, status, totp_enabled from users where username = $1",
      [username],
    );
    const row = user.rows[0];
    if (!row) throw new Error(`no user with username "${username}"`);

    await client.query(
      `insert into user_invites (id, user_id, token_hash, purpose, expires_at)
       values ($1, $2, $3, 'password_reset', $4)`,
      [uuidv7(), row.id, token.hash, expiresAt],
    );
    const revoked = await client.query(
      `update user_sessions set revoked_at = now(), revoked_reason = 'cli_reset_owner'
        where user_id = $1 and revoked_at is null`,
      [row.id],
    );
    if (disableTotp && row.totp_enabled) {
      // Explicit, recorded, and only when the operator asks for it.
      await client.query(
        "update users set totp_enabled = false, totp_secret_enc = null, updated_at = now() where id = $1",
        [row.id],
      );
    }
    await recordCliAudit(client, {
      action: "user.reset_password",
      entityType: "user",
      entityId: row.id,
      after: {
        via: "reset-owner CLI",
        sessionsRevoked: revoked.rowCount ?? 0,
        totpDisabled: Boolean(disableTotp && row.totp_enabled),
      },
      reason: "owner lockout recovery",
    });
    return { role: row.role, sessionsRevoked: revoked.rowCount ?? 0, totpWasEnabled: row.totp_enabled };
  });

  console.log(`reset link issued for "${username}" (role: ${result.role})`);
  console.log(`  url      : ${config.appBaseUrl}/accept-invite?token=${token.token}`);
  console.log(`  expires  : ${expiresAt.toISOString()} (72 h, single use)`);
  console.log(`  sessions : ${result.sessionsRevoked} revoked`);
  if (result.totpWasEnabled && !disableTotp) {
    console.log("  note     : TOTP stays enabled — the owner still needs their authenticator.");
    console.log("             If it is unrecoverable, re-run with --disable-totp-confirm.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
