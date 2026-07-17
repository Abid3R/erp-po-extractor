"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { COLUMNS, ROW_KEYS, ExtractedRow } from "@/lib/schema";
import { generateCsv } from "@/lib/csv";

// ─── Types ───────────────────────────────────────────────────────────────────

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; count: number };

type HistoryEntry = {
  id: string;
  filename: string;
  timestamp: number;
  rowCount: number;
  rows: ExtractedRow[];
};

// ─── History helpers (localStorage) ──────────────────────────────────────────

const HISTORY_KEY = "erp-history";
const MAX_HISTORY = 30;

function loadHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify(entries.slice(0, MAX_HISTORY)),
  );
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function IconDocument({ color = "#3b82f6" }: { color?: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M14 2v6h6" stroke={color} strokeWidth="1.5" />
    </svg>
  );
}

function IconUpload() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
        stroke="#3b82f6"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M14 2v6h6M12 18v-6M9 15l3-3 3 3"
        stroke="#3b82f6"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconCheck() {
  return (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
      <path
        d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"
        stroke="#34d399"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M14 2v6h6M9 15l2 2 4-4"
        stroke="#34d399"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconDownload() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      style={{ display: "inline", verticalAlign: "-2px", marginRight: 6 }}
    >
      <path
        d="M12 15V3M8 11l4 4 4-4M3 21h18"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path
        d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconHistory() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M12 8v4l3 3M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.3 2.6L3 8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M3 3v5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Page() {
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<ExtractedRow[] | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [activeTab, setActiveTab] = useState<"upload" | "history">("upload");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  const pickFile = useCallback((f: File | null) => {
    if (!f) return;
    if (f.type && f.type !== "application/pdf") {
      setStatus({ kind: "error", message: "Please choose a PDF file." });
      return;
    }
    setFile(f);
    setRows(null);
    setStatus({ kind: "idle" });
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      pickFile(e.dataTransfer.files?.[0] ?? null);
    },
    [pickFile],
  );

  const analyze = useCallback(async () => {
    if (!file) return;
    setStatus({ kind: "loading" });
    setRows(null);
    try {
      const body = new FormData();
      body.append("file", file);

      const res = await fetch("/api/analyze", { method: "POST", body });
      const data = (await res.json()) as
        | { rows: ExtractedRow[]; warnings?: string[] }
        | { error: string };

      if (!res.ok || "error" in data) {
        const message =
          "error" in data ? data.error : `Request failed (${res.status}).`;
        setStatus({ kind: "error", message });
        return;
      }

      setRows(data.rows);
      setStatus({ kind: "done", count: data.rows.length });

      const entry: HistoryEntry = {
        id: Date.now().toString(),
        filename: file.name,
        timestamp: Date.now(),
        rowCount: data.rows.length,
        rows: data.rows,
      };
      setHistory((prev) => {
        const next = [entry, ...prev].slice(0, MAX_HISTORY);
        saveHistory(next);
        return next;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Network error.";
      setStatus({ kind: "error", message });
    }
  }, [file]);

  const downloadRows = useCallback(
    (targetRows: ExtractedRow[], filename: string) => {
      const csv = generateCsv(targetRows);
      const blob = new Blob(["\uFEFF" + csv], {
        type: "text/csv;charset=utf-8;",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename.replace(/\.pdf$/i, "") + ".csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    },
    [],
  );

  const download = useCallback(() => {
    if (!rows || !file) return;
    downloadRows(rows, file.name);
  }, [rows, file, downloadRows]);

  const reset = useCallback(() => {
    setFile(null);
    setRows(null);
    setStatus({ kind: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const deleteEntry = useCallback((id: string) => {
    setHistory((prev) => {
      const next = prev.filter((e) => e.id !== id);
      saveHistory(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveHistory([]);
  }, []);

  const loading = status.kind === "loading";

  return (
    <div className="page-wrapper">
      {/* ── Navbar ── */}
      <motion.nav
        className="navbar"
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="navbar-inner">
          <div className="brand">
            <div className="brand-icon">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <rect width="24" height="24" rx="6" fill="#3b82f6" />
                <path
                  d="M5 8h14M5 12h9M5 16h11"
                  stroke="white"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
            </div>
            <span className="brand-name">PO Extractor</span>
          </div>
          <div className="nav-tabs">
            <button
              className={`nav-tab${activeTab === "upload" ? " active" : ""}`}
              onClick={() => setActiveTab("upload")}
            >
              Upload
            </button>
            <button
              className={`nav-tab${activeTab === "history" ? " active" : ""}`}
              onClick={() => setActiveTab("history")}
            >
              <span className="tab-icon"><IconHistory /></span>
              History
              {history.length > 0 && (
                <span className="tab-badge">{history.length}</span>
              )}
            </button>
          </div>
        </div>
      </motion.nav>

      <div className="container">
        <AnimatePresence mode="wait">

          {/* ═══════════════════════════════════ UPLOAD TAB ═══════════════════════════════════ */}
          {activeTab === "upload" && (
            <motion.div
              key="upload"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.3 }}
            >
              {/* Hero */}
              <div className="hero">
                <motion.h1
                  className="hero-title"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1, duration: 0.5 }}
                >
                  Purchase Order Extraction
                </motion.h1>
                <motion.p
                  className="hero-sub"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.2, duration: 0.5 }}
                >
                  Upload a fabric purchase-order PDF and receive a clean,
                  ERP-ready CSV in seconds.
                </motion.p>
              </div>

              {/* Upload card */}
              <motion.div
                className="card"
                initial={{ opacity: 0, y: 16 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.15, duration: 0.4 }}
              >
                <div className="card-header">
                  <span className="card-title">Upload PDF</span>
                </div>

                <motion.label
                  className={`drop-zone${dragging ? " dragging" : ""}${file ? " has-file" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                  animate={
                    dragging ? { scale: 1.015, borderColor: "#3b82f6" } : {}
                  }
                  transition={{ duration: 0.15 }}
                >
                  <input
                    ref={inputRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                  />
                  <motion.div
                    className="drop-icon-wrap"
                    animate={file ? { scale: [1, 1.15, 1] } : {}}
                    transition={{ duration: 0.35 }}
                  >
                    {file ? <IconCheck /> : <IconUpload />}
                  </motion.div>
                  <p className="drop-title">
                    {file ? "PDF ready" : "Drop your PDF here"}
                  </p>
                  <p className="drop-sub">
                    {file ? file.name : "or click to browse your files"}
                  </p>
                </motion.label>

                <div className="btn-row">
                  <motion.button
                    className="btn btn-primary"
                    onClick={analyze}
                    disabled={!file || loading}
                    whileHover={!file || loading ? {} : { scale: 1.03 }}
                    whileTap={!file || loading ? {} : { scale: 0.97 }}
                  >
                    {loading ? (
                      <>
                        <span className="spinner" />
                        Analyzing…
                      </>
                    ) : (
                      "Analyze PDF"
                    )}
                  </motion.button>
                  <motion.button
                    className="btn btn-ghost"
                    onClick={reset}
                    disabled={loading || (!file && !rows)}
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                  >
                    Reset
                  </motion.button>
                </div>

                {/* Status */}
                <AnimatePresence mode="wait">
                  {status.kind === "loading" && (
                    <motion.div
                      key="loading"
                      className="status-bar loading"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.25 }}
                    >
                      <span className="spinner" />
                      Reading the document and extracting line items…
                    </motion.div>
                  )}
                  {status.kind === "error" && (
                    <motion.div
                      key="error"
                      className="status-bar error"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.25 }}
                    >
                      ⚠ {status.message}
                    </motion.div>
                  )}
                  {status.kind === "done" && (
                    <motion.div
                      key="done"
                      className="status-bar success"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.25 }}
                    >
                      ✓ Extracted {status.count} line item
                      {status.count === 1 ? "" : "s"} successfully.
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>

              {/* Results */}
              <AnimatePresence>
                {rows && rows.length > 0 && (
                  <motion.div
                    className="card"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    transition={{ duration: 0.4 }}
                  >
                    <div className="card-header">
                      <span className="card-title">
                        Preview{" "}
                        <span className="muted">
                          ({rows.length} row{rows.length === 1 ? "" : "s"})
                        </span>
                      </span>
                      <motion.button
                        className="btn btn-primary btn-sm"
                        onClick={download}
                        whileHover={{ scale: 1.04 }}
                        whileTap={{ scale: 0.96 }}
                      >
                        <IconDownload />
                        Download CSV
                      </motion.button>
                    </div>

                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            {COLUMNS.map((c) => (
                              <th key={c.key}>{c.label}</th>
                            ))}
                          </tr>
                          <tr className="code-row">
                            {COLUMNS.map((c) => (
                              <th key={c.key}>{c.code}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row, i) => (
                            <motion.tr
                              key={i}
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              transition={{
                                duration: 0.25,
                                delay: Math.min(i * 0.018, 0.6),
                              }}
                            >
                              {ROW_KEYS.map((key) => {
                                const value = row[key] ?? "";
                                return (
                                  <td
                                    key={key}
                                    className={value ? undefined : "empty"}
                                  >
                                    {value || "—"}
                                  </td>
                                );
                              })}
                            </motion.tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <p className="hint">
                      Row 1 = human-readable labels · Row 2 = ERP field codes
                      (written to CSV header)
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {/* ═══════════════════════════════════ HISTORY TAB ═══════════════════════════════════ */}
          {activeTab === "history" && (
            <motion.div
              key="history"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.3 }}
            >
              <div className="hero">
                <h1 className="hero-title">Extraction History</h1>
                <p className="hero-sub">
                  Re-download any previously extracted CSV without re-uploading
                  the PDF.
                </p>
              </div>

              <div className="card">
                <div className="card-header">
                  <span className="card-title">
                    Recent extractions{" "}
                    <span className="muted">({history.length})</span>
                  </span>
                  {history.length > 0 && (
                    <button className="btn btn-ghost btn-sm" onClick={clearHistory}>
                      Clear all
                    </button>
                  )}
                </div>

                {history.length === 0 ? (
                  <motion.div
                    className="empty-state"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.1 }}
                  >
                    <div className="empty-icon">
                      <IconHistory />
                    </div>
                    <p className="empty-title">No history yet</p>
                    <p className="empty-sub">
                      Analyzed PDFs will appear here so you can re-download
                      them at any time.
                    </p>
                  </motion.div>
                ) : (
                  <div className="history-list">
                    <AnimatePresence initial={false}>
                      {history.map((entry, i) => (
                        <motion.div
                          key={entry.id}
                          className="history-item"
                          initial={{ opacity: 0, x: -12 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: 16, height: 0 }}
                          transition={{ duration: 0.25, delay: i * 0.03 }}
                          layout
                        >
                          <div className="history-file-icon">
                            <IconDocument />
                          </div>
                          <div className="history-info">
                            <span className="history-name">
                              {entry.filename}
                            </span>
                            <span className="history-meta">
                              {formatDate(entry.timestamp)}
                              <span className="dot">·</span>
                              {entry.rowCount} row
                              {entry.rowCount === 1 ? "" : "s"}
                            </span>
                          </div>
                          <div className="history-actions">
                            <motion.button
                              className="btn btn-primary btn-sm"
                              onClick={() =>
                                downloadRows(entry.rows, entry.filename)
                              }
                              whileHover={{ scale: 1.05 }}
                              whileTap={{ scale: 0.95 }}
                            >
                              <IconDownload />
                              CSV
                            </motion.button>
                            <motion.button
                              className="btn btn-ghost btn-sm btn-icon"
                              onClick={() => deleteEntry(entry.id)}
                              whileHover={{ scale: 1.05 }}
                              whileTap={{ scale: 0.95 }}
                              title="Remove from history"
                            >
                              <IconTrash />
                            </motion.button>
                          </div>
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
