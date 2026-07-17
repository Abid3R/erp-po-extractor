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

// Header rows for the CSV, derived from COLUMNS so they can never drift.
export const HEADER_LABELS: string[] = COLUMNS.map((c) => c.label);
export const HEADER_CODES: string[] = COLUMNS.map((c) => c.code);
