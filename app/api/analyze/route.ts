// Backend route: accepts an uploaded PDF, extracts raw document structure via
// Google Gemini, then applies 5 universal rules server-side to produce
// ERP-ready rows keyed exactly like lib/schema.ts.
//
// Rule 1 – Build fabric metadata dictionary from the intro block.
// Rule 2 – Map each table column to a fabric metadata entry.
// Rule 3 – Emit one output row per (fabric-column × color) pair where qty > 0.
// Rule 4 – Validate per-column sums against official totals; auto-correct OCR typos.
// Rule 5 – Infer GSM from heading; default Qty Unit = KG.
//
// Hardcoded company defaults:
//   Work-Type    = "Full Order"
//   Backorder    = "Order Now"
//   "Rib"        → renamed to "2X2 LYCRA RIB"
//   Item codes   = FG-00003 (Fleece), FG-00007 (2X2 LYCRA RIB), FG-00010 (Single Jersey)

import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import { ExtractedRow } from "@/lib/schema";

export const runtime = "nodejs";
export const maxDuration = 300;

// ─────────────────────────────────────────────────────────────
// Hardcoded company-specific lookups
// ─────────────────────────────────────────────────────────────

/** Normalise fabric names to company-standard names. */
function normalizeFabricName(raw: string): string {
  const t = raw.trim();
  if (/^rib$/i.test(t)) return "2X2 LYCRA RIB";
  return t;
}

/** Return the company item code for a (normalised) fabric name. */
const ITEM_CODE_MAP: Record<string, string> = {
  "fleece": "FG-00003",
  "2x2 lycra rib": "FG-00007",
  "single jersey": "FG-00010",
};

function getItemCode(fabricName: string): string {
  return ITEM_CODE_MAP[fabricName.toLowerCase().trim()] || "";
}

// ─────────────────────────────────────────────────────────────
// Zod schemas for Gemini's intermediate output
// ─────────────────────────────────────────────────────────────

const ZFabricMeta = z.object({
  fabricName: z.string(),
  composition: z.string(),
  gsm: z.string(),
  width: z.string(),
  specialInstruction: z.string(),
});

const ZFabricColumn = z.object({
  headerText: z.string(),
  fabricName: z.string(),
});

const ZColorRow = z.object({
  color: z.string(),
  quantities: z.array(z.string()),
});

const ZTable = z.object({
  heading: z.string(),
  bookingNumber: z.string(),
  gsmFromHeading: z.string(),
  fabricColumns: z.array(ZFabricColumn),
  colorRows: z.array(ZColorRow),
  officialColumnTotals: z.array(z.string()),
});

const ZDocumentStructure = z.object({
  stylePo: z.string(),
  requestedDate: z.string(),
  fabricMetadata: z.array(ZFabricMeta),
  tables: z.array(ZTable),
});

type FabricMeta = z.infer<typeof ZFabricMeta>;
type DocumentStructure = z.infer<typeof ZDocumentStructure>;

// ─────────────────────────────────────────────────────────────
// Gemini responseSchema (OpenAPI subset, mirrors ZDocumentStructure)
// ─────────────────────────────────────────────────────────────

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    stylePo: { type: Type.STRING },
    requestedDate: { type: Type.STRING },
    fabricMetadata: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          fabricName: { type: Type.STRING },
          composition: { type: Type.STRING },
          gsm: { type: Type.STRING },
          width: { type: Type.STRING },
          specialInstruction: { type: Type.STRING },
        },
        required: ["fabricName", "composition", "gsm", "width", "specialInstruction"],
        propertyOrdering: ["fabricName", "composition", "gsm", "width", "specialInstruction"],
      },
    },
    tables: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          heading: { type: Type.STRING },
          bookingNumber: { type: Type.STRING },
          gsmFromHeading: { type: Type.STRING },
          fabricColumns: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                headerText: { type: Type.STRING },
                fabricName: { type: Type.STRING },
              },
              required: ["headerText", "fabricName"],
              propertyOrdering: ["headerText", "fabricName"],
            },
          },
          colorRows: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                color: { type: Type.STRING },
                quantities: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
              },
              required: ["color", "quantities"],
              propertyOrdering: ["color", "quantities"],
            },
          },
          officialColumnTotals: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: [
          "heading",
          "bookingNumber",
          "gsmFromHeading",
          "fabricColumns",
          "colorRows",
          "officialColumnTotals",
        ],
        propertyOrdering: [
          "heading",
          "bookingNumber",
          "gsmFromHeading",
          "fabricColumns",
          "colorRows",
          "officialColumnTotals",
        ],
      },
    },
  },
  required: ["stylePo", "requestedDate", "fabricMetadata", "tables"],
};

// ─────────────────────────────────────────────────────────────
// System prompt
// ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a meticulous data-extraction engine for an ERP purchase-order pipeline.

You will receive a purchase order PDF (which may be a scanned image). Extract the document structure exactly as described. Accuracy is the top priority.

────────────────────────
STEP 1 – Header fields
────────────────────────
• stylePo       : Style/PO number or order reference code (e.g., "13-26-1-103"). Usually at the top.
• requestedDate : Required delivery date exactly as written. Empty string if absent.

────────────────────────────────────────────────
STEP 2 – Fabric metadata (from the intro block)
────────────────────────────────────────────────
Read the descriptive text that appears BEFORE the tables. For each distinct fabric type, extract one entry:

• fabricName         : Fabric type name as written (e.g., "Fleece", "Rib", "Single Jersey").
• composition        : Fibre composition (e.g., "80% Cotton 20% Polyester"). Empty string if absent.
• gsm                : GSM value (e.g., "280/290", "400", "160"). Empty string if absent.
• width              : Width specification matched to this fabric type (e.g., "72 Inch Open").
                       Empty string if absent.
• specialInstruction : Special production notes for this fabric.
                       – Join multiple notes with " & " (NOT with a comma or semicolon).
                       – Do NOT include a trailing period or comma.
                       – For Single Jersey fabric, always set this to "Single Jersey".
                       – Empty string if none.

────────────────────────────────────────────────
STEP 3 – Tables
────────────────────────────────────────────────
For EACH separate booking/order table in the document:

• heading              : Full table heading exactly as written (e.g., "FABRIC BOOKING 1 280/290 GSM").
• bookingNumber        : The sequential booking or table number from the heading.
                         E.g., "FABRIC BOOKING 1 280/290 GSM" → "1".
                         E.g., "FABRIC BOOKING 2 330/340 GSM" → "2".
                         Empty string if no sequential number is present.
• gsmFromHeading       : GSM value extracted from the heading (e.g., "280/290"). Empty string if absent.
• fabricColumns        : Array of FABRIC-TYPE columns ONLY.
                         ► EXCLUDE the COLOR/SHADE column.
                         ► EXCLUDE any TOTAL or GRAND TOTAL column.
                         Each entry:
                           – headerText : Exact column header (e.g., "FABRIC (280/290 GSM)", "RIB (400 GSM)").
                           – fabricName : Fabric name this column maps to (e.g., "Fleece", "Rib").
• colorRows            : One entry per COLOR/SHADE data row.
                         ► EXCLUDE header rows.
                         ► EXCLUDE the TOTAL/SUMMARY row (put those in officialColumnTotals).
                         Each entry:
                           – color      : Extract ONLY the pure color name — strip any dye/lab codes,
                                          alphanumeric suffixes, or percentage annotations.
                                          The color name is the leading word(s) of letters and spaces only.
                                          Strip everything after the first hyphen-then-digit pattern or
                                          space-then-4+-consecutive-digits pattern.
                                          Examples:
                                            "NERO-253018-C - D Black"        → "NERO"
                                            "STONE WHITE-253174-B-D0.09/487" → "STONE WHITE"
                                            "NOCE 253025-C-D1.6%"            → "NOCE"
                                            "BLU 253175-A D-57."             → "BLU"
                                            "BLU SPACE"                      → "BLU SPACE"
                                            "BRANDY BROWN"                   → "BRANDY BROWN"
                           – quantities : Array PARALLEL to fabricColumns.
                                          Transcribe EXACTLY as shown, including commas (e.g., "1,452").
                                          Use "0" for empty or zero cells.
• officialColumnTotals : Array PARALLEL to fabricColumns with the total quantities from the
                         TOTAL/SUMMARY row. Transcribe exactly as written.

────────────────────────
GENERAL RULES
────────────────────────
• Transcribe ALL numbers exactly — do NOT clean, round, or correct them.
• Use "0" for blank cells.
• Maintain exact parallel ordering: fabricColumns, colorRows[i].quantities, and officialColumnTotals
  must all have the same length and same column order.
• If the document has multiple distinct tables, emit each as a separate entry in the tables array.
• Do not include commentary.`;

// ─────────────────────────────────────────────────────────────
// Utility helpers
// ─────────────────────────────────────────────────────────────

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransient(err: unknown): boolean {
  const text = (err instanceof Error ? err.message : String(err)) || "";
  // 429 with "limit: 0" = permanent zero quota for this API key — do NOT retry.
  if (text.includes("limit: 0")) return false;
  return (
    text.includes("503") ||
    text.includes("UNAVAILABLE") ||
    text.includes("overloaded") ||
    text.includes("high demand") ||
    text.includes("429") ||
    text.includes("RESOURCE_EXHAUSTED") ||
    text.includes("rate limit")
  );
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 12): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isTransient(err)) throw err;
      const delay = 3000 * 2 ** Math.min(i, 4) + Math.floor(Math.random() * 1000);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/** Parse a raw quantity string (may contain commas) to a number. */
function parseQty(s: string): number {
  if (!s || s.trim() === "" || s.trim() === "0") return 0;
  const n = parseFloat(s.replace(/,/g, "").trim());
  return isNaN(n) ? 0 : n;
}

/** Extract a GSM substring from a heading like "FABRIC BOOKING 280/290 GSM". */
function extractGsmFromText(text: string): string {
  const m = text.match(/(\d+(?:[/\-]\d+)?)\s*GSM/i);
  return m ? m[1] : "";
}

/** Build a FabricMeta entry from a column header (fallback when metadata lookup fails). */
function metaFromHeader(headerText: string, fallbackGsm: string): FabricMeta {
  const gsmMatch = headerText.match(/(\d+(?:[/\-]\d+)?)\s*GSM/i);
  const name = headerText
    .replace(/\(.*?\)/g, "")
    .replace(/\d+(?:[/\-]\d+)?\s*GSM/gi, "")
    .trim();
  return {
    fabricName: name || headerText,
    composition: "",
    gsm: gsmMatch ? gsmMatch[1] : fallbackGsm,
    width: "",
    specialInstruction: "",
  };
}

/**
 * Strip lab/dye codes appended to color names.
 * E.g.: "NERO-253018-C - D Black"        → "NERO"
 *        "STONE WHITE-253174-B-D0.09/487" → "STONE WHITE"
 *        "NOCE 253025-C-D1.6%"            → "NOCE"
 *        "BLU 253175-A D-57."             → "BLU"
 *        "BLU SPACE"                      → "BLU SPACE"  (unchanged)
 */
function cleanColorName(raw: string): string {
  const s = raw.trim();
  const m = s.match(/^([A-Za-z][A-Za-z\s]*?)(?:\s*-\s*\d|\s+\d{4,})/);
  if (m) return m[1].trim();
  return s;
}

// ─────────────────────────────────────────────────────────────
// Rule 4 – Math validation and OCR correction
// ─────────────────────────────────────────────────────────────

function digitOverlap(a: number, b: number): number {
  const da = String(Math.abs(Math.round(a))).split("");
  const db = String(Math.abs(Math.round(b))).split("");
  let count = 0;
  for (const d of da) {
    const idx = db.indexOf(d);
    if (idx !== -1) {
      count++;
      db.splice(idx, 1);
    }
  }
  return count;
}

function validateAndCorrect(
  quantities: number[],
  officialTotal: number,
): { corrected: number[]; warning: string | null } {
  const sum = quantities.reduce((a, b) => a + b, 0);
  const delta = officialTotal - sum;

  if (Math.abs(delta) < 0.5) return { corrected: quantities, warning: null };

  const corrected = [...quantities];

  if (delta < 0) {
    const candidates = quantities
      .map((q, i) => ({ i, q, fixed: Math.round(q + delta) }))
      .filter((c) => c.fixed >= 0);

    if (candidates.length > 0) {
      const outlier = candidates.reduce((a, b) => (a.q > b.q ? a : b));
      corrected[outlier.i] = outlier.fixed;
      return {
        corrected,
        warning: `OCR correction (extra digit): ${outlier.q} → ${outlier.fixed} (delta ${delta})`,
      };
    }
  } else {
    const candidates = quantities.map((q, i) => {
      const fixed = Math.round(q + delta);
      return { i, q, fixed, overlap: digitOverlap(q, fixed) };
    });

    if (candidates.length > 0) {
      const outlier = candidates.reduce((a, b) => {
        if (a.overlap !== b.overlap) return a.overlap > b.overlap ? a : b;
        return a.q < b.q ? a : b;
      });
      corrected[outlier.i] = outlier.fixed;
      return {
        corrected,
        warning: `OCR correction (misread): ${outlier.q} → ${outlier.fixed} (delta +${delta})`,
      };
    }
  }

  return {
    corrected: quantities,
    warning: `Math mismatch: extracted sum ${sum} ≠ official total ${officialTotal} (delta ${delta}) — could not auto-correct`,
  };
}

// ─────────────────────────────────────────────────────────────
// Rules 1–5: build ExtractedRow[] from Gemini's document structure
// ─────────────────────────────────────────────────────────────

function buildRows(doc: DocumentStructure): {
  rows: ExtractedRow[];
  warnings: string[];
} {
  const allRows: ExtractedRow[] = [];
  const allWarnings: string[] = [];

  // Rule 1: build case-insensitive metadata lookup keyed by fabricName.
  const metaMap = new Map<string, FabricMeta>(
    doc.fabricMetadata.map((m) => [m.fabricName.toLowerCase().trim(), m]),
  );

  for (const table of doc.tables) {
    const { heading, fabricColumns, colorRows, officialColumnTotals } = table;

    // Rule 5: prefer Gemini's gsmFromHeading, fall back to regex extraction.
    const headingGsm =
      table.gsmFromHeading.trim() || extractGsmFromText(heading);

    const parsedTotals = officialColumnTotals.map(parseQty);

    const rawMatrix: number[][] = colorRows.map((cr) => {
      const qtys = cr.quantities.map(parseQty);
      while (qtys.length < fabricColumns.length) qtys.push(0);
      return qtys;
    });

    const correctedMatrix: number[][] = rawMatrix.map((row) => [...row]);

    // Rule 4: validate and correct one column at a time.
    for (let colIdx = 0; colIdx < fabricColumns.length; colIdx++) {
      const officialTotal = parsedTotals[colIdx] ?? 0;
      if (officialTotal === 0) continue;

      const colQtys = rawMatrix.map((row) => row[colIdx] ?? 0);
      const { corrected, warning } = validateAndCorrect(colQtys, officialTotal);

      if (warning) {
        allWarnings.push(
          `[${heading}] "${fabricColumns[colIdx].headerText}": ${warning}`,
        );
      }
      for (let rowIdx = 0; rowIdx < colorRows.length; rowIdx++) {
        correctedMatrix[rowIdx][colIdx] = corrected[rowIdx];
      }
    }

    // Rule 3: emit one ExtractedRow per (fabricColumn × colorRow) where qty > 0.
    // Outer loop = fabric columns → all colors for one fabric are grouped together.
    for (let colIdx = 0; colIdx < fabricColumns.length; colIdx++) {
      const fabCol = fabricColumns[colIdx];

      // Rule 2: resolve fabric metadata by name; fall back to header parsing.
      const meta =
        metaMap.get(fabCol.fabricName.toLowerCase().trim()) ??
        metaFromHeader(fabCol.headerText, headingGsm);

      // Apply company-specific fabric name normalisation ("Rib" → "2X2 LYCRA RIB").
      const fabricName = normalizeFabricName(meta.fabricName || fabCol.fabricName);
      const itemCode = getItemCode(fabricName);

      for (let rowIdx = 0; rowIdx < colorRows.length; rowIdx++) {
        const colorRow = colorRows[rowIdx];
        const qty = correctedMatrix[rowIdx][colIdx];
        if (qty <= 0) continue;

        const row: ExtractedRow = {
          itemName: fabricName,
          itemCode,
          stylePo: table.bookingNumber || doc.stylePo,
          composition: meta.composition,
          gsm: meta.gsm || headingGsm,
          stitchLength: "",
          width: meta.width,
          size: "",
          colorCode: cleanColorName(colorRow.color),
          specialInstruction: meta.specialInstruction,
          qty: String(qty),
          qtyUnit: "KG",
          unitPrice: "",
          requestedDate: "",
          backorderType: "Order Now",
          workType: "Full Order",
        };

        allRows.push(row);
      }
    }
  }

  return { rows: allRows, warnings: allWarnings };
}

// ─────────────────────────────────────────────────────────────
// POST handler
// ─────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return jsonError(
      "Server is missing GEMINI_API_KEY. Set it in .env.local.",
      500,
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return jsonError("Expected multipart/form-data with a 'file' field.", 400);
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return jsonError("No PDF file was provided in the 'file' field.", 400);
  }

  if (file.type && file.type !== "application/pdf") {
    return jsonError("Uploaded file must be a PDF.", 415);
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) {
    return jsonError("Uploaded PDF is empty.", 400);
  }

  const base64 = bytes.toString("base64");
  const ai = new GoogleGenAI({ apiKey });

  try {
    const response = await withRetry(() =>
      ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
        contents: [
          {
            role: "user",
            parts: [
              {
                inlineData: {
                  mimeType: "application/pdf",
                  data: base64,
                },
              },
              {
                text: "Extract the complete document structure from this purchase order PDF according to the instructions.",
              },
            ],
          },
        ],
        config: {
          systemInstruction: SYSTEM_PROMPT,
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema,
        },
      }),
    );

    const text = response.text;
    if (!text) {
      return jsonError("Model returned no extractable content.", 502);
    }

    let rawResult: unknown;
    try {
      rawResult = JSON.parse(text);
    } catch {
      return jsonError("Model output was not valid JSON.", 502);
    }

    const validated = ZDocumentStructure.safeParse(rawResult);
    if (!validated.success) {
      return jsonError(
        `Model output did not match expected schema: ${validated.error.message}`,
        502,
      );
    }

    const { rows, warnings } = buildRows(validated.data);

    return new Response(JSON.stringify({ rows, warnings }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonError(`Extraction failed: ${message}`, 500);
  }
}
