/**
 * The academy's branding block, as a document needs it.
 *
 * It lives on its own because **two different moments** read it and they must agree: the
 * billing run copies it into an invoice's `snapshot` when the invoice is issued, and the PDF
 * service reads it back out of that same snapshot when the document is rendered. If each place
 * spelled out its own column list, an invoice could be snapshotted without the payment
 * instructions and nobody would notice until a guardian could not pay one.
 *
 * Nothing here is read at *render* time: FILES_AND_PDF §2 requires an invoice PDF to be built
 * from `invoices`, `invoice_items` and `snapshot` only, so that regenerating last year's
 * invoice cannot silently adopt this year's address (ADR-014).
 */
import type { PoolClient } from "pg";
import { config } from "../config.js";

/**
 * The academy's logo URL, as the API hands it to a client (SET-03's `logoUrl`, `Me.academy`).
 *
 * It names the API's own **public** logo read (PUB-02) rather than a bucket URL, because there
 * is no bucket (OPEN-016) and no public origin to build one from. Two things make it safe to
 * send anywhere: the route takes no parameter — it can only ever answer with the academy's own
 * logo, so there is no id to guess — and it is the one file this API serves without a session.
 *
 * It is derived from configuration rather than from the incoming request: a `Host` header is
 * caller-controlled, and a URL built from one would be a caller-controlled URL echoed back.
 */
export function academyLogoUrl(): string {
  return `${config.apiBaseUrl.replace(/\/+$/, "")}/api/v1/public/academy/logo`;
}

export interface AcademyBrand {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  paymentInstructions: string | null;
  logoFileId: string | null;
  currency: string;
}

interface BrandRow {
  name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  payment_instructions: string | null;
  logo_file_id: string | null;
  currency: string;
}

/**
 * Reads the single academy row. Must be called inside a transaction with the owner's identity
 * set: `academy_settings` carries FORCE ROW LEVEL SECURITY and only the owner policy can see
 * it, so a coach transaction would read nothing — which is why no caller on a coach path uses
 * this.
 */
export async function loadAcademyBrand(client: PoolClient): Promise<AcademyBrand> {
  const result = await client.query<BrandRow>(
    `select name, address, phone, email, payment_instructions, logo_file_id, currency
       from academy_settings
      where id = 1`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("academy_settings row 1 is missing");
  return {
    name: row.name,
    address: row.address,
    phone: row.phone,
    email: row.email,
    paymentInstructions: row.payment_instructions,
    logoFileId: row.logo_file_id,
    currency: row.currency.trim(),
  };
}
