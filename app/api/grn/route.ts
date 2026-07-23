// Backend route for the GRN feature: accepts a GRN / Container Load Plan PDF,
// extracts every roll via Google Gemini, and returns a flat GrnRoll[].
//
// A GRN groups received rolls by container. Each roll has GSM, Roll No. (batch),
// Width and Weight. We flatten all containers/pages into one list in reading
// order; the client converts weight → qty and produces the CSV.

import { GoogleGenAI, Type } from "@google/genai";
import { z } from "zod";
import { GrnRoll } from "@/lib/grn";

export const runtime = "nodejs";
export const maxDuration = 300;

// ── Gemini output schema ──────────────────────────────────────

const ZRoll = z.object({
  gsm: z.string(),
  batch: z.string(),
  width: z.string(),
  weight: z.string(),
});

const ZGrn = z.object({
  officialRolls: z.string(),
  officialKgs: z.string(),
  rolls: z.array(ZRoll),
});

type Grn = z.infer<typeof ZGrn>;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    officialRolls: { type: Type.STRING },
    officialKgs: { type: Type.STRING },
    rolls: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          gsm: { type: Type.STRING },
          batch: { type: Type.STRING },
          width: { type: Type.STRING },
          weight: { type: Type.STRING },
        },
        required: ["gsm", "batch", "width", "weight"],
        propertyOrdering: ["gsm", "batch", "width", "weight"],
      },
    },
  },
  required: ["officialRolls", "officialKgs", "rolls"],
};

const SYSTEM_PROMPT = `You are a meticulous data-extraction engine for an ERP goods-received pipeline.

You will receive a GRN / CONTAINER LOAD PLAN PDF (often a scanned image). It lists received ROLLS grouped by CONTAINER. Multiple containers appear side-by-side on each page, and there are many pages. Extract EVERY roll from EVERY container on EVERY page. Accuracy and completeness are the top priority. Transcribe every number EXACTLY as written — do NOT clean, round, translate, or reformat.

────────────────────────
DOCUMENT LAYOUT
────────────────────────
• The page header shows document totals such as "24 CONTAINERS", "536 ROLLS", "546,344 KGS".
• Below that, containers are laid out in COLUMNS across the page (e.g. 3 containers side-by-side).
• Each container has a small header (its container id, e.g. "BEAU4656885", and its own roll count + KGS) followed by a table whose columns are:
      GSM | ROLL NO. | WIDTH | WEIGHT
  (Some blocks may repeat these headers. A "MSR" or grade label may precede GSM — ignore it.)

────────────────────────
WHAT TO EXTRACT
────────────────────────
• officialRolls : The grand total ROLL count from the document header (e.g. "536"). Empty string if absent.
• officialKgs   : The grand total KGS from the document header (e.g. "546,344"). Empty string if absent.
• rolls         : One entry PER ROLL, for every container and page. Each entry:
      – gsm    : The GSM value for the roll (e.g. "160", "200"). Digits only as written.
      – batch  : The ROLL NO. exactly as written (e.g. "4160134833"). This becomes "xbatch".
      – width  : The WIDTH exactly as written (e.g. "1150", "1300").
      – weight : The WEIGHT exactly as written, usually in KG (e.g. "817", "1374").

────────────────────────
READING ORDER
────────────────────────
Process one container fully (top row to bottom row) before moving to the next. Go left container, then middle, then right, then continue on the next page. Preserve this order in the rolls array.

────────────────────────
GENERAL RULES
────────────────────────
• Do NOT skip any roll. Do NOT invent rolls. The number of rolls you output should match officialRolls.
• Transcribe digits exactly; never round or "fix" a number.
• Ignore per-container subtotal/summary lines — only emit actual roll rows.
• Do not include commentary.`;

// ── Helpers (shared style with the order-sheet route) ─────────

function jsonError(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isTransient(err: unknown): boolean {
  const text = (err instanceof Error ? err.message : String(err)) || "";
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

function parseNum(s: string): number {
  const n = parseFloat((s ?? "").replace(/,/g, "").trim());
  return isNaN(n) ? 0 : n;
}

function buildWarnings(doc: Grn): string[] {
  const warnings: string[] = [];
  const official = parseNum(doc.officialRolls);
  if (official > 0 && doc.rolls.length !== official) {
    warnings.push(
      `Extracted ${doc.rolls.length} rolls but the document header says ${official}. Please spot-check the result.`,
    );
  }
  const officialKgs = parseNum(doc.officialKgs);
  if (officialKgs > 0) {
    const sum = doc.rolls.reduce((a, r) => a + parseNum(r.weight), 0);
    if (Math.abs(sum - officialKgs) / officialKgs > 0.02) {
      warnings.push(
        `Total weight ${sum.toLocaleString()} kg differs from the header total ${officialKgs.toLocaleString()} kg by more than 2%.`,
      );
    }
  }
  return warnings;
}

// ── POST ──────────────────────────────────────────────────────

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
              { inlineData: { mimeType: "application/pdf", data: base64 } },
              {
                text: "Extract every roll from this GRN / container load plan PDF according to the instructions.",
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
    if (!text) return jsonError("Model returned no extractable content.", 502);

    let rawResult: unknown;
    try {
      rawResult = JSON.parse(text);
    } catch {
      return jsonError("Model output was not valid JSON.", 502);
    }

    const validated = ZGrn.safeParse(rawResult);
    if (!validated.success) {
      return jsonError(
        `Model output did not match expected schema: ${validated.error.message}`,
        502,
      );
    }

    const rolls: GrnRoll[] = validated.data.rolls;
    const warnings = buildWarnings(validated.data);

    return new Response(JSON.stringify({ rolls, warnings }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return jsonError(`Extraction failed: ${message}`, 500);
  }
}
