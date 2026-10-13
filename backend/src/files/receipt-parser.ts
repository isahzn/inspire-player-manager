/**
 * Deterministic receipt analysis for PRF-04 (PAYMENT_VERIFICATION §3–§5, ADR-021).
 *
 * **What this is:** a pure function that reads the text layer of a bank's PDF e-receipt,
 * extracts the labelled facts, cross-checks them against what the academy recorded, and
 * returns findings. **What it is not:** a payment decision. Nothing here confirms, rejects,
 * allocates or produces a receipt — `PAY-04` stays an owner's action whatever these findings
 * say (ADR-013/ADR-020), and no finding may be worded as "verified" or "paid".
 *
 * Limits, stated so nobody has to infer them:
 *  - **No OCR and no rendering.** A scan (an image with no text layer) is reported as
 *    `NO_TEXT_LAYER` and stays unverifiable; the answer to it is "ask for the text export
 *    from the bank app", never a guess (OPEN-024).
 *  - **Layout coverage is a known gap (OPEN-023).** Fields are read from their *labels*
 *    (`Reference`, `Amount`, `From`, …). Nothing is inferred from position, colour or a
 *    guessed bank template, so a layout this parser does not recognise yields fewer fields —
 *    which shows up as `unknown` findings, not as a confident wrong answer.
 *  - **Only FlateDecode and uncompressed content streams** are decoded, using Node's own
 *    `zlib`. Other filters (LZW, ASCII85, JBIG2, …) are reported as unreadable.
 *  - A text PDF can be edited or forged. These checks catch careless edits, duplicates and
 *    reuse; they are not document forensics (PAYMENT_VERIFICATION §8).
 *
 * The module **never throws**: hostile input fails one proof, not the request.
 */
import { inflateSync } from "node:zlib";
import type { RawFinding } from "../routes/money-serialize.js";

export const RECEIPT_PARSER_VERSION = "1.0.0";

/** Upload caps a proof at 5 MB (FILES_AND_PDF §6); anything larger is not analysed. */
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;
/** Digits only: a `TJ` gap wider than this is treated as a word space (see `extractText`). */
const KERNING_SPACE_THRESHOLD = 200;
/** How far before a `stream` keyword its dictionary may start. */
const DICT_LOOKBEHIND = 600;

export interface ReceiptCheckContext {
  recordedAmountMinor: number;
  recordedReference: string | null;
  receivedAt: Date;
  payerName: string | null;
  academyTimezone: string;
  beneficiaryAccounts: { name: string; accountMasked: string }[];
  dateToleranceDays: number;
  payerNameIsSuspiciouslyReused: boolean;
  isFileDuplicated: boolean;
  invoiceNumbers: string[];
}

export interface ReceiptVerificationResult {
  status: "checked" | "unverifiable" | "failed";
  findings: RawFinding[];
  extracted?: Record<string, unknown>;
  parserVersion: string;
}

export function analyseReceiptPdf(
  bytes: Uint8Array,
  ctx: ReceiptCheckContext,
): ReceiptVerificationResult {
  try {
    return analyse(bytes, ctx);
  } catch {
    // A parser crash must fail one proof, never the process (PAYMENT_VERIFICATION §6).
    return {
      status: "failed",
      findings: [
        {
          code: "PARSE_FAILED",
          level: 1,
          result: "fail",
          detail:
            "The receipt could not be read at all. This says nothing about whether the " +
            "transfer happened — please check it yourself.",
        },
      ],
      parserVersion: RECEIPT_PARSER_VERSION,
    };
  }
}

// ---------------------------------------------------------------------------
// The analysis
// ---------------------------------------------------------------------------
function analyse(bytes: Uint8Array, ctx: ReceiptCheckContext): ReceiptVerificationResult {
  const findings: RawFinding[] = [];
  const add = (
    code: string,
    level: 1 | 2 | 3,
    result: RawFinding["result"],
    detail: string,
    meta?: Record<string, unknown>,
  ): void => {
    findings.push({ code, level, result, detail, ...(meta ? { meta } : {}) });
  };
  const finish = (extracted?: Record<string, unknown>): ReceiptVerificationResult => {
    const status = findings.some((f) => f.result === "fail")
      ? ("failed" as const)
      : findings.some((f) => f.result === "unknown")
        ? ("unverifiable" as const)
        : ("checked" as const);
    return {
      status,
      findings,
      ...(extracted && Object.keys(extracted).length > 0 ? { extracted } : {}),
      parserVersion: RECEIPT_PARSER_VERSION,
    };
  };

  // ---- L1: is this even a document we can read? -------------------------------
  const kind = sniffKind(bytes);
  if (kind === "image") {
    add(
      "SUPPORTING_ONLY",
      1,
      "unknown",
      "Only a photo or screenshot was attached. A photo can't be verified — ask for the " +
        "PDF receipt exported from the bank app.",
    );
    return finish();
  }
  if (kind !== "pdf") {
    add(
      "DOC_TYPE_UNSUPPORTED",
      1,
      "fail",
      "This file is not a PDF, so it cannot be the bank's e-receipt.",
    );
    return finish();
  }

  if (bytes.byteLength > MAX_RECEIPT_BYTES) {
    add(
      "PARSE_FAILED",
      1,
      "unknown",
      "The file is larger than the 5 MB limit these checks run under, so it was not read.",
    );
    return finish();
  }

  const raw = Buffer.from(bytes).toString("latin1");

  if (/\/Encrypt\b/.test(raw)) {
    add(
      "PARSE_FAILED",
      1,
      "unknown",
      "The PDF is encrypted or password-protected, so its text cannot be read. Ask for a " +
        "normal export from the bank app.",
    );
    return finish();
  }

  const activeToken = ACTIVE_CONTENT.find((entry) => entry.pattern.test(raw));
  if (activeToken) {
    add(
      "DOC_TYPE_UNSUPPORTED",
      1,
      "fail",
      `The PDF contains active content (${activeToken.label}). Documents that can execute or ` +
        "reach out are never parsed, so this receipt cannot be checked.",
    );
    return finish();
  }

  // ---- Text layer -------------------------------------------------------------
  const { text, streamCount } = extractText(raw);
  if (streamCount === 0) {
    add(
      "PARSE_FAILED",
      1,
      "unknown",
      "This PDF carries no readable content stream, so there is nothing to check.",
    );
    return finish();
  }
  if (text.trim().length === 0) {
    add(
      "NO_TEXT_LAYER",
      1,
      "unknown",
      "This PDF has no readable text layer (it looks like a scan). Ask for the text-based " +
        "PDF export from the bank app.",
    );
    return finish();
  }

  // ---- Field extraction -------------------------------------------------------
  const fields = extractFields(text, ctx.academyTimezone);
  const extracted = buildExtracted(fields);
  if (!fields.reference && !fields.amountRaw && !fields.dateIso) {
    add(
      "DOC_TYPE_UNSUPPORTED",
      1,
      "unknown",
      "This document does not look like a bank transfer receipt: no reference, amount or " +
        "transaction date could be found on it.",
    );
    return finish(extracted);
  }

  // ---- L2: does it match what we recorded? ------------------------------------
  // AMOUNT_MATCH — integer equality or nothing (PAYMENT_VERIFICATION §4).
  if (fields.amountMinor === null) {
    add("AMOUNT_MATCH", 2, "unknown", "No amount could be read from the receipt.");
  } else if (fields.amountMinor === ctx.recordedAmountMinor) {
    add("AMOUNT_MATCH", 2, "pass", `The receipt shows ${formatMoney(fields.amountMinor)}, exactly as recorded.`);
  } else {
    add(
      "AMOUNT_MATCH",
      2,
      "fail",
      `The receipt shows ${formatMoney(fields.amountMinor)} but ${formatMoney(
        ctx.recordedAmountMinor,
      )} was recorded.`,
      { receiptMinor: fields.amountMinor, recordedMinor: ctx.recordedAmountMinor },
    );
  }

  // REFERENCE_MATCH — the reference, or the invoice number in the remarks.
  const invoiceInText = ctx.invoiceNumbers.find((number) =>
    containsNormalized(text, number),
  );
  if (!fields.reference && !invoiceInText) {
    add(
      "REFERENCE_MATCH",
      2,
      "unknown",
      "No reference or invoice number could be read from the receipt.",
    );
  } else if (
    fields.reference &&
    ctx.recordedReference &&
    normalizeToken(fields.reference) === normalizeToken(ctx.recordedReference)
  ) {
    add("REFERENCE_MATCH", 2, "pass", "The receipt's reference matches the one recorded.");
  } else if (invoiceInText) {
    add(
      "REFERENCE_MATCH",
      2,
      "pass",
      `The invoice number ${invoiceInText} appears on the receipt.`,
    );
  } else {
    add(
      "REFERENCE_MATCH",
      2,
      "warn",
      `The receipt's reference is ${fields.reference ?? "(none)"} but ${
        ctx.recordedReference ?? "(none)"
      } was recorded. References are often edited by the payer — check before confirming.`,
    );
  }

  // BENEFICIARY_MATCH — money that went elsewhere is the one thing we must not miss.
  const configured = ctx.beneficiaryAccounts ?? [];
  if (configured.length === 0) {
    add(
      "BENEFICIARY_MATCH",
      2,
      "unknown",
      "The academy's own bank accounts are not set up, so the receipt's beneficiary cannot " +
        "be checked against them.",
    );
  } else if (!fields.beneficiaryName && !fields.beneficiaryAccountMasked) {
    add(
      "BENEFICIARY_MATCH",
      2,
      "unknown",
      "The receipt does not name a beneficiary, so it cannot be checked against the " +
        "academy's accounts.",
    );
  } else {
    const matched = configured.find(
      (account) =>
        accountMatches(account.accountMasked, fields.beneficiaryAccountMasked) ||
        namesLooselyMatch(account.name, fields.beneficiaryName),
    );
    if (matched) {
      add(
        "BENEFICIARY_MATCH",
        2,
        "pass",
        `The receipt's beneficiary matches the academy's account ${matched.name}.`,
      );
    } else {
      add(
        "BENEFICIARY_MATCH",
        2,
        "fail",
        `The receipt names ${fields.beneficiaryName ?? "(no name)"} ${
          fields.beneficiaryAccountMasked ?? "(no account)"
        }, which is not one of the academy's accounts. Check where the money was sent.`,
        {
          receiptBeneficiary: fields.beneficiaryAccountMasked ?? null,
          configuredAccounts: configured.map((account) => account.accountMasked),
        },
      );
    }
  }

  // DATE_TOLERANCE — calendar days in the academy's timezone, not raw instants.
  if (!fields.transactionAt) {
    add("DATE_TOLERANCE", 2, "unknown", "No transaction date could be read from the receipt.");
  } else {
    const days = calendarDaysBetween(fields.transactionAt, ctx.receivedAt, ctx.academyTimezone);
    if (days === null) {
      add("DATE_TOLERANCE", 2, "unknown", "The transaction date could not be compared.");
    } else if (days <= ctx.dateToleranceDays) {
      add(
        "DATE_TOLERANCE",
        2,
        "pass",
        `The transfer date is ${days} day(s) from the date recorded, within the allowed ${ctx.dateToleranceDays}.`,
      );
    } else {
      add(
        "DATE_TOLERANCE",
        2,
        "warn",
        `The receipt says the transfer was made ${days} day(s) away from the date recorded ` +
          `(the allowance is ${ctx.dateToleranceDays}).`,
      );
    }
  }

  // PAYER_SOFT_MATCH — a warning at most; third parties pay on a family's behalf.
  if (!fields.payerName) {
    add("PAYER_SOFT_MATCH", 2, "unknown", "The receipt does not name a payer.");
  } else if (!ctx.payerName) {
    add(
      "PAYER_SOFT_MATCH",
      2,
      "unknown",
      `The receipt names ${fields.payerName} as the payer, but the payment has no payer ` +
        "recorded to compare it with.",
    );
  } else if (ctx.payerNameIsSuspiciouslyReused) {
    add(
      "PAYER_SOFT_MATCH",
      2,
      "warn",
      `The payer ${fields.payerName} is the same name used on other payments. That is often ` +
        "legitimate (a parent paying for several children), but worth a look.",
    );
  } else if (namesLooselyMatch(ctx.payerName, fields.payerName)) {
    add(
      "PAYER_SOFT_MATCH",
      2,
      "pass",
      `The payer on the receipt (${fields.payerName}) matches the payer recorded.`,
    );
  } else {
    add(
      "PAYER_SOFT_MATCH",
      2,
      "warn",
      `The receipt's payer is ${fields.payerName}, but ${ctx.payerName} was recorded. ` +
        "Someone else paying is normal — just check it is the payment you expected.",
    );
  }

  // STATUS_SUCCESSFUL — only an explicit failure is a failure.
  if (!fields.status) {
    add("STATUS_SUCCESSFUL", 2, "unknown", "The receipt does not state a transaction status.");
  } else if (FAILED_STATUS.test(fields.status)) {
    add(
      "STATUS_SUCCESSFUL",
      2,
      "fail",
      `The receipt's status reads "${fields.status}", which is not a completed transfer.`,
    );
  } else if (SUCCESS_STATUS.test(fields.status)) {
    add("STATUS_SUCCESSFUL", 2, "pass", `The receipt's status reads "${fields.status}".`);
  } else {
    add(
      "STATUS_SUCCESSFUL",
      2,
      "unknown",
      `The receipt's status reads "${fields.status}", which this check does not recognise.`,
    );
  }

  // RECEIPT_NOT_REUSED — the file half. The reference half belongs to the caller, which
  // compares the extracted reference with the other payments that claim it.
  if (ctx.isFileDuplicated) {
    add(
      "RECEIPT_NOT_REUSED",
      2,
      "fail",
      "This exact file is already attached to another payment.",
    );
  } else {
    add(
      "RECEIPT_NOT_REUSED",
      2,
      "pass",
      "This exact file is not attached to any other payment.",
    );
  }

  // INVOICE_MATCH — a warning at most; the amount may legitimately cover several invoices.
  if (ctx.invoiceNumbers.length === 0) {
    add("INVOICE_MATCH", 2, "unknown", "There is no invoice to match this payment against.");
  } else if (invoiceInText) {
    add("INVOICE_MATCH", 2, "pass", `The invoice number ${invoiceInText} appears on the receipt.`);
  } else {
    add(
      "INVOICE_MATCH",
      2,
      "warn",
      "None of this payment's invoice numbers appear on the receipt. One transfer can pay " +
        "several invoices, so this is only worth a look.",
    );
  }

  return finish(extracted);
}

// ---------------------------------------------------------------------------
// L1 helpers
// ---------------------------------------------------------------------------
interface ActiveContentToken {
  label: string;
  pattern: RegExp;
}

/**
 * Tokens rejected outright (FILES_AND_PDF §6, re-checked here immediately before parsing).
 *
 * `/URI` is included: an external reference is never fetched and a document that carries one
 * is not something we can vouch for. It is reported as a failure with an actionable detail,
 * because in practice it means "we will not check this one — ask for a plain export".
 */
const ACTIVE_CONTENT: ActiveContentToken[] = [
  { label: "/JavaScript", pattern: /\/JavaScript(?![A-Za-z0-9])/ },
  { label: "/JS", pattern: /\/JS(?![A-Za-z0-9])/ },
  { label: "/Launch", pattern: /\/Launch(?![A-Za-z0-9])/ },
  { label: "/EmbeddedFile", pattern: /\/EmbeddedFile(?![A-Za-z0-9])/ },
  { label: "/OpenAction", pattern: /\/OpenAction(?![A-Za-z0-9])/ },
  { label: "/URI", pattern: /\/URI(?![A-Za-z0-9])/ },
];

/**
 * The active-content tokens a PDF carries, by name (empty when it carries none).
 *
 * Exported because the spec asks for this screen at **two** moments — when the file is stored
 * (`PRF-01`, FILES_AND_PDF §6) and again immediately before it is parsed (PAYMENT_VERIFICATION
 * §6) — and one shared token list is the only way those two moments can be sure they agree.
 */
export function screenActiveContent(bytes: Uint8Array): string[] {
  const latin = Buffer.from(bytes).toString("latin1");
  return ACTIVE_CONTENT.filter((token) => token.pattern.test(latin)).map((token) => token.label);
}

type SniffedKind = "pdf" | "image" | "unknown";

/** Magic bytes, never the file extension (FILES_AND_PDF §6). */
function sniffKind(bytes: Uint8Array): SniffedKind {
  const head = bytes.subarray(0, 16);
  const latin = Buffer.from(head).toString("latin1");
  if (latin.includes("%PDF-")) return "pdf";
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image";
  if (head[0] === 0x89 && latin.slice(1, 4) === "PNG") return "image";
  if (latin.startsWith("GIF8")) return "image";
  if (latin.startsWith("RIFF") && latin.includes("WEBP")) return "image";
  if (latin.slice(4, 8) === "ftyp") return "image"; // HEIC/HEIF — unsupported, and never parsed
  // The header may sit within the first 1024 bytes of a real PDF.
  const wider = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  return wider.includes("%PDF-") ? "pdf" : "unknown";
}

// ---------------------------------------------------------------------------
// Text-layer extraction (FlateDecode only, no rendering)
// ---------------------------------------------------------------------------
/** Decodes every readable content stream and returns the text operators' payload. */
function extractText(raw: string): { text: string; streamCount: number } {
  const chunks: string[] = [];
  let cursor = 0;
  let streamCount = 0;

  for (;;) {
    const at = raw.indexOf("stream", cursor);
    if (at < 0) break;
    cursor = at + "stream".length;
    // `endstream` also contains `stream` — only a standalone keyword counts.
    if (raw.slice(Math.max(0, at - 3), at) === "end") continue;

    const dictStart = Math.max(0, at - DICT_LOOKBEHIND);
    const dict = raw.slice(dictStart, at);
    const end = raw.indexOf("endstream", cursor);
    if (end < 0) break;

    let dataStart = cursor;
    if (raw[dataStart] === "\r") dataStart += 1;
    if (raw[dataStart] === "\n") dataStart += 1;
    const dataEnd = end;
    cursor = end + "endstream".length;

    // Images and unsupported filters are not text we can read.
    if (/\/Image|\/DCTDecode|\/JPXDecode|\/CCITTFaxDecode|\/JBIG2Decode/.test(dict)) continue;
    const filtered = /\/Filter/.test(dict);
    if (filtered && !/\/FlateDecode/.test(dict)) continue;

    const slice = Buffer.from(raw.slice(dataStart, dataEnd), "latin1");
    let decoded: Buffer;
    if (filtered) {
      try {
        decoded = inflateSync(slice);
      } catch {
        continue; // a stream we cannot inflate is skipped, not guessed at
      }
    } else {
      decoded = slice;
    }
    streamCount += 1;
    chunks.push(extractTextOperators(decoded.toString("latin1")));
  }

  return { text: chunks.join("\n"), streamCount };
}

interface OperatorToken {
  text: string;
  end: number;
}

const TEXT_OPERATORS = new Set(["Tj", "TJ", "'", '"']);
const LINE_BREAK_OPERATORS = new Set(["Td", "TD", "T*", "Tm", "BT", "ET"]);

/**
 * Pulls the strings out of the text-showing operators.
 *
 * The one subtlety worth naming: inside a `TJ` array the numbers between strings are kerning
 * offsets, not spaces. Inserting a space for each of them splits every amount and date in
 * half (`4`, `000.00`), so a space is inserted only for offsets wider than
 * `KERNING_SPACE_THRESHOLD` — which is what a word space actually looks like.
 */
function extractTextOperators(content: string): string {
  const out: string[] = [];
  let pendingBreak = false;
  let i = 0;

  while (i < content.length) {
    const ch = content[i]!;

    if (ch === "(") {
      const literal = readLiteral(content, i);
      if (!literal) {
        i += 1;
        continue;
      }
      const parts: string[] = [literal.value];
      let j = literal.end;
      let sawWideGap = false;

      for (;;) {
        const s = skipSeparators(content, j);
        const c = content[s];
        if (c === "(") {
          const more = readLiteral(content, s);
          if (!more) break;
          if (sawWideGap) parts.push(" ");
          sawWideGap = false;
          parts.push(more.value);
          j = more.end;
          continue;
        }
        if (c === "[" || c === "]") {
          j = s + 1;
          continue;
        }
        const number = readNumber(content, s);
        if (number) {
          if (Math.abs(number.value) > KERNING_SPACE_THRESHOLD) sawWideGap = true;
          j = number.end;
          continue;
        }
        break;
      }

      const operator = readOperator(content, skipSeparators(content, j));
      if (operator && TEXT_OPERATORS.has(operator.text)) {
        if (pendingBreak && out.length > 0) out.push("\n");
        pendingBreak = operator.text === "'" || operator.text === '"';
        out.push(parts.join(""));
        i = operator.end;
        continue;
      }
      i = literal.end;
      continue;
    }

    if (/[A-Za-z*'"]/.test(ch)) {
      const operator = readOperator(content, i);
      if (operator) {
        if (LINE_BREAK_OPERATORS.has(operator.text)) pendingBreak = true;
        i = operator.end;
        continue;
      }
    }
    i += 1;
  }

  return out.join("");
}

const SEPARATORS = new Set([" ", "\t", "\r", "\n", "\f", "\0"]);

function skipSeparators(content: string, from: number): number {
  let i = from;
  while (i < content.length && SEPARATORS.has(content[i]!)) i += 1;
  return i;
}

/** A PDF literal string, honouring escapes and balanced parentheses. */
function readLiteral(
  content: string,
  start: number,
): { value: string; end: number } | null {
  let depth = 1;
  let i = start + 1;
  let value = "";

  while (i < content.length) {
    const ch = content[i]!;
    if (ch === "\\") {
      const next = content[i + 1];
      if (next === undefined) break;
      switch (next) {
        case "n": value += "\n"; i += 2; continue;
        case "r": value += "\r"; i += 2; continue;
        case "t": value += "\t"; i += 2; continue;
        case "b": value += "\b"; i += 2; continue;
        case "f": value += "\f"; i += 2; continue;
        case "(": value += "("; i += 2; continue;
        case ")": value += ")"; i += 2; continue;
        case "\\": value += "\\"; i += 2; continue;
        case "\n": i += 2; continue;
        case "\r": i += content[i + 2] === "\n" ? 3 : 2; continue;
        default: {
          const octal = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4));
          if (octal) {
            value += String.fromCharCode(parseInt(octal[0], 8));
            i += 1 + octal[0].length;
            continue;
          }
          value += next;
          i += 2;
          continue;
        }
      }
    }
    if (ch === "(") {
      depth += 1;
      value += ch;
      i += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { value, end: i + 1 };
      value += ch;
      i += 1;
      continue;
    }
    value += ch;
    i += 1;
  }
  return null;
}

function readNumber(content: string, at: number): { value: number; end: number } | null {
  const match = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(content.slice(at, at + 24));
  if (!match || match[0].length === 0) return null;
  return { value: Number(match[0]), end: at + match[0].length };
}

function readOperator(content: string, at: number): OperatorToken | null {
  const match = /^[A-Za-z*'"]+/.exec(content.slice(at, at + 12));
  if (!match || match[0].length === 0) return null;
  return { text: match[0], end: at + match[0].length };
}

// ---------------------------------------------------------------------------
// Field extraction (label-anchored; no layout guessing)
// ---------------------------------------------------------------------------
interface ExtractedFields {
  bankName: string | null;
  documentType: string | null;
  reference: string | null;
  /** The extracted transaction time, as the instant ISO-8601 string the contract uses. */
  dateIso: string | null;
  transactionAt: Date | null;
  amountMinor: number | null;
  amountRaw: string | null;
  currency: string | null;
  payerName: string | null;
  payerAccountMasked: string | null;
  beneficiaryName: string | null;
  beneficiaryAccountMasked: string | null;
  channel: string | null;
  status: string | null;
  remarks: string | null;
}

function extractFields(text: string, timeZone: string): ExtractedFields {
  const amount = extractAmount(text);
  const date = extractDate(text, timeZone);
  return {
    bankName: extractBankName(text),
    documentType: extractDocumentType(text),
    reference: firstGroup(text, REFERENCE_PATTERNS, 40),
    dateIso: date === null ? null : date.iso,
    transactionAt: date === null ? null : date.instant,
    amountMinor: amount === null ? null : amount.minor,
    amountRaw: amount === null ? null : amount.raw,
    currency: amount === null ? null : amount.currency,
    payerName: firstGroup(text, PAYER_NAME_PATTERNS, 60),
    payerAccountMasked: firstGroup(text, PAYER_ACCOUNT_PATTERNS, 30),
    beneficiaryName: firstGroup(text, BENEFICIARY_NAME_PATTERNS, 60),
    beneficiaryAccountMasked: firstGroup(text, BENEFICIARY_ACCOUNT_PATTERNS, 30),
    channel: extractChannel(text),
    status: extractStatus(text),
    remarks: firstGroup(text, REMARKS_PATTERNS, 120),
  };
}

function buildExtracted(fields: ExtractedFields): Record<string, unknown> {
  const extracted: Record<string, unknown> = {};
  if (fields.bankName) extracted["bankName"] = fields.bankName;
  if (fields.documentType) extracted["documentType"] = fields.documentType;
  if (fields.reference) extracted["reference"] = fields.reference;
  if (fields.dateIso) extracted["transactionAt"] = fields.dateIso;
  if (fields.amountMinor !== null) extracted["amountMinor"] = fields.amountMinor;
  if (fields.currency) extracted["currency"] = fields.currency;
  if (fields.payerName) extracted["payerName"] = fields.payerName;
  if (fields.payerAccountMasked) extracted["payerAccountMasked"] = fields.payerAccountMasked;
  if (fields.beneficiaryName) extracted["beneficiaryName"] = fields.beneficiaryName;
  if (fields.beneficiaryAccountMasked) {
    extracted["beneficiaryAccountMasked"] = fields.beneficiaryAccountMasked;
  }
  if (fields.channel) extracted["channel"] = fields.channel;
  if (fields.status) extracted["status"] = fields.status;
  if (fields.remarks) extracted["remarks"] = fields.remarks;
  return extracted;
}

function firstGroup(text: string, patterns: RegExp[], maxLength: number): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim();
    if (value && value.length > 0 && value.length <= maxLength) return value;
  }
  return null;
}

/**
 * A value must be on the same line as its label for the name-like fields, so a label cannot
 * capture the next unrelated line. Amounts, dates and references may sit on the line below:
 * their shapes are unambiguous enough to cross a newline safely.
 */
const REFERENCE_PATTERNS: RegExp[] = [
  /(?:transaction|txn)\s*(?:reference|ref|id|no\.?|number)\s*[:\-]?\s*\n?\s*([A-Za-z0-9][A-Za-z0-9\-/]{3,39})/i,
  /(?:receipt|reference|ref)\s*(?:no\.?|number|#)\s*[:\-]?\s*\n?\s*([A-Za-z0-9][A-Za-z0-9\-/]{3,39})/i,
  /(?:^|\n)\s*(?:reference|ref)\s*[:\-]\s*\n?\s*([A-Za-z0-9][A-Za-z0-9\-/]{3,39})/i,
];

const PAYER_NAME_PATTERNS: RegExp[] = [
  /(?:from\s*account\s*(?:name|holder)|ordering\s*customer)\s*[:\-]\s*([^\n]{2,60})/i,
  /(?:sender|payer|remitter)\s*(?:name)?\s*[:\-]\s*([^\n]{2,60})/i,
  /(?:^|\n)\s*from\s*[:\-]\s*([^\n]{2,60})/i,
];

const PAYER_ACCOUNT_PATTERNS: RegExp[] = [
  /(?:from|debit|sender|payer)\s*(?:account|a\/c)?\s*(?:no\.?|number|#)?\s*[:\-]\s*([0-9xX*][0-9xX*\s\-]{3,29})/i,
];

const BENEFICIARY_NAME_PATTERNS: RegExp[] = [
  /(?:beneficiary\s*(?:name)?|payee\s*(?:name)?|receiver\s*(?:name)?|credit\s*account\s*(?:name|holder)|to\s*account\s*(?:name|holder))\s*[:\-]\s*([^\n]{2,60})/i,
  /(?:^|\n)\s*to\s*[:\-]\s*([^\n]{2,60})/i,
];

const BENEFICIARY_ACCOUNT_PATTERNS: RegExp[] = [
  /(?:beneficiary|to|payee|credit|receiver)\s*(?:account|a\/c)?\s*(?:no\.?|number|#)?\s*[:\-]\s*([0-9xX*][0-9xX*\s\-]{3,29})/i,
];

const REMARKS_PATTERNS: RegExp[] = [
  /(?:remarks|purpose|narration|payment\s*(?:reference|details))\s*[:\-]?\s*\n?\s*([^\n]{2,120})/i,
  /(?:description|note)\s*[:\-]?\s*\n?\s*([^\n]{2,120})/i,
];

/** Named banks, so the receipt's own header identifies it without a guessed template. */
const KNOWN_BANKS: string[] = [
  "Bank of Ceylon",
  "Commercial Bank",
  "Sampath Bank",
  "Hatton National Bank",
  "HNB",
  "Nations Trust Bank",
  "Seylan Bank",
  "People's Bank",
  "DFCC Bank",
  "National Development Bank",
  "NDB Bank",
  "Standard Chartered",
  "HSBC",
  "Pan Asia Bank",
  "Union Bank",
  "Amana Bank",
  "LOLC",
  "Cargills Bank",
  "NCB",
];

function extractBankName(text: string): string | null {
  const labelled = /(?:^|\n)\s*bank\s*(?:name)?\s*[:\-]\s*([^\n]{2,60})/i.exec(text);
  if (labelled?.[1]) return labelled[1].trim();
  const found = KNOWN_BANKS.find((name) => containsNormalized(text, name));
  return found ?? null;
}

function extractDocumentType(text: string): string | null {
  const labelled = /(?:^|\n)\s*(?:document|receipt)\s*(?:type|title)\s*[:\-]\s*([^\n]{3,80})/i.exec(text);
  if (labelled?.[1]) return labelled[1].trim();
  const titled =
    /(transaction receipt|fund transfer confirmation|transfer confirmation|payment confirmation|fund transfer receipt|transfer receipt|transaction confirmation|payment receipt|receipt)/i.exec(
      text,
    );
  return titled?.[1] ? titled[1].trim() : null;
}

function extractChannel(text: string): string | null {
  const labelled = /(?:channel|transfer\s*(?:type|method)|payment\s*method)\s*[:\-]?\s*\n?\s*([^\n]{2,40})/i.exec(text);
  if (labelled?.[1]) return labelled[1].trim();
  const keyword = /\b(CEFT|SLIPS|RTGS|IMPS|internal transfer|own account|online transfer|fund transfer)\b/i.exec(text);
  return keyword?.[1] ? keyword[1].trim() : null;
}

const SUCCESS_STATUS = /success|complet|processed|settled|paid/i;
const FAILED_STATUS = /fail|declin|pending|reject|unsuccess|cancel|revers|expired|not\s*completed/i;

function extractStatus(text: string): string | null {
  const labelled = /(?:transaction\s*status|status)\s*[:\-]?\s*\n?\s*([A-Za-z][A-Za-z ]{2,30})/i.exec(text);
  if (labelled?.[1]) return labelled[1].trim();
  const keyword =
    /\b(successful|success|completed|processed|settled|failed|declined|pending|rejected|unsuccessful|cancelled|canceled)\b/i.exec(
      text,
    );
  return keyword?.[1] ? keyword[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Amount and date parsing — integer minor units, no float arithmetic
// ---------------------------------------------------------------------------
function extractAmount(
  text: string,
): { minor: number; raw: string; currency: string | null } | null {
  const patterns: RegExp[] = [
    /(?:total\s*amount|transfer\s*amount|amount)\s*\(?\s*(LKR|Rs\.?|SLR)?\s*\)?\s*[:\-]?\s*\n?\s*((?:LKR|Rs\.?|SLR)?\s*[\d,]+(?:\.\d{1,2})?)/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const currency = (match[1] ?? "").trim() || null;
    const raw = (match[2] ?? "").trim();
    const minor = parseMinorUnits(raw);
    if (minor !== null) return { minor, raw, currency: normalizeCurrency(currency ?? raw) };
  }
  return null;
}

function normalizeCurrency(value: string): string | null {
  if (/LKR|SLR|Rs/i.test(value)) return "LKR";
  return null;
}

/**
 * `1,234.56` / `1234.56` / `1234` / `Rs. 4,000.00` → minor units.
 *
 * Read digit-wise on purpose: `Number("1234.56") * 100` is exactly the float arithmetic the
 * money rules forbid, and it lands on 123455.99999999999 for some inputs.
 */
export function parseMinorUnits(input: string): number | null {
  const digitsAndDots = input.replace(/[^0-9.,]/g, "").replace(/,/g, "");
  if (digitsAndDots.length === 0) return null;
  const parts = digitsAndDots.split(".");
  if (parts.length > 2) return null; // "1.234.567" is a layout we do not support
  const whole = parts[0] ?? "";
  const fraction = parts[1] ?? "";
  if (whole.length === 0 && fraction.length === 0) return null;
  if (fraction.length > 2) return null; // more precision than minor units can express
  const wholeValue = whole.length === 0 ? 0 : Number(whole);
  if (!Number.isSafeInteger(wholeValue)) return null;
  const cents = fraction.length === 0 ? 0 : Number(fraction.padEnd(2, "0"));
  return wholeValue * 100 + cents;
}

interface ParsedDate {
  iso: string;
  instant: Date;
}

const DATE_PATTERNS: RegExp[] = [
  /(?:transaction\s*date\s*(?:&|and)?\s*time|date\s*(?:&|and)\s*time|value\s*date|transaction\s*date|transfer\s*date|date)\s*[:\-]?\s*\n?\s*(\d{4}-\d{2}-\d{2}|\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4})(?:\s+(\d{1,2}:\d{2}(?::\d{2})?)\s*([AaPp]\.?[Mm]\.?)?)?/i,
];

function extractDate(text: string, timeZone: string): ParsedDate | null {
  for (const pattern of DATE_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const day = parseCalendarDate(match[1]!);
    if (!day) continue;
    const time = parseClock(match[2] ?? null, match[3] ?? null);
    // The receipt's clock is the bank's local time, so the wall time is anchored in the
    // academy's timezone before it becomes an instant — otherwise every timestamp is off
    // by the offset (05:30 in Colombo) and the owner's "when was it transferred" is wrong.
    const instant = zonedWallToInstant(
      day.year,
      day.month,
      day.day,
      time.hour,
      time.minute,
      timeZone,
    );
    return { iso: instant.toISOString(), instant };
  }
  return null;
}

/**
 * A wall-clock time in `timeZone` → the instant it denotes.
 *
 * The offset is read from the platform's tz database via `Intl` (never hardcoded), and
 * applied in two steps so a zone whose offset changes at the instant is handled once. Zones
 * without DST — including the academy's — are exact.
 */
function zonedWallToInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const firstGuess = new Date(naive - timeZoneOffsetMinutes(new Date(naive), timeZone) * 60_000);
  const corrected = new Date(
    naive - timeZoneOffsetMinutes(firstGuess, timeZone) * 60_000,
  );
  return corrected;
}

function timeZoneOffsetMinutes(at: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(at);
    const name = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!match) return 0;
    const sign = match[1] === "-" ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3] ?? 0));
  } catch {
    return 0;
  }
}

function parseCalendarDate(
  value: string,
): { year: number; month: number; day: number } | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) {
    return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  }
  const parts = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/.exec(value);
  if (!parts) return null;
  const first = Number(parts[1]);
  const second = Number(parts[2]);
  const year = Number(parts[3]!.length === 2 ? `20${parts[3]}` : parts[3]);
  // These receipts are day-first (`15/10/2026`), and a value that cannot be a month settles
  // the ambiguity the other way.
  let day = first;
  let month = second;
  if (first <= 12 && second > 12) {
    day = second;
    month = first;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function parseClock(
  time: string | null,
  meridiem: string | null,
): { hour: number; minute: number } {
  if (!time) return { hour: 0, minute: 0 };
  const parts = time.split(":");
  let hour = Number(parts[0] ?? 0);
  const minute = Number(parts[1] ?? 0);
  if (meridiem) {
    const pm = /p/i.test(meridiem);
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  return { hour, minute };
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------
function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function containsNormalized(haystack: string, needle: string): boolean {
  const normalizedNeedle = normalizeToken(needle);
  if (normalizedNeedle.length < 4) return false;
  return normalizeToken(haystack).includes(normalizedNeedle);
}

function digits(value: string | null): string {
  return value === null ? "" : value.replace(/\D/g, "");
}

/**
 * Account comparison works on digits only: both sides are masked values (`****1234`), so the
 * tail is the part that can be compared. Four digits is the shortest tail worth calling a
 * match.
 */
function accountMatches(configured: string, extracted: string | null): boolean {
  const a = digits(configured);
  const b = digits(extracted);
  if (a.length < 4 || b.length < 4) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

/** Order-insensitive, tolerant of initials, titles and reordered names. */
function namesLooselyMatch(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (a.length === 0 || b.length === 0) return false;
  const shared = a.filter((token) => b.includes(token));
  if (shared.length === 0) return false;
  return shared.some((token) => token.length >= 4) || shared.length >= 2;
}

function nameTokens(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

/** Calendar days between two instants, in the academy's timezone (BILLING_ENGINE §12). */
function calendarDaysBetween(a: Date, b: Date, timeZone: string): number | null {
  const left = localDayNumber(a, timeZone);
  const right = localDayNumber(b, timeZone);
  if (left === null || right === null) return null;
  return Math.abs(Math.round((left - right) / 86_400_000));
}

function localDayNumber(at: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(at);
    const get = (type: string): number =>
      Number(parts.find((part) => part.type === type)?.value ?? "NaN");
    const year = get("year");
    const month = get("month");
    const day = get("day");
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
      return null;
    }
    return Date.UTC(year, month - 1, day);
  } catch {
    return null;
  }
}

function formatMoney(minor: number): string {
  const whole = Math.trunc(minor / 100);
  const cents = Math.abs(minor % 100);
  return `LKR ${whole.toLocaleString("en-US")}.${String(cents).padStart(2, "0")}`;
}
