/** Throwaway diagnostic: cluster encoding, databases, roles. */
import { Client } from "pg";

const c = new Client({
  host: "localhost",
  port: 55432,
  user: "postgres",
  password: "ia_postgres_dev_password",
  database: "postgres",
  client_encoding: "UTF8",
});
await c.connect();
const d = await c.query(
  "select datname, pg_encoding_to_char(encoding) as enc from pg_database order by datname",
);
console.log("databases:", d.rows);
const r = await c.query("select rolname, rolbypassrls from pg_roles where rolname like 'ia\\_%'");
console.log("roles:", r.rows);
const e = await c.query("select current_setting('server_encoding') as enc");
console.log("server encoding:", e.rows);
await c.end();
