// Fixed CSV schema for the ERP solution.
// The two-row header (human-readable labels + ERP field codes) must ALWAYS
// be emitted exactly as defined here, in this exact column order.

export interface ColumnDef {
  /** Human-readable header shown in row 1 of the CSV. */
  label: string;
  /** ERP field code shown in row 2 of the CSV. */
  code: string;
  /** Stable key used in the JSON rows returned by the model. */
  key: string;
}

// Column order is significant and must never change.
export const COLUMNS: ColumnDef[] = [
  { label: "Item Name", code: "xdesc", key: "itemName" },
  { label: "Item Code", code: "xitem", key: "itemCode" },
  { label: "Style / PO", code: "xvaldim[10]", key: "stylePo" },
  { label: "Composition", code: "xvaldim[20]", key: "composition" },
  { label: "Gsm", code: "xvaldim[30]", key: "gsm" },
  { label: "Stitch Length", code: "xvaldim[35]", key: "stitchLength" },
  { label: "Width", code: "xvaldim[40]", key: "width" },
  { label: "Size", code: "xvaldim[50]", key: "size" },
  { label: "Color / Code", code: "xvaldim[60]", key: "colorCode" },
  { label: "Specials Instruction", code: "xvaldim[80]", key: "specialInstruction" },
  { label: "QTY", code: "xqtyord", key: "qty" },
  { label: "Qty Unit", code: "xunitsel", key: "qtyUnit" },
  { label: "Unit Price", code: "xrate", key: "unitPrice" },
  { label: "Requested Date of Delivery", code: "xdatereq", key: "requestedDate" },
  { label: "Backorder Type", code: "xtypebo", key: "backorderType" },
  { label: "Work-Type", code: "xrefcode", key: "workType" },
];

// The set of keys the model must return for each row.
export type RowKey = (typeof COLUMNS)[number]["key"];

// A single extracted line item. All values are strings (empty string when absent).
export type ExtractedRow = Record<RowKey, string>;

// Ordered list of keys, matching COLUMNS order.
export const ROW_KEYS: RowKey[] = COLUMNS.map((c) => c.key);

// ─────────────────────────────────────────────────────────────
// Neutral raw extraction
// ─────────────────────────────────────────────────────────────
// The API extracts ONE RawLineItem per (fabric column × color) and applies NO
// company-specific normalization. It carries every variant a company might want
// (full color string, both GSM values, per-booking style code, etc.) so the
// client-side transform can produce any company's final CSV — and re-do it with
// different settings — without re-analyzing the PDF.
export interface RawLineItem {
  /** Fabric type exactly as written (e.g. "Rib", "Fleece", "Single Jersey"). */
  fabricName: string;
  /** Item code found in the PDF, if any (may be empty). */
  itemCode: string;
  /** Document-level PO / order reference (e.g. "CZ 02/2025"). */
  documentPo: string;
  /** Sequential booking number from the table heading (e.g. "1"). */
  bookingNumber: string;
  /** Per-booking style code from the table heading (e.g. "MS09B"). */
  styleCode: string;
  /** Fibre composition exactly as written. */
  composition: string;
  /** GSM taken from this booking table's heading (e.g. "280/290"). */
  gsmHeading: string;
  /** GSM taken from the fabric metadata block (per fabric type). */
  gsmMetadata: string;
  /** Width exactly as written. */
  width: string;
  /** Full color/shade cell exactly as written, including any Pantone/lab codes. */
  colorFull: string;
  /** Special production note exactly as written. */
  specialInstruction: string;
  /** Unit price found in the PDF, if any (may be empty). */
  unitPrice: string;
  /** Requested delivery date exactly as written. */
  requestedDate: string;
  /** Quantity (already math-validated). */
  qty: string;
}

// Header rows for the CSV, derived from COLUMNS so they can never drift.
export const HEADER_LABELS: string[] = COLUMNS.map((c) => c.label);
export const HEADER_CODES: string[] = COLUMNS.map((c) => c.code);
