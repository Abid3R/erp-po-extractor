// Deterministic CSV generation for the ERP solution.
//
// The two-row header (human-readable labels + ERP field codes) and the column
// order are driven by the ColumnDef[] passed in, so a company that omits a
// column (e.g. Work-Type) gets a header and body that match exactly.

import { ColumnDef, COLUMNS, ExtractedRow } from "./schema";

// Escape a single CSV field per RFC 4180.
// A field is quoted when it contains a comma, double quote, or newline.
// Embedded double quotes are doubled.
function escapeField(value: string): string {
  const v = value ?? "";
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

// Build one CSV line from an ordered array of string fields.
function toLine(fields: string[]): string {
  return fields.map(escapeField).join(",");
}

// Generate the full CSV text for a set of extracted rows.
// `columns` selects which fields (and in what order) are emitted; defaults to
// the full fixed schema. Uses CRLF line endings for spreadsheet/ERP imports.
export function generateCsv(
  rows: ExtractedRow[],
  columns: ColumnDef[] = COLUMNS,
): string {
  const lines: string[] = [];

  // Row 1: human-readable labels. Row 2: ERP field codes.
  lines.push(toLine(columns.map((c) => c.label)));
  lines.push(toLine(columns.map((c) => c.code)));

  // Data rows, in the exact column order supplied.
  for (const row of rows) {
    const fields = columns.map((c) => {
      const raw = row[c.key];
      return raw === undefined || raw === null ? "" : String(raw);
    });
    lines.push(toLine(fields));
  }

  return lines.join("\r\n") + "\r\n";
}
