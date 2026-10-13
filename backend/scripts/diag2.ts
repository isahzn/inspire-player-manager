/** Throwaway diagnostic: database ACLs and per-role connectivity. */
import { Client } from "pg";

const superCfg = {
  host: "localhost",
  port: 55432,
  user: "postgres",
  password: "ia_postgres_dev_password",
  client_encoding: "UTF8",
};

const admin = new Client({ ...superCfg, database: "postgres" });
await admin.connect();
const acl = await admin.query(
  "select datname, datacl, pg_get_userbyid(datdba) as owner from pg_database where datname in ('ia_dev','ia_test')",
);
console.log(JSON.stringify(acl.rows, null, 1));
const roles = await admin.query("select rolname, rolcanlogin, rolvaliduntil from pg_roles where rolname like 'ia\\_%'");
console.log("roles:", roles.rows);
await admin.end();

for (const [role, password] of [
  ["ia_migrator", "ia_migrator_dev_password"],
  ["ia_app", "ia_app_dev_password"],
] as const) {
  const c = new Client({ ...superCfg, user: role, password, database: "ia_dev" });
  try {
    await c.connect();
    const r = await c.query("select current_user, current_database() as db");
    console.log(`connect ${role}: ok`, r.rows[0]);
    await c.end();
  } catch (err) {
    console.log(`connect ${role}: FAILED — ${err instanceof Error ? err.message : err}`);
  }
}
