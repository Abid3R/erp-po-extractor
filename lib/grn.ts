// GRN (Goods Received Note / Container Load Plan) feature.
//
// A GRN PDF lists received fabric/paper ROLLS grouped by container. Each roll
// carries: GSM, Roll No. (batch), Width, and Weight. The ERP import expects a
// flat CSV with EXACTLY these columns:
//
//     row,xbatch,width,gsm,qty
//
// where `row` is always 0, `xbatch` = roll/batch number, and `qty` = weight
// converted to tonnes (kg ÷ 1000, e.g. 1374 kg → 1.374).

// One roll exactly as extracted from the PDF (all values are strings).
export interface GrnRoll {
  /** GSM value for this roll (e.g. "200"). */
  gsm: string;
  /** Roll / batch number → the CSV "xbatch" column (e.g. "4215033140"). */
  batch: string;
  /** Roll width (e.g. "1300"). */
  width: string;
  /** Roll weight exactly as written, usually in KG (e.g. "1374"). */
  weight: string;
}

// A final output row, matching the expected CSV column order.
export interface GrnRow {
  row: string;
  xbatch: string;
  width: string;
  gsm: string;
  qty: string;
}

export interface GrnColumn {
  key: keyof GrnRow;
  label: string;
}

// Column order is significant — it must match the expected format exactly.
export const GRN_COLUMNS: GrnColumn[] = [
  { key: "row", label: "row" },
  { key: "xbatch", label: "xbatch" },
  { key: "width", label: "width" },
  { key: "gsm", label: "gsm" },
  { key: "qty", label: "qty" },
];

/** Convert a raw weight string to the qty value (kg → tonnes, trimmed). */
export function weightToQty(weight: string, divisor = 1000): string {
  const n = parseFloat((weight ?? "").replace(/,/g, "").trim());
  if (isNaN(n)) return "";
  if (!divisor) return String(n);
  // toFixed(3) then parseFloat drops trailing zeros: 1380/1000 → "1.38".
  return String(parseFloat((n / divisor).toFixed(3)));
}

/** Turn extracted rolls into final output rows. */
export function toGrnRows(rolls: GrnRoll[], divisor = 1000): GrnRow[] {
  return rolls.map((r) => ({
    row: "0",
    xbatch: (r.batch ?? "").trim(),
    width: (r.width ?? "").trim(),
    gsm: (r.gsm ?? "").trim(),
    qty: weightToQty(r.weight, divisor),
  }));
}

function escapeCsv(value: string): string {
  const v = value ?? "";
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Generate the GRN CSV. Single header row `row,xbatch,width,gsm,qty`. */
export function generateGrnCsv(rows: GrnRow[]): string {
  const lines: string[] = [GRN_COLUMNS.map((c) => c.label).join(",")];
  for (const r of rows) {
    lines.push(GRN_COLUMNS.map((c) => escapeCsv(r[c.key])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
