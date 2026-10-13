/**
 * The shared layout kit for the invoice and receipt PDFs (FILES_AND_PDF §2 and §3 share a
 * header, a footer and a table).
 *
 * Everything the two documents have in common lives here so the branding block cannot drift
 * between them, and so the *renderer-independent* shapes ("a title, a badge, a key/value
 * block, a table") stay separate from the facts being printed.
 *
 * The palette is deliberately plain ink-on-white with one rule colour: the official brand
 * colours are still the owner's to give (OPEN-001), and a PDF is not the place to invent them.
 */
import PDFDocument from "pdfkit";

/** A4 portrait with 18 mm margins (FILES_AND_PDF §2). */
export const PAGE = {
  width: 595.28,
  height: 841.89,
  margin: 51.02, // 18 mm in points
} as const;

const CONTENT_WIDTH = PAGE.width - PAGE.margin * 2;

const INK = "#111111";
const MUTED = "#5b5b5b";
const RULE = "#c9c9c9";
const HEADER_FILL = "#f2f2f2";
const BADGE_FILL = "#eeeeee";

/** The branding block every document starts with. */
export interface PdfBrand {
  academyName: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  /** The logo bytes, or `null` to draw the academy name as a wordmark instead. */
  logo: Uint8Array | null;
}

/** The right-hand identity block: title, optional badge, and the document's own dates. */
export interface PdfMeta {
  title: string;
  badge?: string | null;
  fields: { label: string; value: string }[];
  /** The small print at the bottom of the last page. */
  footerNote: string;
  /** `Generated 11 Oct 2026 14:05 (Asia/Colombo)`, repeated on every page. */
  generated: string;
  /** Drawn diagonally across every page when present (`VOID`). */
  watermark?: string | null;
}

export interface TableColumn {
  header: string;
  width: number;
  align?: "left" | "right";
}

export interface TableRow {
  cells: string[];
  /** A totals row is drawn bold, above a heavier rule. */
  emphasis?: boolean;
}

export interface RenderOptions {
  /** `CreationDate` in the PDF trailer: the document's own date, so a re-render is reproducible. */
  createdAt: Date;
  title: string;
}

export interface PdfResult {
  bytes: Buffer;
  pages: number;
}

/** Runs `build` and resolves the finished bytes. */
export async function renderPdf(
  options: RenderOptions,
  build: (doc: PDFKit.PDFDocument) => void,
): Promise<PdfResult> {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: PAGE.margin, bottom: PAGE.margin, left: PAGE.margin, right: PAGE.margin },
    // Page numbers in the footer need every page buffered before the footer is drawn.
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: options.title,
      Creator: "Inspire Academy",
      Producer: "Inspire Academy",
      CreationDate: options.createdAt,
      ModDate: options.createdAt,
    },
  });

  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });

  build(doc);
  const range = doc.bufferedPageRange();
  doc.end();
  const bytes = await done;
  return { bytes, pages: range.count };
}

/**
 * The branding block and the document's identity, at the top of the current page.
 * Returns the `y` the caller should continue from.
 */
export function drawHeader(doc: PDFKit.PDFDocument, brand: PdfBrand, meta: PdfMeta): number {
  const top: number = PAGE.margin;
  let leftY: number = top;

  if (brand.logo) {
    try {
      doc.image(Buffer.from(brand.logo), PAGE.margin, top, { fit: [110, 44] });
      leftY = top + 44 + 8;
    } catch {
      // A logo that cannot be decoded must not fail the document: fall back to the wordmark,
      // which is exactly what the UI does before a logo exists (SET-03).
      leftY = drawWordmark(doc, brand.academyName, top);
    }
  } else {
    leftY = drawWordmark(doc, brand.academyName, top);
  }

  // The name appears once more under the logo, but not under the wordmark — that would print
  // it twice.
  if (brand.logo) {
    doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(brand.academyName, PAGE.margin, leftY);
    leftY = doc.y + 2;
  }

  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED);
  for (const line of [brand.address, brand.phone, brand.email]) {
    if (!line) continue;
    doc.text(line, PAGE.margin, leftY, { width: CONTENT_WIDTH * 0.55 });
    leftY = doc.y;
  }

  // Right column: the title, the badge, then the labelled facts.
  const rightX = PAGE.margin + CONTENT_WIDTH * 0.6;
  const rightWidth = CONTENT_WIDTH * 0.4;

  doc.font("Helvetica-Bold").fontSize(20).fillColor(INK)
    .text(meta.title, rightX, top, { width: rightWidth, align: "right" });
  let rightY = doc.y + 4;

  if (meta.badge) {
    doc.font("Helvetica-Bold").fontSize(8.5);
    const labelWidth = doc.widthOfString(meta.badge) + 12;
    doc.roundedRect(rightX + rightWidth - labelWidth, rightY, labelWidth, 15, 2)
      .fill(BADGE_FILL);
    doc.fillColor(INK).text(meta.badge, rightX + rightWidth - labelWidth, rightY + 4, {
      width: labelWidth,
      align: "center",
    });
    rightY += 15 + 6;
  }

  for (const field of meta.fields) {
    doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
      .text(field.label, rightX, rightY, { width: rightWidth * 0.45, continued: false });
    doc.font("Helvetica-Bold").fillColor(INK)
      .text(field.value, rightX + rightWidth * 0.45, rightY, {
        width: rightWidth * 0.55,
        align: "right",
      });
    rightY = doc.y + 1;
  }

  const y = Math.max(leftY, rightY) + 10;
  doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).lineWidth(0.8)
    .strokeColor(RULE).stroke();
  return y + 12;
}

function drawWordmark(doc: PDFKit.PDFDocument, name: string, y: number): number {
  doc.font("Helvetica-Bold").fontSize(16).fillColor(INK).text(name, PAGE.margin, y);
  return doc.y + 4;
}

/** A small all-caps section label. */
export function sectionTitle(doc: PDFKit.PDFDocument, text: string, y: number): number {
  doc.font("Helvetica-Bold").fontSize(7.5).fillColor(MUTED).text(text.toUpperCase(), PAGE.margin, y);
  return doc.y + 4;
}

/** A two-column key/value block; returns the `y` below it. */
export function keyValueBlock(
  doc: PDFKit.PDFDocument,
  rows: { label: string; value: string }[],
  y: number,
): number {
  const labelWidth = CONTENT_WIDTH * 0.3;
  let cursor = y;

  for (const row of rows) {
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(row.label, PAGE.margin, cursor, {
      width: labelWidth,
    });
    const labelBottom = doc.y;
    doc.font("Helvetica").fillColor(INK).text(row.value, PAGE.margin + labelWidth + 6, cursor, {
      width: CONTENT_WIDTH - labelWidth - 6,
    });
    cursor = Math.max(labelBottom, doc.y) + 1;
  }
  return cursor;
}

/**
 * A table that repeats its header when it flows onto a new page, and draws an `emphasis` row
 * (a total) bold above a heavier rule.
 */
export function drawTable(
  doc: PDFKit.PDFDocument,
  columns: TableColumn[],
  rows: TableRow[],
  y: number,
  /** `false` for a continuation block (a totals table) that must not repeat the header row. */
  showHeader = true,
): number {
  let cursor = y;
  const total = columns.reduce((sum, column) => sum + column.width, 0);
  const scale = CONTENT_WIDTH / total;

  const drawHeaderRow = () => {
    if (!showHeader) return;
    doc.rect(PAGE.margin, cursor, CONTENT_WIDTH, 15).fill(HEADER_FILL);
    let x = PAGE.margin + 4;
    doc.font("Helvetica-Bold").fontSize(8).fillColor(INK);
    for (const column of columns) {
      const width = column.width * scale - 8;
      doc.text(column.header, x, cursor + 4.5, {
        width,
        align: column.align ?? "left",
      });
      x += column.width * scale;
    }
    cursor += 15;
  };

  drawHeaderRow();

  for (const row of rows) {
    const height = 15;
    // A row that would cross the bottom margin starts a new page, header and all.
    if (cursor + height > PAGE.height - PAGE.margin - 60) {
      doc.addPage();
      cursor = PAGE.margin;
      drawHeaderRow();
    }

    let x = PAGE.margin + 4;
    doc.font(row.emphasis ? "Helvetica-Bold" : "Helvetica").fontSize(8.5).fillColor(INK);
    for (const [index, column] of columns.entries()) {
      const width = column.width * scale - 8;
      doc.text(row.cells[index] ?? "", x, cursor + 4, {
        width,
        align: column.align ?? "left",
      });
      x += column.width * scale;
    }

    cursor += height;
    doc.moveTo(PAGE.margin, cursor).lineTo(PAGE.width - PAGE.margin, cursor)
      .lineWidth(row.emphasis ? 0.8 : 0.4)
      .strokeColor(row.emphasis ? INK : RULE).stroke();
  }

  return cursor + 6;
}

/** Plain paragraphs, e.g. payment instructions. */
export function drawNote(doc: PDFKit.PDFDocument, text: string, y: number): number {
  doc.font("Helvetica").fontSize(8.5).fillColor(MUTED)
    .text(text, PAGE.margin, y, { width: CONTENT_WIDTH });
  return doc.y + 4;
}

/**
 * Footers, page numbers and the watermark go on **every** page, which is why this is called
 * once after the body is built rather than inside it.
 *
 * The watermark is drawn last so it sits over everything, and lightly, so the document stays
 * readable underneath it.
 */
export function finishPages(doc: PDFKit.PDFDocument, meta: PdfMeta): number {
  const range = doc.bufferedPageRange();

  for (let index = range.start; index < range.start + range.count; index += 1) {
    doc.switchToPage(index);

    if (meta.watermark) {
      doc.save();
      doc.rotate(-30, { origin: [PAGE.width / 2, PAGE.height / 2] });
      doc.font("Helvetica-Bold").fontSize(96).fillColor("#000000").opacity(0.08)
        .text(meta.watermark, 0, PAGE.height / 2 - 60, {
          width: PAGE.width,
          align: "center",
        });
      doc.opacity(1);
      doc.restore();
    }

    const footerY = PAGE.height - PAGE.margin + 6;
    doc.moveTo(PAGE.margin, footerY - 6).lineTo(PAGE.width - PAGE.margin, footerY - 6)
      .lineWidth(0.4).strokeColor(RULE).stroke();

    // The footer deliberately sits in the bottom margin. PDFKit starts a new page whenever a
    // `text()` call begins below the bottom margin, so the margin is lifted for these two
    // calls — without this, drawing an n-page footer makes each page add another one.
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    try {
      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
        .text(meta.footerNote, PAGE.margin, footerY, { width: CONTENT_WIDTH * 0.72 });

      doc.font("Helvetica").fontSize(7.5).fillColor(MUTED)
        .text(
          `${meta.generated} · Page ${index - range.start + 1} of ${range.count}`,
          PAGE.margin + CONTENT_WIDTH * 0.72,
          footerY,
          { width: CONTENT_WIDTH * 0.28, align: "right" },
        );
    } finally {
      doc.page.margins.bottom = bottomMargin;
    }
  }

  return range.count;
}
