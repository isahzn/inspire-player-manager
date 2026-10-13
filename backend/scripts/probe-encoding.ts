import { Client } from "pg";
import { config as loadEnv } from "dotenv";
import { clientConfig } from "./migrate.js";

loadEnv();

for (const label of ["default", "with client_encoding"]) {
  const cfg = clientConfig(process.env["DATABASE_MIGRATOR_URL"]!);
  const client = new Client(
    label === "default" ? { ...cfg, client_encoding: "" } : { ...cfg, client_encoding: "UTF8" },
  );
  await client.connect();
  const enc = await client.query<{ client_encoding: string; server_encoding: string }>(
    "select current_setting('client_encoding') as client_encoding, current_setting('server_encoding') as server_encoding",
  );
  console.log(label, JSON.stringify(enc.rows[0]));
  try {
    const r = await client.query("select 'arrow → and middot ·'::text as t");
    console.log(`  utf8 literal ok: ${(r.rows[0] as { t: string }).t}`);
  } catch (err) {
    console.log(`  utf8 literal FAILED: ${err instanceof Error ? err.message : err}`);
  }
  await client.end();
}
