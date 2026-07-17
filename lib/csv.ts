// Deterministic CSV generation for the ERP solution.
//
// The fixed two-row header (human-readable labels + ERP field codes) is always
// emitted exactly, followed by one line per extracted row. Because the header
// and column order come from lib/schema.ts, they can never drift from the
// values the model returns.

import {
  ExtractedRow,
  HEADER_CODES,
  HEADER_LABELS,
  ROW_KEYS,
} from "./schema";

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
// Uses CRLF line endings for maximum compatibility with spreadsheet/ERP imports.
export function generateCsv(rows: ExtractedRow[]): string {
  const lines: string[] = [];

  // Row 1: human-readable labels. Row 2: ERP field codes.
  lines.push(toLine(HEADER_LABELS));
  lines.push(toLine(HEADER_CODES));

  // Data rows, in the exact column order defined by ROW_KEYS.
  for (const row of rows) {
    const fields = ROW_KEYS.map((key) => {
      const raw = row[key];
      return raw === undefined || raw === null ? "" : String(raw);
    });
    lines.push(toLine(fields));
  }

  return lines.join("\r\n") + "\r\n";
}
