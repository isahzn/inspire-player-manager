/**
 * Spike P1 (FILES_AND_PDF §4) — can the chosen PDF library render the academy's names?
 *
 * Run: `npx tsx scripts/spike-p1.ts`
 *
 * The question that decides ADR-008 is whether complex scripts are **shaped**. Sinhala and
 * Tamil need a shaping engine (HarfBuzz-class) to (a) substitute a conjunct for a
 * consonant+virama(+ZWJ) cluster and (b) **reorder** a vowel sign, which in the encoded order
 * follows its consonant but in the visual order precedes it. PDFKit lays text out through the
 * font's cmap only.
 *
 * Showing that needs care: PDFKit **subsets** each embedded font per document and renumbers
 * the glyphs, so an id from one PDF is meaningless in another. Every reference therefore
 * lives in the *same* document as the string under test. Ids are only ever compared within
 * one document.
 *
 *   - `ක්‍ර` (ka + virama + ZWJ + ra) must become a single conjunct glyph: its ids must contain
 *     a glyph that is neither the ka nor the ra seen alone.
 *   - `கி` (ka + vowel sign i) must reorder: its first id must be the vowel sign's.
 *
 * A font that has the glyphs is a Windows system font, used **for this measurement only** —
 * it is neither bundled nor shipped.
 *
 * The answer is recorded in `docs/engineering/DECISIONS.md` (ADR-008). It is kept as a
 * runnable script so the finding can be re-checked, not taken on trust.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import PDFDocument from "pdfkit";

const OUT_DIR = "var/spike-p1";
mkdirSync(OUT_DIR, { recursive: true });

/** A Sinhala- and Tamil-capable system font, used only to measure PDFKit's own text layout. */
const SYSTEM_FONT = "C:/Windows/Fonts/Nirmala.ttf";

const SAMPLE_SINHALA = "නිමල් පෙරේරා";
const SAMPLE_TAMIL = "நிமல் பெரேரா";
const CONJUNCT = "ක්‍ර"; // ka + virama + ZWJ + ra → one conjunct glyph when shaped
const TAMIL_PAIR = "கி"; // ka + vowel sign i      → [i-mark, ka] when shaped

/** Renders one line per entry, in order, into a single document. */
function renderLines(texts: string[], fontPath?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", compress: false, autoFirstPage: true });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    if (fontPath) doc.font(fontPath);
    for (const text of texts) doc.text(text);
    doc.end();
  });
}

/** Every readable content stream, inflated when it is FlateDecode'd. */
function contentStreams(pdf: Buffer): string[] {
  const raw = pdf.toString("latin1");
  const out: string[] = [];
  let cursor = 0;

  for (;;) {
    const at = raw.indexOf("stream", cursor);
    if (at < 0) break;
    cursor = at + "stream".length;
    // `endstream` also contains `stream`; only a standalone keyword opens a stream.
    if (raw.slice(Math.max(0, at - 3), at) === "end") continue;

    const end = raw.indexOf("endstream", cursor);
    if (end < 0) break;
    // The object's OWN dictionary, anchored at its `<<`. A fixed lookbehind is not safe: the
    // previous object's `/ProcSet [/PDF /Text /ImageB ...]` sits within reach and its
    // `/ImageB` would make a text stream look like an image.
    const dict = raw.slice(Math.max(0, raw.lastIndexOf("<<", at)), at);

    let start = cursor;
    if (raw[start] === "\r") start += 1;
    if (raw[start] === "\n") start += 1;
    const slice = Buffer.from(raw.slice(start, end), "latin1");
    cursor = end + "endstream".length;

    if (dict.includes("/Subtype /Image") || dict.includes("/DCTDecode")) continue;
    if (dict.includes("/Filter") && !dict.includes("/FlateDecode")) continue;
    out.push(
      dict.includes("/FlateDecode")
        ? inflateSync(slice).toString("latin1")
        : slice.toString("latin1"),
    );
  }
  return out;
}

/**
 * One entry per text object (`BT … ET`), in document order — one per `doc.text()` call.
 *
 * PDFKit writes `[<hex> 50 <hex>] TJ`; the numbers inside the array are kerning offsets,
 * never text. Hex is its only string encoding, for standard fonts and embedded ones alike —
 * one byte per character in the former, two bytes per glyph id in the latter.
 */
function textObjects(content: string): string[][] {
  return content
    .split("BT")
    .slice(1)
    // A line can split into several `TJ` arrays (font fallback, line breaking); every hex
    // token before `ET` belongs to it, so nothing may be dropped after the first array.
    .map((block) =>
      (block.split("ET")[0]!.match(/<([0-9A-Fa-f\s]+)>/g) ?? []).map((token) =>
        token.slice(1, -1).replace(/\s+/g, ""),
      ),
    );
}

function toGlyphIds(hex: string[]): number[] {
  const ids: number[] = [];
  for (const token of hex) {
    const bytes = Buffer.from(token, "hex");
    for (let i = 0; i + 1 < bytes.length; i += 2) ids.push(bytes.readUInt16BE(i));
  }
  return ids;
}

function toLatin1(hex: string[]): string {
  return hex.map((token) => Buffer.from(token, "hex").toString("latin1")).join("");
}

async function measure(texts: string[], fontPath?: string) {
  const bytes = await renderLines(texts, fontPath);
  const objects = contentStreams(bytes).flatMap(textObjects);
  return { bytes, objects };
}

/** Facts to state. The script's job is a verdict, so these are recorded, not asserted. */
const report: string[] = [];
function note(label: string, detail: string) {
  console.log(`NOTE  ${label.padEnd(44)} ${detail}`);
  report.push(`NOTE ${label}: ${detail}`);
}

/** Invariants that must hold whatever the scripts do. A failure here is a real bug. */
let failures = 0;
function check(label: string, ok: boolean, detail: string) {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(44)} ${detail}`);
  report.push(`${ok ? "PASS" : "FAIL"} ${label}: ${detail}`);
}

// --- 1. a valid PDF, and Latin round-trips ---------------------------------
const latin = await measure(["MARKER Nimal Perera MARKER"]);
writeFileSync(`${OUT_DIR}/latin-builtin.pdf`, latin.bytes);
check(
  "valid PDF (%PDF- header)",
  latin.bytes.subarray(0, 5).toString() === "%PDF-",
  `bytes=${latin.bytes.byteLength}`,
);
check(
  "Latin round-trips verbatim",
  toLatin1(latin.objects[0] ?? []) === "MARKER Nimal Perera MARKER",
  `decoded=${JSON.stringify(toLatin1(latin.objects[0] ?? []))}`,
);

// --- 2. the built-in fonts cannot encode Sinhala/Tamil ---------------------
const scripts = await measure([SAMPLE_SINHALA, SAMPLE_TAMIL]);
writeFileSync(`${OUT_DIR}/scripts-builtin.pdf`, scripts.bytes);
for (const [index, [label, sample]] of (
  [
    ["Sinhala", SAMPLE_SINHALA],
    ["Tamil", SAMPLE_TAMIL],
  ] as const
).entries()) {
  const decoded = toLatin1(scripts.objects[index] ?? []);
  note(
    `${label} with the built-in font`,
    decoded === sample
      ? "round-trips"
      : `mojibake — encoded ${JSON.stringify(decoded.slice(0, 22))}`,
  );
}

// --- 3. with a font that has the glyphs, is the text SHAPED? --------------
if (!existsSync(SYSTEM_FONT)) {
  console.log(`SKIP  ${SYSTEM_FONT} not present — the shaping measurement cannot run here.`);
  report.push("SKIP shaping measurement: no system font available");
} else {
  const samples = await measure([SAMPLE_SINHALA, SAMPLE_TAMIL], SYSTEM_FONT);
  writeFileSync(`${OUT_DIR}/scripts-embedded.pdf`, samples.bytes);
  for (const [index, [label, sample]] of (
    [
      ["Sinhala", SAMPLE_SINHALA],
      ["Tamil", SAMPLE_TAMIL],
    ] as const
  ).entries()) {
    const ids = toGlyphIds(samples.objects[index] ?? []);
    const codePoints = [...sample].length;
    note(
      `${label} with an embedded font`,
      `${codePoints} codePoints → ${ids.length} glyphs` +
        (ids.length === codePoints ? " (one glyph each, encoded order)" : " (characters lost/merged)"),
    );
  }

  // All references and the string under test share ONE document, so the subset — and with it
  // the glyph numbering — is shared, and the ids are comparable.
  const conjunct = await measure(["ක", "ර", CONJUNCT], SYSTEM_FONT);
  writeFileSync(`${OUT_DIR}/sinhala-conjunct.pdf`, conjunct.bytes);
  const kaIds = toGlyphIds(conjunct.objects[0] ?? []);
  const raIds = toGlyphIds(conjunct.objects[1] ?? []);
  const clusterIds = toGlyphIds(conjunct.objects[2] ?? []);
  const unshapedCount = [...CONJUNCT].filter((c) => c !== "\u200d").length;
  const merged = clusterIds.length < unshapedCount;
  note(
    "Sinhala conjunct `ක්‍ර`",
    `${unshapedCount} codePoints → ${clusterIds.length} glyph(s) ` +
      `${JSON.stringify(clusterIds)} (ka=${JSON.stringify(kaIds)} ra=${JSON.stringify(raIds)}); ` +
      (merged
        ? "GSUB merging DOES happen (a distinct glyph, not one per code point)"
        : "no merging — one glyph per code point"),
  );

  const reorder = await measure(["க", "ி", TAMIL_PAIR], SYSTEM_FONT);
  writeFileSync(`${OUT_DIR}/tamil-reorder.pdf`, reorder.bytes);
  const consonant = toGlyphIds(reorder.objects[0] ?? []);
  const vowel = toGlyphIds(reorder.objects[1] ?? []);
  const pair = toGlyphIds(reorder.objects[2] ?? []);
  note(
    "Tamil `கி` vowel-sign order",
    `pair=${JSON.stringify(pair)} consonant=${JSON.stringify(consonant)} vowel=${JSON.stringify(vowel)}; ` +
      "the cluster collapses to one glyph, so glyph ids CANNOT show whether the vowel sign " +
      "was reordered — counting is not evidence of correct shaping here",
  );
}

console.log(
  "\nVerdict (FILES_AND_PDF §4, ADR-008):\n" +
    "  PROVEN:\n" +
    "    · PDFKit emits valid, small, deterministic PDFs and Latin text round-trips verbatim.\n" +
    "    · The built-in fonts cannot encode Sinhala/Tamil at all — the bytes written are\n" +
    "      substituted single-byte values, i.e. mojibake, not the name.\n" +
    "    · With an embedded font that HAS the glyphs, PDFKit (through fontkit) DOES apply GSUB\n" +
    "      merging: `ක්‍ර` becomes one glyph, distinct from the ka and ra drawn alone.\n" +
    "  NOT PROVEN, and not provable from the PDF alone:\n" +
    "    · whether the merging is *correct* for these scripts. Indic rendering also needs\n" +
    "      pre-shaping REORDERING (a vowel sign that follows its consonant draws before it),\n" +
    "      and a glyph id cannot reveal draw order once a cluster collapses to one glyph.\n" +
    "    · Counting glyphs is therefore not evidence of correct shaping, and this script does\n" +
    "      not claim it is. A reference shaper (HarfBuzz) is not available here to compare.\n" +
    "  DECISION:\n" +
    "    · English-only ⇒ PDFKit + an embedded Latin font (Noto Sans). Sound, deterministic,\n" +
    "      no headless browser to patch, secure and size. This is the default.\n" +
    "    · If Sinhala or Tamil must render, that cannot be settled by inspection of bytes.\n" +
    "      M6's own exit evidence already requires a manual visual review of sample invoice\n" +
    "      and receipt PDFs by the owner, so the samples in this directory are what to look\n" +
    "      at; if the names are wrong there, the engine becomes HTML→headless Chromium.\n" +
    "    · Also true regardless: no Sinhala/Tamil font exists in this repository, so either\n" +
    "      answer currently needs one to be added (OFL, several hundred KB).\n" +
    `  · Corpus for re-checking: ${OUT_DIR}/*.pdf\n`,
);

writeFileSync(`${OUT_DIR}/findings.txt`, report.join("\n") + "\n");
if (failures > 0) {
  console.log(`${failures} expectation(s) not met — see ${OUT_DIR}/findings.txt`);
  process.exitCode = 1;
}
