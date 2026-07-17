# ERP solution

Upload a purchase-order PDF and get a clean, ERP-ready CSV with a fixed
field-code header. The PDF is analyzed by Google Gemini (`gemini-2.5-flash`) with
careful, structured extraction so line items are transcribed accurately and the CSV
header never drifts.

## How it works

1. Upload a purchase-order PDF (scanned/image PDFs are supported).
2. The server sends the PDF to Google Gemini for meticulous line-item extraction.
3. Preview the extracted rows, then download an ERP-ready CSV.

The CSV always emits a fixed two-row header:

- Row 1: human-readable labels (Item Name, Item Code, …)
- Row 2: the exact ERP field codes:

  ```
  xdesc	xitem	xvaldim[10]	xvaldim[20]	xvaldim[30]	xvaldim[35]	xvaldim[40]	xvaldim[50]	xvaldim[60]	xvaldim[80]	xqtyord	xunitsel	xrate	xdatereq	xtypebo	xrefcode
  ```

Both the header and the column order come from a single source of truth
(`lib/schema.ts`), so they can never drift from the values the model returns.

## Setup

1. Copy the environment template and add your Google Gemini API key:

   ```bash
   cp .env.local.example .env.local
   # then edit .env.local and set GEMINI_API_KEY
   ```

   Get a free key from https://aistudio.google.com/apikey

2. Install dependencies:

   ```bash
   npm install
   ```

3. Run the dev server:

   ```bash
   npm run dev
   ```

   Open http://localhost:3000.

## Production build

```bash
npm run build
npm start
```

## Project structure

- `app/page.tsx` — upload UI, preview table, CSV download
- `app/api/analyze/route.ts` — backend route that sends the PDF to Google Gemini and returns validated rows
- `lib/schema.ts` — fixed column definitions (labels, ERP codes, keys) — the single source of truth
- `lib/csv.ts` — deterministic CSV generation with the fixed two-row header

## Notes

- Accuracy is the priority: the model is instructed never to invent, reformat, or
  round values, and to use an empty string for anything not present in the document.
- The `GEMINI_API_KEY` is read server-side only; it is never exposed to the browser.
