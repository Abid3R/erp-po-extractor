// Backend route: accepts an uploaded PDF, extracts raw document structure via
// Google Gemini, then flattens it into NEUTRAL RawLineItem[] — one row per
// (fabric-column × color) — applying NO company-specific formatting.
//
// All company choices (which GSM, clean vs full color, style-code vs PO,
// item codes, Work-Type column, etc.) are applied later, client-side, by
// lib/transform.ts using a CompanyConfig. This lets the user re-generate the
// CSV for any company — and re-do it with different settings — without ever
// re-analyzing the PDF.
//
// Universal (non-company) rules kept here:
//   • Build a fabric metadata dictionary from the intro block.
//   • Map each table column to a fabric metadata entry.
//   • Emit one raw item per (fabric-column × color) where qty > 0.
//   • Validate per-column sums against official totals; auto-correct OCR typos.
//   • Carry BOTH the heading GSM and the metadata GSM so the config can pick.

import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import { RawLineItem } from "@/lib/schema";

export const runtime = "nodejs";
export const maxDuration = 300;

// ─────────────────────────────────────────────────────────────
// Zod schemas for Gemini's intermediate output
// ─────────────────────────────────────────────────────────────

const ZFabricMeta = z.object({
  fabricName: z.string(),
  itemCode: z.string(),
  composition: z.string(),
  gsm: z.string(),
  width: z.string(),
  specialInstruction: z.string(),
  unitPrice: z.string(),
});

const ZFabricColumn = z.object({
  headerText: z.string(),
  fabricName: z.string(),
});

const ZColorRow = z.object({
  color: z.string(),
  quantities: z.array(z.string()),
  unitPrice: z.string(),
});

const ZTable = z.object({
  heading: z.string(),
  bookingNumber: z.string(),
  styleCode: z.string(),
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
          itemCode: { type: Type.STRING },
          composition: { type: Type.STRING },
          gsm: { type: Type.STRING },
          width: { type: Type.STRING },
          specialInstruction: { type: Type.STRING },
          unitPrice: { type: Type.STRING },
        },
        required: [
          "fabricName",
          "itemCode",
          "composition",
          "gsm",
          "width",
          "specialInstruction",
          "unitPrice",
        ],
        propertyOrdering: [
          "fabricName",
          "itemCode",
          "composition",
          "gsm",
          "width",
          "specialInstruction",
          "unitPrice",
        ],
      },
    },
    tables: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          heading: { type: Type.STRING },
          bookingNumber: { type: Type.STRING },
          styleCode: { type: Type.STRING },
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
                unitPrice: { type: Type.STRING },
              },
              required: ["color", "quantities", "unitPrice"],
              propertyOrdering: ["color", "quantities", "unitPrice"],
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
          "styleCode",
          "gsmFromHeading",
          "fabricColumns",
          "colorRows",
          "officialColumnTotals",
        ],
        propertyOrdering: [
          "heading",
          "bookingNumber",
          "styleCode",
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

You will receive a purchase order PDF (which may be a scanned image). Extract the document structure exactly as described. Accuracy is the top priority. Transcribe values EXACTLY as written — do NOT clean, reformat, translate, round, or normalize anything. Downstream software applies any company-specific formatting.

────────────────────────
STEP 1 – Header fields
────────────────────────
• stylePo       : Document-level Style/PO number or order reference (e.g., "CZ 02/2025", "SS26LO395-02 (2nd)"). Transcribe exactly, including any suffix. Usually at the top.
• requestedDate : Required delivery date exactly as written. Empty string if absent.

────────────────────────────────────────────────
STEP 2 – Fabric metadata (from the intro block)
────────────────────────────────────────────────
Read the descriptive text that appears BEFORE the tables. For each distinct fabric type, extract one entry:

• fabricName         : Fabric type name as written (e.g., "Fleece", "Rib", "Single Jersey"). Do NOT rename or expand it.
• itemCode           : Any item/product/style code shown for this fabric (e.g., "FG-00003"). Empty string if absent.
• composition        : Fibre composition exactly as written (e.g., "60% Cotton 40% Polyester", "100% Cotton"). Empty string if absent.
• gsm                : GSM value for this fabric as given in the metadata block (e.g., "280/290"). Empty string if absent.
• width              : Width specification exactly as written (e.g., \`74"/76" OPEN\`, "72 Inch Open"). Empty string if absent.
• specialInstruction : Special production notes for this fabric, exactly as written.
                       – Join multiple separate notes with " & ".
                       – Do NOT include a trailing period or comma.
                       – Empty string if none.
• unitPrice          : Unit price/rate for this fabric if shown (e.g., "2.10"). Empty string if absent.

────────────────────────────────────────────────
STEP 3 – Tables
────────────────────────────────────────────────
For EACH separate booking/order table in the document:

• heading              : Full table heading exactly as written (e.g., "FABRIC BOOKING 1 280/290 GSM").
• bookingNumber        : The sequential booking/table number from the heading.
                         E.g., "FABRIC BOOKING 1 280/290 GSM" → "1". Empty string if none.
• styleCode            : The style/order code specific to THIS booking table (e.g., "MS09B", "LS400B"),
                         taken from the table heading or its style row. Empty string if none.
• gsmFromHeading       : GSM value extracted from THIS table's heading (e.g., "280/290"). Empty string if absent.
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
                           – color      : The FULL color/shade cell EXACTLY as written, INCLUDING any
                                          Pantone / lab / dye codes and suffixes. Do NOT strip anything.
                                          Examples (transcribe verbatim):
                                            "NERO-253018-C - D Black"
                                            "LUCENT WHITE 11-0700 TCX"
                                            "BLU SPACE"
                           – quantities : Array PARALLEL to fabricColumns.
                                          Transcribe EXACTLY as shown, including commas (e.g., "1,452").
                                          Use "0" for empty or zero cells.
                           – unitPrice  : The unit price / rate shown for THIS color row, if the table
                                          lists a price per colour/shade (e.g., "55", "153", "2.10").
                                          Transcribe exactly. Empty string if this row has no price.
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

/** Build a FabricMeta entry from a column header (fallback when lookup fails). */
function metaFromHeader(headerText: string, fallbackGsm: string): FabricMeta {
  const gsmMatch = headerText.match(/(\d+(?:[/\-]\d+)?)\s*GSM/i);
  const name = headerText
    .replace(/\(.*?\)/g, "")
    .replace(/\d+(?:[/\-]\d+)?\s*GSM/gi, "")
    .trim();
  return {
    fabricName: name || headerText,
    itemCode: "",
    composition: "",
    gsm: gsmMatch ? gsmMatch[1] : fallbackGsm,
    width: "",
    specialInstruction: "",
    unitPrice: "",
  };
}

// ─────────────────────────────────────────────────────────────
// Math validation and OCR correction (universal, non-company)
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
// Build neutral RawLineItem[] from Gemini's document structure
// ─────────────────────────────────────────────────────────────

function buildRawItems(doc: DocumentStructure): {
  items: RawLineItem[];
  warnings: string[];
} {
  const allItems: RawLineItem[] = [];
  const allWarnings: string[] = [];

  // Case-insensitive metadata lookup keyed by fabricName.
  const metaMap = new Map<string, FabricMeta>(
    doc.fabricMetadata.map((m) => [m.fabricName.toLowerCase().trim(), m]),
  );

  for (const table of doc.tables) {
    const { heading, fabricColumns, colorRows, officialColumnTotals } = table;

    const headingGsm =
      table.gsmFromHeading.trim() || extractGsmFromText(heading);

    const parsedTotals = officialColumnTotals.map(parseQty);

    const rawMatrix: number[][] = colorRows.map((cr) => {
      const qtys = cr.quantities.map(parseQty);
      while (qtys.length < fabricColumns.length) qtys.push(0);
      return qtys;
    });

    const correctedMatrix: number[][] = rawMatrix.map((row) => [...row]);

    // Validate and correct one column at a time.
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

    // Emit one raw item per (fabricColumn × colorRow) where qty > 0.
    // Outer loop = fabric columns → all colors for one fabric are grouped.
    for (let colIdx = 0; colIdx < fabricColumns.length; colIdx++) {
      const fabCol = fabricColumns[colIdx];

      // Resolve fabric metadata by name; fall back to header parsing.
      const meta =
        metaMap.get(fabCol.fabricName.toLowerCase().trim()) ??
        metaFromHeader(fabCol.headerText, headingGsm);

      for (let rowIdx = 0; rowIdx < colorRows.length; rowIdx++) {
        const colorRow = colorRows[rowIdx];
        const qty = correctedMatrix[rowIdx][colIdx];
        if (qty <= 0) continue;

        allItems.push({
          fabricName: meta.fabricName || fabCol.fabricName,
          itemCode: meta.itemCode,
          documentPo: doc.stylePo,
          bookingNumber: table.bookingNumber,
          styleCode: table.styleCode,
          composition: meta.composition,
          gsmHeading: headingGsm,
          gsmMetadata: meta.gsm,
          width: meta.width,
          colorFull: colorRow.color,
          specialInstruction: meta.specialInstruction,
          // Prefer a per-colour price; fall back to the fabric's price.
          unitPrice: colorRow.unitPrice?.trim() || meta.unitPrice,
          requestedDate: doc.requestedDate,
          qty: String(qty),
        });
      }
    }
  }

  return { items: allItems, warnings: allWarnings };
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

    const { items, warnings } = buildRawItems(validated.data);

    return new Response(JSON.stringify({ items, warnings }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonError(`Extraction failed: ${message}`, 500);
  }
}
