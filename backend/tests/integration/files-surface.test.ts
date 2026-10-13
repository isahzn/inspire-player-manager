/**
 * M6 — the file surface, driven through the real HTTP stack: the logo (SET-03, PUB-02), payment
 * proofs (PRF-01/02) and the guardian's capability link (PUB-01).
 *
 * What makes this file worth its runtime is that no claim here rests on a status code alone:
 *
 *  - "the logo is stored" means the **bytes at rest** were read back from the storage key the
 *    `files` row names, and the `audit_logs` row exists;
 *  - "the photo's metadata is gone" means the bytes in storage no longer contain the EXIF
 *    payload that was uploaded — not that the request was accepted;
 *  - "a proof never changes a payment" means the payment and its receipt list were read before
 *    and after the upload and are identical;
 *  - "the link is short-lived" means a tampered signature, an edited expiry and an expired token
 *    are each refused, and the URL that *was* issued serves the same bytes the owner uploaded;
 *  - "every failure answers the same 404" means the bodies are compared, not just the codes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { crc32, deflateSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { createUser, errorCode, login, request } from "../helpers/auth.js";
import {
  closeTestPool,
  migratorClient,
  prepareTestDatabase,
  resetData,
  testApp,
} from "../helpers/test-db.js";
import { readStoredFile } from "../../src/files/storage.js";

const OWNER_IP = "198.51.100.221";
const COACH_IP = "198.51.100.222";
/** Its own address: the rate-limit test must not spend anyone else's budget (API_CONTRACTS §1). */
const RATE_LIMIT_IP = "198.51.100.240";

const AMOUNT = 400_000;
/** A past instant: PAY-02 refuses a receipt time in the future. */
const RECEIVED_AT = "2026-10-05T04:05:00.000Z";

// ---------------------------------------------------------------------------
// Fixtures — real containers, built here so an assertion can name the bytes
// ---------------------------------------------------------------------------

/**
 * A PNG with a text chunk. The CRC is a placeholder because nothing in this codebase decodes the
 * image: the assertions below are about which chunks survive, which is what the code decides.
 */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
}

function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.alloc(13, 1)),
    pngChunk("IDAT", Buffer.from([0x78, 0x9c, 0x01, 0x02])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A chunk with a real CRC32, for the one fixture a decoder actually has to read. */
function crcChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength, 0);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed) >>> 0, 0);
  return Buffer.concat([length, typed, crc]);
}

/**
 * A genuinely valid 2×2 PNG.
 *
 * The other fixtures here only have to survive the stripper, which reads structure and never
 * pixels. This one is different: it is embedded in a PDF by PDFKit, so it has to decode — the
 * IHDR, the deflated scanlines and the CRC32s are all real.
 */
function validPng(): Buffer {
  const width = 2;
  const height = 2;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * (1 + width * 3) + 1 + x * 3;
      raw[at] = 0x20;
      raw[at + 1] = 0x80;
      raw[at + 2] = 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    crcChunk("IHDR", ihdr),
    crcChunk("IDAT", deflateSync(raw)),
    crcChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A PNG padded past 1 MB, to prove the logo's own limit is the one that answers. */
function oversizedPng(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.alloc(13, 1)),
    pngChunk("IDAT", Buffer.alloc(1024 * 1024, 7)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpegSegment(marker: number, data: Buffer): Buffer {
  const length = data.byteLength + 2;
  return Buffer.concat([Buffer.from([0xff, marker, (length >> 8) & 0xff, length & 0xff]), data]);
}

const GPS_PAYLOAD = "GPSLAT=6.9271;GPSLON=79.8612";

/** A photo that still carries EXIF and a payload appended after the end-of-image marker. */
function jpegWithExif(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from("JFIF\0\u0001\u0002", "latin1")),
    jpegSegment(
      0xe1,
      Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from(GPS_PAYLOAD, "latin1")]),
    ),
    jpegSegment(0xfe, Buffer.from("shot at home", "latin1")),
    Buffer.concat([
      Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]),
      Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0x78]),
      Buffer.from([0xff, 0xd9]),
    ]),
    Buffer.from("PK\u0003\u0004appended payload", "latin1"),
  ]);
}

/** A PDF that runs something when opened — the shape PRF-01 must refuse (FILES_AND_PDF §6). */
function pdfWithActiveContent(): Buffer {
  return Buffer.from(
    "%PDF-1.4\n1 0 obj << /Type /Catalog /OpenAction 5 0 R >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
    "latin1",
  );
}

function plainPdf(label: string): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Catalog /Label (${label}) >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
}

/** A multipart body, so the request a browser would send is the request under test. */
function multipartBody(
  parts: { name: string; filename?: string; contentType?: string; data: Buffer }[],
): { payload: Buffer; contentType: string } {
  const boundary = "----iaTestBoundary7c1d4e9a";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? "application/octet-stream"}\r\n\r\n`
      : `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`;
    chunks.push(
      Buffer.from(`--${boundary}\r\n${disposition}`, "utf8"),
      part.data,
      Buffer.from("\r\n", "utf8"),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("M6 file surface (SET-03, PRF-01/02, PUB-01/02)", () => {
  let app: FastifyInstance;
  let ownerCookie: string;
  let ownerCsrf: string;
  let coachCookie: string;
  let coachCsrf: string;
  let keySeq = 0;

  function nextKey(prefix: string): string {
    keySeq += 1;
    return `${prefix}-${keySeq}-7c1d4e`;
  }

  /**
   * Puts the shared reference data back the way it was found.
   *
   * `resetData` deliberately keeps `academy_settings` (it is reference configuration, not test
   * data), so the logo a test uploads would otherwise still be set for the next test — and for
   * the next test *file*, which runs in the same database.
   */
  async function clearLogo(): Promise<void> {
    const client = await migratorClient();
    try {
      await client.query(`update academy_settings set logo_file_id = null where id = 1`);
      await client.query(`delete from files where kind = 'logo'`);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await prepareTestDatabase();
  });

  beforeEach(async () => {
    await resetData();
    await clearLogo();
    await createUser({ username: "files.owner", role: "owner" });
    const owner = await createUser({ username: "files.owner2", role: "owner" });
    const coach = await createUser({ username: "files.coach", role: "coach" });

    app = await testApp();
    const ownerSession = await login(app, owner.username, owner.password, OWNER_IP);
    ownerCookie = ownerSession.cookie;
    ownerCsrf = ownerSession.csrfToken;
    const coachSession = await login(app, coach.username, coach.password, COACH_IP);
    coachCookie = coachSession.cookie;
    coachCsrf = coachSession.csrfToken;
  });

  afterAll(async () => {
    // The reference row is shared with every other test file, so it is left as it was found.
    await clearLogo();
    await app.close();
    await closeTestPool();
  });

  // --- fixtures and direct reads -------------------------------------------

  /**
   * A group, a player with a guardian, and a manual invoice that has its PDF generated.
   *
   * `label` distinguishes the fixtures inside one test: a group name and a guardian phone are
   * both unique, so a second fixture in the same test needs its own.
   */
  async function invoiceFixture(
    label = "U12",
  ): Promise<{
    invoiceId: string;
    invoiceNumber: string;
    playerId: string;
    guardianId: string;
  }> {
    // Two fixtures in one test must differ in every field the database considers an identity:
    // the group name, the guardian's phone, and the player's name + date of birth.
    const digits = label.replace(/\D/g, "").slice(-2).padStart(2, "0");

    const group = await request(app, {
      method: "POST",
      url: "/api/v1/age-groups",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: { name: label },
    });
    expect(group.statusCode, group.body).toBe(201);
    const groupId = (group.json() as { id: string }).id;

    const player = await request(app, {
      method: "POST",
      url: "/api/v1/players",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      payload: {
        fullName: `Nimal Perera ${label}`,
        dateOfBirth: `2014-07-${digits}`,
        registrationDate: "2026-09-01",
        ageGroupId: groupId,
        guardians: [
          {
            fullName: `Sunil Perera ${label}`,
            phone: `077123${digits}01`,
            isPrimary: true,
            receivesInvoices: true,
          },
        ],
      },
    });
    expect(player.statusCode, player.body).toBe(201);
    const playerBody = player.json() as { id: string; guardians: { guardian: { id: string } }[] };

    const created = await request(app, {
      method: "POST",
      url: "/api/v1/invoices",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("inv") },
      payload: {
        playerId: playerBody.id,
        description: "Equipment deposit",
        amountMinor: AMOUNT,
        dueDate: "2026-11-08",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const invoice = created.json() as { id: string; invoiceNumber: string };

    // PUB-01 can only serve a document that exists, so the PDF is built here (INV-07).
    const regenerated = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${invoice.id}/pdf/regenerate`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
    });
    expect(regenerated.statusCode, regenerated.body).toBe(202);

    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      playerId: playerBody.id,
      guardianId: playerBody.guardians[0]!.guardian.id,
    };
  }

  /** A payment in the state PRF-01 uploads against. */
  async function paymentFixture(opts: {
    methodCode: string;
    guardianId: string;
  }): Promise<{ paymentId: string; reference: string }> {
    const reference = `SLIP-${Math.floor(Math.random() * 1_000_000)}`;
    const created = await request(app, {
      method: "POST",
      url: "/api/v1/payments",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("pay") },
      payload: {
        amountMinor: AMOUNT,
        methodCode: opts.methodCode,
        reference,
        receivedAt: RECEIVED_AT,
        payerGuardianId: opts.guardianId,
        status: "pending",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    return { paymentId: (created.json() as { id: string }).id, reference };
  }

  async function uploadProof(
    paymentId: string,
    opts: { data: Buffer; filename: string; type: string; note?: string },
    session: { cookie: string; csrf: string } = { cookie: ownerCookie, csrf: ownerCsrf },
  ) {
    const parts: { name: string; filename?: string; contentType?: string; data: Buffer }[] = [
      { name: "file", filename: opts.filename, contentType: opts.type, data: opts.data },
    ];
    if (opts.note !== undefined) parts.push({ name: "note", data: Buffer.from(opts.note, "utf8") });
    const body = multipartBody(parts);
    return request(app, {
      method: "POST",
      url: `/api/v1/payments/${paymentId}/proofs`,
      cookie: session.cookie,
      csrf: session.csrf,
      headers: { "content-type": body.contentType },
      payload: body.payload,
    });
  }

  /** The bytes actually stored for a proof, straight out of the storage adapter. */
  async function storedProofBytes(proofId: string): Promise<Buffer | null> {
    const client = await migratorClient();
    try {
      const result = await client.query<{ storage_key: string }>(
        `select f.storage_key
           from payment_proofs pp join files f on f.id = pp.file_id
          where pp.id = $1`,
        [proofId],
      );
      const key = result.rows[0]?.storage_key;
      if (!key) return null;
      const bytes = await readStoredFile(key);
      return bytes ? Buffer.from(bytes) : null;
    } finally {
      await client.end();
    }
  }

  async function auditActions(entityId: string): Promise<string[]> {
    const client = await migratorClient();
    try {
      const result = await client.query<{ action: string }>(
        `select action from audit_logs where entity_id = $1 order by occurred_at asc`,
        [entityId],
      );
      return result.rows.map((row) => row.action);
    } finally {
      await client.end();
    }
  }

  /** Mints a capability link the way M7's send path will: raw token out, hash in the database. */
  async function issueToken(
    invoiceId: string,
    opts: { expiresAt?: Date; revokedAt?: Date; guardianId?: string | null } = {},
  ): Promise<{ token: string; id: string }> {
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const id = randomUUID();
    const client = await migratorClient();
    try {
      await client.query(
        `insert into invoice_access_tokens
           (id, invoice_id, guardian_id, token_hash, expires_at, revoked_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          id,
          invoiceId,
          opts.guardianId ?? null,
          tokenHash,
          opts.expiresAt ?? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          opts.revokedAt ?? null,
        ],
      );
    } finally {
      await client.end();
    }
    return { token, id };
  }

  async function tokenUse(id: string): Promise<{ use_count: number; revoked_at: Date | null }> {
    const client = await migratorClient();
    try {
      const result = await client.query<{ use_count: number; revoked_at: Date | null }>(
        `select use_count, revoked_at from invoice_access_tokens where id = $1`,
        [id],
      );
      return result.rows[0]!;
    } finally {
      await client.end();
    }
  }

  // -------------------------------------------------------------------------
  // SET-03 / PUB-02 — the logo
  // -------------------------------------------------------------------------
  it("stores the logo, points /auth/me at it, and serves it with no session (SET-03, PUB-02)", async () => {
    const body = multipartBody([
      { name: "file", filename: "logo.png", contentType: "image/png", data: pngBytes() },
    ]);

    const uploaded = await request(app, {
      method: "POST",
      url: "/api/v1/settings/logo",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "content-type": body.contentType },
      payload: body.payload,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);
    const { logoUrl } = uploaded.json() as { logoUrl: string };
    expect(logoUrl).toContain("/api/v1/public/academy/logo");

    // `/auth/me` is where the contract says the URL becomes visible to a client.
    const me = await request(app, { method: "GET", url: "/api/v1/auth/me", cookie: ownerCookie });
    expect(me.statusCode, me.body).toBe(200);
    expect((me.json() as { academy: { logoUrl?: string } }).academy.logoUrl).toBe(logoUrl);

    // The uploaded bytes are at rest, and the audit row names the new file.
    const client = await migratorClient();
    const rows = await client.query<{ id: string; storage_key: string }>(
      `select id, storage_key from files where kind = 'logo'`,
    );
    await client.end();
    expect(rows.rowCount).toBe(1);
    const stored = await readStoredFile(rows.rows[0]!.storage_key);
    expect(stored).not.toBeNull();
    expect(Buffer.from(stored!).equals(pngBytes())).toBe(true);
    expect(await auditActions(rows.rows[0]!.id)).toContain("settings.logo.upload");

    // PUB-02: no cookie at all, and the response may be cached because it is the same for
    // everyone (the API's only cacheable response).
    const served = await request(app, { method: "GET", url: "/api/v1/public/academy/logo", cookie: null });
    expect(served.statusCode, served.body).toBe(200);
    expect(served.headers["content-type"]).toContain("image/png");
    expect(served.headers["cache-control"]).toContain("public");
    expect((served.rawPayload as Buffer).equals(pngBytes())).toBe(true);

    // A coach may read the logo but may not replace it, and a logo that is not there is a 404.
    const coach = await request(app, {
      method: "POST",
      url: "/api/v1/settings/logo",
      cookie: coachCookie,
      csrf: coachCsrf,
      headers: { "content-type": body.contentType },
      payload: body.payload,
    });
    expect(coach.statusCode, coach.body).toBe(403);
    expect(errorCode(coach)).toBe("FORBIDDEN");
  });

  it("answers 404 for the logo before one is uploaded, and refuses an oversized or wrong-typed file", async () => {
    const missing = await request(app, {
      method: "GET",
      url: "/api/v1/public/academy/logo",
      cookie: null,
    });
    expect(missing.statusCode, missing.body).toBe(404);
    expect(errorCode(missing)).toBe("NOT_FOUND");

    const tooBig = multipartBody([
      { name: "file", filename: "logo.png", contentType: "image/png", data: oversizedPng() },
    ]);
    const big = await request(app, {
      method: "POST",
      url: "/api/v1/settings/logo",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "content-type": tooBig.contentType },
      payload: tooBig.payload,
    });
    expect(big.statusCode, big.body).toBe(413);
    expect(errorCode(big)).toBe("FILE_TOO_LARGE");

    // A PDF is a perfectly good file; it is not a logo, and the sniffed type decides.
    const wrongType = multipartBody([
      { name: "file", filename: "logo.pdf", contentType: "application/pdf", data: plainPdf("logo") },
    ]);
    const pdf = await request(app, {
      method: "POST",
      url: "/api/v1/settings/logo",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "content-type": wrongType.contentType },
      payload: wrongType.payload,
    });
    expect(pdf.statusCode, pdf.body).toBe(415);
    expect(errorCode(pdf)).toBe("UNSUPPORTED_FILE_TYPE");

    // Nothing was stored by either refusal.
    const client = await migratorClient();
    const files = await client.query(`select 1 from files where kind = 'logo'`);
    await client.end();
    expect(files.rowCount).toBe(0);
  });

  it("embeds the uploaded logo in the invoice PDF the owner downloads (SET-03 → INV-06)", async () => {
    const body = multipartBody([
      { name: "file", filename: "logo.png", contentType: "image/png", data: validPng() },
    ]);
    const uploaded = await request(app, {
      method: "POST",
      url: "/api/v1/settings/logo",
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "content-type": body.contentType },
      payload: body.payload,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(200);

    // The invoice is issued *after* the logo exists, so its snapshot names it and the renderer
    // can find the bytes (the snapshot is what makes last year's invoice keep last year's logo).
    const fixture = await invoiceFixture("U16");
    const pdf = await request(app, {
      method: "GET",
      url: `/api/v1/invoices/${fixture.invoiceId}/pdf`,
      cookie: ownerCookie,
    });
    expect(pdf.statusCode, pdf.body).toBe(200);

    // The document carries an image object of the logo's own size — the evidence that the header
    // drew the file rather than the wordmark it falls back to.
    const text = (pdf.rawPayload as Buffer).toString("latin1");
    expect(text).toContain("/Subtype /Image");
    expect(text).toContain("/Width 2");
    expect(text).toContain("/Height 2");
  });

  // -------------------------------------------------------------------------
  // PRF-01 — uploading a proof
  // -------------------------------------------------------------------------
  it("stores a bank PDF as a bank receipt, and changes nothing about the payment (PRF-01)", async () => {
    const fixture = await invoiceFixture();
    const payment = await paymentFixture({ methodCode: "bank_transfer", guardianId: fixture.guardianId });

    const uploaded = await uploadProof(payment.paymentId, {
      data: plainPdf("Fund transfer confirmation"),
      filename: "Sampath e-receipt.pdf",
      type: "application/pdf",
      note: "Sent by the guardian on WhatsApp.",
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const proof = uploaded.json() as {
      fileId: string;
      docKind: string;
      mimeType: string;
      sizeBytes: number;
      originalName?: string;
      verification?: unknown;
    };
    expect(proof.docKind).toBe("bank_receipt_pdf");
    expect(proof.mimeType).toBe("application/pdf");
    expect(proof.originalName).toBe("Sampath e-receipt.pdf");
    // No automatic check: SET-08's `proofCheck` is M7 and ships off (CR-003 pending).
    expect(proof.verification).toBeUndefined();

    // Uploading is not confirming: the payment is exactly as it was, and no receipt appeared.
    const paymentAfter = await request(app, {
      method: "GET",
      url: `/api/v1/payments/${payment.paymentId}`,
      cookie: ownerCookie,
    });
    expect(paymentAfter.statusCode, paymentAfter.body).toBe(200);
    const paymentBody = paymentAfter.json() as {
      status: string;
      allocatedMinor: number;
      proofs: { fileId: string }[];
      receipt?: unknown;
    };
    expect(paymentBody.status).toBe("pending");
    expect(paymentBody.allocatedMinor).toBe(0);
    expect(paymentBody.proofs.map((p) => p.fileId)).toEqual([proof.fileId]);
    expect(paymentBody.receipt).toBeUndefined();

    const receipts = await request(app, {
      method: "GET",
      url: `/api/v1/receipts?paymentId=${payment.paymentId}`,
      cookie: ownerCookie,
    });
    expect((receipts.json() as { data: unknown[] }).data).toEqual([]);

    // The PDF is stored unstripped (it is a document, not a photo) and the row is audited.
    const stored = await storedProofBytes(proof.fileId);
    expect(stored).not.toBeNull();
    expect(stored!.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("classifies a photograph as supporting evidence and strips its metadata before storing it (PRF-01)", async () => {
    const fixture = await invoiceFixture();
    const payment = await paymentFixture({ methodCode: "bank_transfer", guardianId: fixture.guardianId });

    const original = jpegWithExif();
    const uploaded = await uploadProof(payment.paymentId, {
      data: original,
      filename: "IMG_0042.jpg",
      type: "image/jpeg",
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const proof = uploaded.json() as { fileId: string; docKind: string; mimeType: string };
    // A photo can never produce a passing check (PAYMENT_VERIFICATION §2).
    expect(proof.docKind).toBe("bank_receipt_image");
    expect(proof.mimeType).toBe("image/jpeg");

    const stored = await storedProofBytes(proof.fileId);
    expect(stored).not.toBeNull();
    const text = stored!.toString("latin1");
    expect(text).not.toContain(GPS_PAYLOAD);
    expect(text).not.toContain("shot at home");
    expect(text).not.toContain("appended payload");
    expect(text).toContain("JFIF");
    expect(stored!.subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(stored!.subarray(-2).toString("hex")).toBe("ffd9");
    expect(stored!.byteLength).toBeLessThan(original.byteLength);
  });

  it("refuses a duplicate, an active-content PDF, a sixth proof and a long note (PRF-01)", async () => {
    const fixture = await invoiceFixture();
    const payment = await paymentFixture({ methodCode: "bank_transfer", guardianId: fixture.guardianId });

    const first = await uploadProof(payment.paymentId, {
      data: plainPdf("receipt one"),
      filename: "receipt.pdf",
      type: "application/pdf",
    });
    expect(first.statusCode, first.body).toBe(201);

    // The same bytes again, on the same payment (FILES_AND_PDF §6).
    const duplicate = await uploadProof(payment.paymentId, {
      data: plainPdf("receipt one"),
      filename: "receipt-again.pdf",
      type: "application/pdf",
    });
    expect(duplicate.statusCode, duplicate.body).toBe(409);
    expect(errorCode(duplicate)).toBe("DUPLICATE_SUSPECTED");

    const active = await uploadProof(payment.paymentId, {
      data: pdfWithActiveContent(),
      filename: "receipt.pdf",
      type: "application/pdf",
    });
    expect(active.statusCode, active.body).toBe(415);
    expect(errorCode(active)).toBe("UNSUPPORTED_FILE_TYPE");

    const longNote = await uploadProof(payment.paymentId, {
      data: plainPdf("receipt with a note"),
      filename: "receipt.pdf",
      type: "application/pdf",
      note: "x".repeat(600),
    });
    expect(longNote.statusCode, longNote.body).toBe(422);
    expect(errorCode(longNote)).toBe("VALIDATION_ERROR");

    // Four more, so the payment is at its limit of five.
    for (const label of ["two", "three", "four", "five"]) {
      const ok = await uploadProof(payment.paymentId, {
        data: plainPdf(`receipt ${label}`),
        filename: `receipt-${label}.pdf`,
        type: "application/pdf",
      });
      expect(ok.statusCode, ok.body).toBe(201);
    }

    const sixth = await uploadProof(payment.paymentId, {
      data: plainPdf("receipt six"),
      filename: "receipt-six.pdf",
      type: "application/pdf",
    });
    expect(sixth.statusCode, sixth.body).toBe(422);
    expect(errorCode(sixth)).toBe("VALIDATION_ERROR");

    // A coach is refused before any handler runs, and an anonymous caller is not signed in.
    const asCoach = await uploadProof(
      payment.paymentId,
      { data: plainPdf("coach attempt"), filename: "x.pdf", type: "application/pdf" },
      { cookie: coachCookie, csrf: coachCsrf },
    );
    expect(asCoach.statusCode, asCoach.body).toBe(403);
    const anonymous = await uploadProof(
      payment.paymentId,
      { data: plainPdf("anon attempt"), filename: "x.pdf", type: "application/pdf" },
      { cookie: "", csrf: "" },
    );
    expect(anonymous.statusCode, anonymous.body).toBe(401);
  });

  it("files a proof as `other` when the payment is not a bank transfer (PRF-01)", async () => {
    const fixture = await invoiceFixture();
    const payment = await paymentFixture({ methodCode: "other", guardianId: fixture.guardianId });

    const uploaded = await uploadProof(payment.paymentId, {
      data: plainPdf("some document"),
      filename: "document.pdf",
      type: "application/pdf",
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    // Only a bank transfer has a bank receipt to read (CR-004).
    expect((uploaded.json() as { docKind: string }).docKind).toBe("other");
  });

  // -------------------------------------------------------------------------
  // PRF-02 — the short-lived signed URL
  // -------------------------------------------------------------------------
  it("serves a proof only through a signed URL that expires (PRF-02)", async () => {
    const fixture = await invoiceFixture();
    const payment = await paymentFixture({ methodCode: "bank_transfer", guardianId: fixture.guardianId });
    const uploaded = await uploadProof(payment.paymentId, {
      data: plainPdf("downloadable receipt"),
      filename: "bank e-receipt.pdf",
      type: "application/pdf",
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const proofId = (uploaded.json() as { fileId: string }).fileId;

    const issued = await request(app, {
      method: "GET",
      url: `/api/v1/payments/${payment.paymentId}/proofs/${proofId}/download`,
      cookie: ownerCookie,
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const { url, expiresAt } = issued.json() as { url: string; expiresAt: string };
    const ttlMs = new Date(expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(0);
    // "At most 5 minutes" (FILES_AND_PDF §7).
    expect(ttlMs).toBeLessThanOrEqual(300_000);

    // Following the URL is what a browser does; it must hand back the very bytes uploaded.
    const relative = url.replace(/^https?:\/\/[^/]+/, "");
    const downloaded = await request(app, { method: "GET", url: relative, cookie: ownerCookie });
    expect(downloaded.statusCode, downloaded.body).toBe(200);
    expect(downloaded.headers["content-type"]).toContain("application/pdf");
    expect(downloaded.headers["content-disposition"]).toContain("attachment");
    expect(downloaded.headers["content-disposition"]).toContain("bank e-receipt.pdf");
    expect(downloaded.headers["cache-control"]).toBe("no-store");
    expect((downloaded.rawPayload as Buffer).toString("latin1")).toContain("downloadable receipt");

    // A tampered signature, an extended expiry and an anonymous caller are all refused.
    const tampered = await request(app, {
      method: "GET",
      url: `${relative}x`,
      cookie: ownerCookie,
    });
    expect(tampered.statusCode, tampered.body).toBe(403);
    expect(errorCode(tampered)).toBe("FORBIDDEN");

    const extended = await request(app, {
      method: "GET",
      url: relative.replace(/exp=\d+/, `exp=${Math.floor(Date.now() / 1000) + 86_400}`),
      cookie: ownerCookie,
    });
    expect(extended.statusCode, extended.body).toBe(403);

    const anonymous = await request(app, { method: "GET", url: relative, cookie: null });
    expect(anonymous.statusCode, anonymous.body).toBe(401);

    // The proof's own file: a correct signature for the wrong file is not enough.
    const wrongFile = relative.replace(proofId, randomUUID());
    const mismatched = await request(app, {
      method: "GET",
      url: wrongFile,
      cookie: ownerCookie,
    });
    expect(mismatched.statusCode, mismatched.body).toBe(404);

    // Both the issuance and the read are in the trail (FILES_AND_PDF §7).
    const actions = await auditActions(proofId);
    expect(actions.filter((action) => action === "payment.proof.read").length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // PUB-01 — the guardian's capability link
  // -------------------------------------------------------------------------
  it("serves the invoice PDF to a link holder, and one identical 404 for every bad link (PUB-01)", async () => {
    const fixture = await invoiceFixture();
    const link = await issueToken(fixture.invoiceId, { guardianId: fixture.guardianId });

    const served = await request(app, {
      method: "GET",
      url: `/api/v1/public/invoices/${link.token}/pdf`,
      cookie: null,
    });
    expect(served.statusCode, served.body).toBe(200);
    expect(served.headers["content-type"]).toContain("application/pdf");
    expect(served.headers["cache-control"]).toBe("no-store");
    expect(served.headers["referrer-policy"]).toBe("no-referrer");
    expect(served.headers["x-content-type-options"]).toBe("nosniff");
    expect(served.headers["content-disposition"]).toContain(`filename="${fixture.invoiceNumber}.pdf"`);
    const bytes = served.rawPayload as Buffer;
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");

    // A successful use is counted; it is the only evidence a public read leaves, because an
    // anonymous caller has no identity for an audit row.
    expect((await tokenUse(link.id)).use_count).toBe(1);

    const unknown = await request(app, {
      method: "GET",
      url: `/api/v1/public/invoices/${randomBytes(32).toString("base64url")}/pdf`,
      cookie: null,
    });
    const expired = await issueToken(fixture.invoiceId, {
      expiresAt: new Date(Date.now() - 60_000),
    });
    const expiredResponse = await request(app, {
      method: "GET",
      url: `/api/v1/public/invoices/${expired.token}/pdf`,
      cookie: null,
    });
    const revoked = await issueToken(fixture.invoiceId, { revokedAt: new Date() });
    const revokedResponse = await request(app, {
      method: "GET",
      url: `/api/v1/public/invoices/${revoked.token}/pdf`,
      cookie: null,
    });

    // Identical answers: nothing distinguishes "no such token" from "expired" or "revoked"
    // (FILES_AND_PDF §7). Compared field by field because `requestId` is per request by design.
    const shapeOf = (body: string) => {
      const parsed = JSON.parse(body) as { error: { code: string; message: string } };
      return { code: parsed.error.code, message: parsed.error.message };
    };
    for (const response of [unknown, expiredResponse, revokedResponse]) {
      expect(response.statusCode, response.body).toBe(404);
      expect(shapeOf(response.body)).toEqual(shapeOf(unknown.body));
    }
    // A refused use is never counted, so an attacker cannot burn a guardian's link.
    expect((await tokenUse(expired.id)).use_count).toBe(0);
    expect((await tokenUse(revoked.id)).use_count).toBe(0);
  });

  it("revokes a guardian's links when the invoice is voided, and 404s an ungenerated document (PUB-01)", async () => {
    const fixture = await invoiceFixture();
    const link = await issueToken(fixture.invoiceId);

    const current = await request(app, {
      method: "GET",
      url: `/api/v1/invoices/${fixture.invoiceId}`,
      cookie: ownerCookie,
    });
    const version = (current.json() as { version: number }).version;

    const voided = await request(app, {
      method: "POST",
      url: `/api/v1/invoices/${fixture.invoiceId}/void`,
      cookie: ownerCookie,
      csrf: ownerCsrf,
      headers: { "idempotency-key": nextKey("void") },
      payload: { reason: "Issued in error", version },
    });
    expect(voided.statusCode, voided.body).toBe(200);

    // The revocation happens in the database, on void, so it holds for every path that voids.
    expect((await tokenUse(link.id)).revoked_at).not.toBeNull();
    const afterVoid = await request(app, {
      method: "GET",
      url: `/api/v1/public/invoices/${link.token}/pdf`,
      cookie: null,
    });
    expect(afterVoid.statusCode, afterVoid.body).toBe(404);

    // A link issued before the PDF exists is the same 404, never a render on a public route.
    const second = await invoiceFixture("U14");
    const client = await migratorClient();
    await client.query(`update invoices set pdf_file_id = null, pdf_stale = true where id = $1`, [
      second.invoiceId,
    ]);
    await client.end();
    const ungenerated = await issueToken(second.invoiceId);
    const response = await request(app, {
      method: "GET",
      url: `/api/v1/public/invoices/${ungenerated.token}/pdf`,
      cookie: null,
    });
    expect(response.statusCode, response.body).toBe(404);
    expect(errorCode(response)).toBe("NOT_FOUND");
  });

  it("rate limits the public invoice route per IP (PUB-01, API_CONTRACTS §1)", async () => {
    const bogus = randomBytes(32).toString("base64url");
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const response = await request(app, {
        method: "GET",
        url: `/api/v1/public/invoices/${bogus}/pdf`,
        cookie: null,
        ip: RATE_LIMIT_IP,
      });
      statuses.push(response.statusCode);
    }
    // 30 a minute for a public route whose only defence is an unguessable token.
    expect(statuses.slice(0, 30).every((status) => status === 404)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
