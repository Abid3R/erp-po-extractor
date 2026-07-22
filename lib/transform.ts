// Pure, client-side transform: RawLineItem[] + CompanyConfig → final CSV rows.
//
// This is the "Redo" engine. Nothing here touches the network or the model, so
// the user can tweak a CompanyConfig and instantly regenerate the CSV to a
// company's exact preferences from the already-extracted raw data.

import { COLUMNS, ColumnDef, ExtractedRow, RawLineItem } from "./schema";
import { CompanyConfig } from "./config";

/** Clean a color/shade string down to its pure name (drop Pantone/lab codes).
 *  Everything from the first digit onward is removed, then trailing
 *  separators are trimmed.
 *    "NERO-253018-C - D Black"        → "NERO"
 *    "STONE WHITE-253174-B-D0.09/487" → "STONE WHITE"
 *    "LUCENT WHITE 11-0700 TCX"        → "LUCENT WHITE"
 *    "BLU SPACE"                       → "BLU SPACE" (unchanged) */
export function cleanColor(raw: string): string {
  const t = (raw ?? "").trim();
  const idx = t.search(/\d/);
  const head = idx === -1 ? t : t.slice(0, idx);
  const cleaned = head.replace(/[\s\-–]+$/, "").trim();
  return cleaned || t;
}

/** Normalize a width string: strip inch quotes and turn OPEN[ DIA] into
 *  "Inch Open".
 *    `74"/76" OPEN`   → "74/76 Inch Open"
 *    `68/70" OPEN DIA` → "68/70 Inch Open" */
export function normalizeWidth(raw: string): string {
  const w = (raw ?? "").replace(/["“”]/g, "");
  // Turn a standalone "OPEN" (optionally "OPEN DIA") into "Inch Open", but skip
  // any "Open" that is already part of "Inch Open" so the function is idempotent.
  return w
    .replace(/(?<!Inch\s)\bOPEN(?:\s+DIA)?\b/gi, "Inch Open")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip a trailing parenthetical, e.g. "SS26LO395-02 (2nd)" → "SS26LO395-02". */
function stripSuffix(s: string): string {
  return s.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** The columns emitted for this config. A column is dropped when it is marked
 *  removed in columnOverrides (or, for Work-Type, via the legacy toggle). */
export function activeColumns(cfg: CompanyConfig): ColumnDef[] {
  const ov = cfg.columnOverrides ?? {};
  return COLUMNS.filter((c) => {
    if (ov[c.key]?.removed) return false;
    if (c.key === "workType" && !cfg.includeWorkType) return false;
    return true;
  });
}

/** Compute the extracted baseline for one item (preset smarts applied, but NOT
 *  the per-column override layer). This is the value the per-value remap and the
 *  column editor treat as "Extracted". */
function baselineRow(item: RawLineItem, cfg: CompanyConfig): ExtractedRow {
    const key = item.fabricName.toLowerCase().trim();

    // Fabric name & item code (config lookups take precedence over PDF values).
    const fabricName = cfg.fabricNameMap[key] ?? item.fabricName;
    const itemCode = cfg.itemCodeMap[key] ?? item.itemCode ?? "";

    // Style / PO source.
    let stylePo: string;
    switch (cfg.stylePoSource) {
      case "styleCode":
        stylePo = item.styleCode || item.documentPo;
        break;
      case "bookingNumber":
        stylePo = item.bookingNumber || item.documentPo;
        break;
      default:
        stylePo = item.documentPo;
    }
    if (cfg.stylePoStripSuffix) stylePo = stripSuffix(stylePo);

    // GSM source.
    const gsm =
      cfg.gsmSource === "heading"
        ? item.gsmHeading || item.gsmMetadata
        : item.gsmMetadata || item.gsmHeading;

    // Color.
    const colorCode =
      cfg.colorMode === "clean" ? cleanColor(item.colorFull) : item.colorFull;

    // Width.
    const width =
      cfg.widthMode === "normalize" ? normalizeWidth(item.width) : item.width;

    // Special instruction.
    let specialInstruction: string;
    switch (cfg.specialMode) {
      case "blank":
        specialInstruction = "";
        break;
      case "fixed":
        specialInstruction = cfg.specialFixedValue;
        break;
      default:
        specialInstruction = item.specialInstruction;
    }

    const unitPrice = item.unitPrice || cfg.defaultUnitPrice;

    return {
      itemName: fabricName,
      itemCode,
      stylePo,
      composition: item.composition,
      gsm,
      stitchLength: "",
      width,
      size: "",
      colorCode,
      specialInstruction,
      qty: item.qty,
      qtyUnit: cfg.qtyUnit,
      unitPrice,
      requestedDate: item.requestedDate,
      backorderType: cfg.backorderType,
      workType: cfg.workTypeValue,
    };
}

/** The extracted baseline rows (before the per-column override layer). Used by
 *  the UI to list each column's distinct values for per-value remapping. */
export function baselineRows(
  items: RawLineItem[],
  cfg: CompanyConfig,
): ExtractedRow[] {
  return items.map((item) => baselineRow(item, cfg));
}

/** Apply a company config to the neutral raw items to produce final rows.
 *  Order per column: extracted baseline → per-value remap → custom / blank. */
export function applyConfig(
  items: RawLineItem[],
  cfg: CompanyConfig,
): ExtractedRow[] {
  const ov = cfg.columnOverrides ?? {};
  return items.map((item) => {
    const baseline = baselineRow(item, cfg);
    const row = { ...baseline } as ExtractedRow;
    for (const c of COLUMNS) {
      const o = ov[c.key];
      if (!o) continue;
      if (o.mode === "blank") {
        row[c.key] = "";
      } else if (o.mode === "custom") {
        row[c.key] = o.value;
      } else {
        // Extracted mode: remap this specific value if the user renamed it.
        const mapped = o.valueMap?.[baseline[c.key]];
        if (mapped) row[c.key] = mapped;
      }
    }
    return row;
  });
}
