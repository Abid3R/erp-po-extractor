"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  GrnRoll,
  GrnRow,
  GRN_COLUMNS,
  toGrnRows,
  generateGrnCsv,
} from "@/lib/grn";

// ─── Types ───────────────────────────────────────────────────────────────────

type Status =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "done"; count: number; warnings: string[] };

type HistoryEntry = {
  id: string;
  filename: string;
  timestamp: number;
  rollCount: number;
  rolls: GrnRoll[];
};

const HISTORY_KEY = "grn-history";
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
  localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY)));
}
function formatDate(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function IconBox({ color = "#3b82f6", size = 22 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <path
        d="M12 2 3 7v10l9 5 9-5V7l-9-5Z"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M3 7l9 5 9-5M12 12v10" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
function IconCheck() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
      <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" stroke="#34d399" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M8.5 12l2.5 2.5 4.5-4.5" stroke="#34d399" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconDownload() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{ display: "inline", verticalAlign: "-2px", marginRight: 6 }}>
      <path d="M12 15V3M8 11l4 4 4-4M3 21h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
      <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconHistory() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M12 8v4l3 3M3 12a9 9 0 1 0 9-9 9 9 0 0 0-6.3 2.6L3 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 3v5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function GrnView() {
  const [file, setFile] = useState<File | null>(null);
  const [rolls, setRolls] = useState<GrnRoll[] | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [activeTab, setActiveTab] = useState<"upload" | "history">("upload");
  const [divisor, setDivisor] = useState<number>(1000);
  const [cellEdits, setCellEdits] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => setHistory(loadHistory()), []);

  const baseRows = useMemo(
    () => (rolls ? toGrnRows(rolls, divisor) : []),
    [rolls, divisor],
  );
  const rows = useMemo(() => {
    return baseRows.map((r, i) => {
      let copy: GrnRow | null = null;
      for (const c of GRN_COLUMNS) {
        const k = `${i}:${c.key}`;
        if (k in cellEdits) {
          if (!copy) copy = { ...r };
          copy[c.key] = cellEdits[k];
        }
      }
      return copy ?? r;
    });
  }, [baseRows, cellEdits]);

  const setCell = useCallback((rowIndex: number, key: string, value: string) => {
    setCellEdits((m) => ({ ...m, [`${rowIndex}:${key}`]: value }));
  }, []);
  const editCount = Object.keys(cellEdits).length;

  const pickFile = useCallback((f: File | null) => {
    if (!f) return;
    if (f.type && f.type !== "application/pdf") {
      setStatus({ kind: "error", message: "Please choose a PDF file." });
      return;
    }
    setFile(f);
    setRolls(null);
    setCellEdits({});
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
    setRolls(null);
    setCellEdits({});
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/grn", { method: "POST", body });

      // The route always replies with JSON. Anything else (an HTML page) means a
      // platform-level response — a timeout, cold start, or bad gateway — not a
      // real extraction result. Give a clear message instead of a JSON error.
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        await res.text().catch(() => "");
        const message =
          res.status === 502 || res.status === 503 || res.status === 504
            ? `The server timed out or was waking up (HTTP ${res.status}). Large GRNs can take a while — wait a few seconds and press Analyze again.`
            : `The server returned an unexpected response (HTTP ${res.status}). If this persists, the GRN may be too large to process in one request — tell me and I'll split it.`;
        setStatus({ kind: "error", message });
        return;
      }

      const data = (await res.json()) as
        | { rolls: GrnRoll[]; warnings?: string[] }
        | { error: string };

      if (!res.ok || "error" in data) {
        const message = "error" in data ? data.error : `Request failed (${res.status}).`;
        setStatus({ kind: "error", message });
        return;
      }

      setRolls(data.rolls);
      setStatus({ kind: "done", count: data.rolls.length, warnings: data.warnings ?? [] });

      const entry: HistoryEntry = {
        id: Date.now().toString(),
        filename: file.name,
        timestamp: Date.now(),
        rollCount: data.rolls.length,
        rolls: data.rolls,
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

  const saveCsv = useCallback((csv: string, filename: string) => {
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.replace(/\.pdf$/i, "") + " GRN.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const download = useCallback(() => {
    if (!rolls || !file) return;
    saveCsv(generateGrnCsv(rows), file.name);
  }, [rolls, file, rows, saveCsv]);

  const downloadHistory = useCallback(
    (entry: HistoryEntry) => {
      saveCsv(generateGrnCsv(toGrnRows(entry.rolls, divisor)), entry.filename);
    },
    [divisor, saveCsv],
  );

  const reset = useCallback(() => {
    setFile(null);
    setRolls(null);
    setCellEdits({});
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
  const warnings = status.kind === "done" ? status.warnings : [];

  return (
    <>
      {/* Top tabs */}
      <nav className="view-topbar">
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
            {history.length > 0 && <span className="tab-badge">{history.length}</span>}
          </button>
        </div>
      </nav>

      <div className="container">
        <AnimatePresence mode="wait">
          {activeTab === "upload" && (
            <motion.div
              key="upload"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.3 }}
            >
              <div className="hero">
                <motion.span
                  className="hero-eyebrow"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5 }}
                >
                  AI-powered · GRN → ERP CSV
                </motion.span>
                <motion.h1
                  className="hero-title"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1, duration: 0.5 }}
                >
                  GRN Extraction
                </motion.h1>
                <motion.p
                  className="hero-sub"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.2, duration: 0.5 }}
                >
                  Upload a Goods Received Note / container load plan PDF and get a
                  clean <code>row, xbatch, width, gsm, qty</code> CSV — every roll
                  across every container, extracted automatically.
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
                  <span className="card-title">Upload GRN PDF</span>
                </div>

                <motion.label
                  className={`drop-zone${dragging ? " dragging" : ""}${file ? " has-file" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                  animate={dragging ? { scale: 1.015 } : {}}
                  transition={{ duration: 0.15 }}
                >
                  <input
                    ref={inputRef}
                    type="file"
                    accept="application/pdf,.pdf"
                    onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                  />
                  <div className="drop-icon-wrap">
                    {file ? <IconCheck /> : <IconBox size={30} />}
                  </div>
                  <p className="drop-title">{file ? "PDF ready" : "Drop your GRN PDF here"}</p>
                  <p className="drop-sub">{file ? file.name : "or click to browse your files"}</p>
                </motion.label>

                <div className="btn-row">
                  <motion.button
                    className="btn btn-primary"
                    onClick={analyze}
                    disabled={!file || loading}
                    whileHover={!file || loading ? {} : { scale: 1.03 }}
                    whileTap={!file || loading ? {} : { scale: 0.97 }}
                  >
                    {loading ? (<><span className="spinner" />Analyzing…</>) : "Analyze GRN"}
                  </motion.button>
                  <motion.button
                    className="btn btn-ghost"
                    onClick={reset}
                    disabled={loading || (!file && !rolls)}
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                  >
                    Reset
                  </motion.button>
                </div>

                <AnimatePresence mode="wait">
                  {status.kind === "loading" && (
                    <motion.div key="l" className="status-bar loading" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.25 }}>
                      <span className="spinner" />
                      Reading the GRN and extracting every roll… (large documents can take a minute)
                    </motion.div>
                  )}
                  {status.kind === "error" && (
                    <motion.div key="e" className="status-bar error" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.25 }}>
                      ⚠ {status.message}
                    </motion.div>
                  )}
                  {status.kind === "done" && (
                    <motion.div key="d" className="status-bar success" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.25 }}>
                      ✓ Extracted {status.count} roll{status.count === 1 ? "" : "s"} successfully.
                    </motion.div>
                  )}
                </AnimatePresence>

                {warnings.length > 0 && (
                  <div className="status-bar warn" style={{ marginTop: 10, flexDirection: "column", alignItems: "flex-start" }}>
                    {warnings.map((w, i) => (
                      <div key={i}>⚠ {w}</div>
                    ))}
                  </div>
                )}
              </motion.div>

              {/* Preview */}
              <AnimatePresence>
                {rolls && rolls.length > 0 && (
                  <motion.div className="card" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }} transition={{ duration: 0.4 }}>
                    <div className="card-header">
                      <span className="card-title">
                        Preview{" "}
                        <span className="muted">
                          ({rows.length} roll{rows.length === 1 ? "" : "s"}
                          {editCount > 0 ? ` · ${editCount} edit${editCount === 1 ? "" : "s"}` : ""})
                        </span>
                      </span>
                      <div className="preview-actions">
                        {editCount > 0 && (
                          <button className="btn btn-ghost btn-sm" onClick={() => setCellEdits({})}>
                            Clear edits
                          </button>
                        )}
                        <motion.button className="btn btn-primary btn-sm" onClick={download} whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}>
                          <IconDownload />
                          Download CSV
                        </motion.button>
                      </div>
                    </div>

                    <div className="grn-divisor">
                      <label className="cfg-label" htmlFor="grn-div">Weight → Qty divisor</label>
                      <select
                        id="grn-div"
                        value={divisor}
                        onChange={(e) => setDivisor(Number(e.target.value))}
                      >
                        <option value={1000}>÷ 1000 (kg → tonnes, e.g. 1374 → 1.374)</option>
                        <option value={1}>÷ 1 (use weight as-is)</option>
                      </select>
                    </div>

                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            {GRN_COLUMNS.map((c) => (
                              <th key={c.key}>{c.label}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row, i) => (
                            <tr key={i}>
                              {GRN_COLUMNS.map((c) => {
                                const k = `${i}:${c.key}`;
                                const edited = k in cellEdits;
                                return (
                                  <td key={c.key} className={`cell${edited ? " edited" : ""}`}>
                                    <input
                                      className="cell-input"
                                      value={row[c.key] ?? ""}
                                      spellCheck={false}
                                      onChange={(e) => setCell(i, c.key, e.target.value)}
                                    />
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <p className="hint">
                      Header row is <code>row,xbatch,width,gsm,qty</code>. Every cell
                      is editable — click any value to fix it before download.
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {activeTab === "history" && (
            <motion.div key="history" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={{ duration: 0.3 }}>
              <div className="hero">
                <h1 className="hero-title">GRN History</h1>
                <p className="hero-sub">Re-download any previously extracted GRN CSV without re-uploading the PDF.</p>
              </div>
              <div className="card">
                <div className="card-header">
                  <span className="card-title">Recent extractions <span className="muted">({history.length})</span></span>
                  {history.length > 0 && (
                    <button className="btn btn-ghost btn-sm" onClick={clearHistory}>Clear all</button>
                  )}
                </div>
                {history.length === 0 ? (
                  <div className="empty-state">
                    <div className="empty-icon"><IconHistory /></div>
                    <p className="empty-title">No history yet</p>
                    <p className="empty-sub">Analyzed GRNs will appear here so you can re-download them any time.</p>
                  </div>
                ) : (
                  <div className="history-list">
                    <AnimatePresence initial={false}>
                      {history.map((entry, i) => (
                        <motion.div key={entry.id} className="history-item" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 16, height: 0 }} transition={{ duration: 0.25, delay: i * 0.03 }} layout>
                          <div className="history-file-icon"><IconBox size={18} /></div>
                          <div className="history-info">
                            <span className="history-name">{entry.filename}</span>
                            <span className="history-meta">
                              {formatDate(entry.timestamp)}
                              <span className="dot">·</span>
                              {entry.rollCount} roll{entry.rollCount === 1 ? "" : "s"}
                            </span>
                          </div>
                          <div className="history-actions">
                            <motion.button className="btn btn-primary btn-sm" onClick={() => downloadHistory(entry)} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }}>
                              <IconDownload />CSV
                            </motion.button>
                            <motion.button className="btn btn-ghost btn-sm btn-icon" onClick={() => deleteEntry(entry.id)} whileHover={{ scale: 1.05 }} whileTap={{ scale: 0.95 }} title="Remove from history">
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
    </>
  );
}
