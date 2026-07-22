// Company-specific output configuration.
//
// The PDF is extracted ONCE into neutral RawLineItem[] (see lib/schema.ts).
// A CompanyConfig then controls how those raw items become the final CSV rows.
// Because the transform is pure and runs client-side, switching config and
// pressing "Redo" re-generates the CSV instantly — no re-upload, no re-analysis.
//
// This is why different companies (which want different things from the SAME
// kind of worksheet) no longer require editing code: pick or edit a preset.

import { COLUMNS } from "./schema";

export type StylePoSource = "styleCode" | "bookingNumber" | "documentPo";
export type GsmSource = "heading" | "metadata";
export type ColorMode = "full" | "clean";
export type WidthMode = "asExtracted" | "normalize";
export type SpecialMode = "asExtracted" | "blank" | "fixed";

// ── Per-column override (the simple, primary control) ──────────
// For every output column the user picks ONE of three things:
//   "extracted" → keep whatever the transform produced from the PDF
//   "custom"    → write a fixed value (the same text on every row)
//   "blank"     → leave the column empty
// …and can additionally REMOVE the column from the CSV entirely.
export type ColumnMode = "extracted" | "custom" | "blank";

export interface ColumnOverride {
  mode: ColumnMode;
  /** The fixed value written on every row when mode === "custom". */
  value: string;
  /** When true the column is dropped from the output CSV entirely. */
  removed: boolean;
  /** Per-value remap applied in "extracted" mode: extracted value → replacement.
   *  Lets one distinct value (e.g. "Rib") be changed everywhere it appears
   *  without touching the column's other values. Empty replacement = keep. */
  valueMap: Record<string, string>;
}

/** Build a full, default override map (every column kept & as-extracted). */
export function makeDefaultOverrides(
  includeWorkType = true,
): Record<string, ColumnOverride> {
  const out: Record<string, ColumnOverride> = {};
  for (const c of COLUMNS) {
    out[c.key] = {
      mode: "extracted",
      value: "",
      removed: c.key === "workType" ? !includeWorkType : false,
      valueMap: {},
    };
  }
  return out;
}

/** Fill in any missing/updated column overrides so a config is always complete
 *  (handles presets and older saved configs that predate this field). */
function ensureOverrides(cfg: CompanyConfig): Record<string, ColumnOverride> {
  const out = makeDefaultOverrides(cfg.includeWorkType);
  const src = cfg.columnOverrides ?? {};
  for (const c of COLUMNS) {
    const s = src[c.key];
    if (s) {
      out[c.key] = {
        mode: s.mode ?? "extracted",
        value: s.value ?? "",
        removed: !!s.removed,
        valueMap: { ...(s.valueMap ?? {}) },
      };
    }
  }
  return out;
}

export interface CompanyConfig {
  /** Stable id (used as localStorage / selection key). */
  id: string;
  /** Human-readable company/preset name shown in the picker. */
  name: string;

  // ── Column set ──────────────────────────────────────────────
  /** Emit the trailing Work-Type column? (Some companies omit it.) */
  includeWorkType: boolean;

  // ── Field sources ───────────────────────────────────────────
  /** Where the Style/PO value comes from. */
  stylePoSource: StylePoSource;
  /** Strip a trailing parenthetical like " (2nd)" from the Style/PO. */
  stylePoStripSuffix: boolean;
  /** Which GSM value to use (per-booking heading vs per-fabric metadata). */
  gsmSource: GsmSource;

  // ── Field formatting ────────────────────────────────────────
  /** Keep the full color string (Pantone/codes) or clean to the pure name. */
  colorMode: ColorMode;
  /** Keep width as written or normalize (strip quotes, OPEN → Inch Open). */
  widthMode: WidthMode;
  /** How the Special Instruction column is produced. */
  specialMode: SpecialMode;
  /** Value used when specialMode = "fixed". */
  specialFixedValue: string;

  // ── Lookups & fixed values ──────────────────────────────────
  /** Normalize raw fabric names → display names. Keyed by lowercase raw name. */
  fabricNameMap: Record<string, string>;
  /** Fabric name (lowercase raw) → item code. Takes precedence over PDF value. */
  itemCodeMap: Record<string, string>;
  /** Quantity unit written to every row. */
  qtyUnit: string;
  /** Backorder Type written to every row. */
  backorderType: string;
  /** Work-Type value (only used when includeWorkType is true). */
  workTypeValue: string;
  /** Fallback unit price used when the PDF had none. Empty = leave blank. */
  defaultUnitPrice: string;

  // ── Per-column overrides (the simple, primary control) ──────
  /** Keyed by column key: extracted / custom / blank + removed flag. */
  columnOverrides: Record<string, ColumnOverride>;
}

// ─────────────────────────────────────────────────────────────
// Built-in presets
// ─────────────────────────────────────────────────────────────

/** A neutral starting point that keeps everything as extracted. */
export const GENERIC_CONFIG: CompanyConfig = {
  id: "generic",
  name: "Generic (as extracted)",
  includeWorkType: true,
  stylePoSource: "documentPo",
  stylePoStripSuffix: false,
  gsmSource: "heading",
  colorMode: "full",
  widthMode: "asExtracted",
  specialMode: "asExtracted",
  specialFixedValue: "",
  fabricNameMap: {},
  itemCodeMap: {},
  qtyUnit: "KG",
  backorderType: "Order Now",
  workTypeValue: "Full Order",
  defaultUnitPrice: "",
  columnOverrides: makeDefaultOverrides(true),
};

/** CZ Dia: per-booking style code + GSM, clean colors, blank instruction,
 *  no Work-Type column, unit price 2.10. */
export const CZ_DIA_CONFIG: CompanyConfig = {
  id: "cz-dia",
  name: "CZ Dia",
  includeWorkType: false,
  stylePoSource: "styleCode",
  stylePoStripSuffix: false,
  gsmSource: "heading",
  colorMode: "clean",
  widthMode: "normalize",
  specialMode: "blank",
  specialFixedValue: "",
  fabricNameMap: {
    rib: "2X2 Lycra Rib",
    "2x2 rib": "2X2 Lycra Rib",
    fleece: "Fleece",
    "single jersey": "Single Jersey",
  },
  itemCodeMap: {
    fleece: "FG-00003",
    rib: "FG-00007",
    "2x2 rib": "FG-00007",
    "2x2 lycra rib": "FG-00007",
    "single jersey": "FG-00010",
  },
  qtyUnit: "KG",
  backorderType: "Order Now",
  workTypeValue: "Full Order",
  defaultUnitPrice: "2.10",
  columnOverrides: makeDefaultOverrides(false),
};

/** Ripon Knitwear: document PO (strip suffix), full Pantone colors,
 *  fixed "Y/D" instruction, keeps Work-Type. */
export const RIPON_CONFIG: CompanyConfig = {
  id: "ripon",
  name: "Ripon Knitwear",
  includeWorkType: true,
  stylePoSource: "documentPo",
  stylePoStripSuffix: true,
  gsmSource: "heading",
  colorMode: "full",
  widthMode: "asExtracted",
  specialMode: "fixed",
  specialFixedValue: "Y/D",
  fabricNameMap: {
    "single jersey": "Single Jersey",
  },
  itemCodeMap: {
    "single jersey": "FG-00010",
  },
  qtyUnit: "KG",
  backorderType: "Order Now",
  workTypeValue: "Full Order",
  defaultUnitPrice: "",
  columnOverrides: makeDefaultOverrides(true),
};

export const BUILTIN_CONFIGS: CompanyConfig[] = [
  GENERIC_CONFIG,
  CZ_DIA_CONFIG,
  RIPON_CONFIG,
];

/** Deep-clone a config (so edits don't mutate a shared preset object).
 *  Also normalizes columnOverrides so every config is always complete. */
export function cloneConfig(cfg: CompanyConfig): CompanyConfig {
  return {
    ...cfg,
    fabricNameMap: { ...cfg.fabricNameMap },
    itemCodeMap: { ...cfg.itemCodeMap },
    columnOverrides: ensureOverrides(cfg),
  };
}
