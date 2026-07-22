"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { RawLineItem, ExtractedRow, COLUMNS } from "@/lib/schema";
import { generateCsv } from "@/lib/csv";
import { applyConfig, activeColumns, baselineRows } from "@/lib/transform";
import {
  CompanyConfig,
  ColumnMode,
  ColumnOverride,
  BUILTIN_CONFIGS,
  GENERIC_CONFIG,
  cloneConfig,
} from "@/lib/config";

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
  items: RawLineItem[];
  config: CompanyConfig;
};

// ─── Persistence helpers (localStorage) ──────────────────────────────────────

const HISTORY_KEY = "erp-history";
const CONFIGS_KEY = "erp-configs";
const MAX_HISTORY = 30;
const BUILTIN_IDS = new Set(BUILTIN_CONFIGS.map((c) => c.id));

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

function loadCustomConfigs(): CompanyConfig[] {
  if (typeof window === "undefined") return [];
  try {
    const list = JSON.parse(localStorage.getItem(CONFIGS_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveCustomConfigs(list: CompanyConfig[]) {
  localStorage.setItem(CONFIGS_KEY, JSON.stringify(list));
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

// ─── Small config-control building blocks ────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="cfg-field">
      <span className="cfg-label">{label}</span>
      {children}
    </label>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────

export default function Page() {
  const [file, setFile] = useState<File | null>(null);
  const [items, setItems] = useState<RawLineItem[] | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [dragging, setDragging] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [activeTab, setActiveTab] = useState<"upload" | "history">("upload");
  const inputRef = useRef<HTMLInputElement>(null);

  // Company-config state.
  const [customConfigs, setCustomConfigs] = useState<CompanyConfig[]>([]);
  const [config, setConfig] = useState<CompanyConfig>(() =>
    cloneConfig(GENERIC_CONFIG),
  );
  const [presetName, setPresetName] = useState("");

  useEffect(() => {
    setHistory(loadHistory());
    setCustomConfigs(loadCustomConfigs());
  }, []);

  const allConfigs = useMemo(
    () => [...BUILTIN_CONFIGS, ...customConfigs],
    [customConfigs],
  );

  // Per-cell manual edits, keyed by `${rowIndex}:${columnKey}`. These are
  // specific to the CURRENT document (not saved into a company preset) so the
  // user can fix any individual value — e.g. one Item Name among many.
  const [cellEdits, setCellEdits] = useState<Record<string, string>>({});

  // Live "Redo": recompute columns + the config-derived rows whenever items or
  // config change. `rows` then overlays any per-cell manual edits on top.
  const columns = useMemo(() => activeColumns(config), [config]);
  const baseRows = useMemo(
    () => (items ? applyConfig(items, config) : []),
    [items, config],
  );
  const rows = useMemo(() => {
    return baseRows.map((r, i) => {
      let copy: ExtractedRow | null = null;
      for (const c of COLUMNS) {
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
  const clearCellEdits = useCallback(() => setCellEdits({}), []);

  // Distinct EXTRACTED value(s) per column (before overrides) — the list the
  // per-value remap editor shows, so "Rib" can be renamed wherever it appears.
  const distinctByColumn = useMemo(() => {
    const src = items ? baselineRows(items, config) : [];
    const map: Record<string, string[]> = {};
    for (const c of COLUMNS) {
      const seen = new Set<string>();
      for (const r of src) seen.add(r[c.key] ?? "");
      map[c.key] = Array.from(seen);
    }
    return map;
  }, [items, config]);

  const up = useCallback((patch: Partial<CompanyConfig>) => {
    setConfig((c) => ({ ...c, ...patch }));
  }, []);

  // ── Per-column editor (draft) ──
  // The column choices are edited in a draft, then committed to the config with
  // the "Update CSV" button — so the preview/CSV only change when the user asks.
  const [colDraft, setColDraft] = useState<Record<string, ColumnOverride>>(
    () => cloneConfig(GENERIC_CONFIG).columnOverrides,
  );

  // Re-sync the draft whenever the config's committed columns change
  // (switching preset, saving a preset, or applying the draft itself).
  useEffect(() => {
    setColDraft(config.columnOverrides);
  }, [config.columnOverrides]);

  const setColMode = useCallback((key: string, mode: ColumnMode) => {
    setColDraft((d) => ({ ...d, [key]: { ...d[key], mode } }));
  }, []);
  const setColValue = useCallback((key: string, value: string) => {
    setColDraft((d) => ({ ...d, [key]: { ...d[key], value } }));
  }, []);
  const toggleColRemoved = useCallback((key: string) => {
    setColDraft((d) => ({ ...d, [key]: { ...d[key], removed: !d[key].removed } }));
  }, []);
  // Per-value remap: set the replacement for one distinct extracted value.
  const setColValueMap = useCallback(
    (key: string, rawValue: string, replacement: string) => {
      setColDraft((d) => {
        const nextMap = { ...d[key].valueMap };
        if (replacement.trim() === "") delete nextMap[rawValue];
        else nextMap[rawValue] = replacement;
        return { ...d, [key]: { ...d[key], valueMap: nextMap } };
      });
    },
    [],
  );

  // Which columns have their per-value editor expanded.
  const [openValues, setOpenValues] = useState<Set<string>>(new Set());
  const toggleValuesOpen = useCallback((key: string) => {
    setOpenValues((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  // Which distinct value is currently selected in each column's rename dropdown.
  const [remapPick, setRemapPick] = useState<Record<string, string>>({});
  const pickRemap = useCallback((key: string, value: string) => {
    setRemapPick((m) => ({ ...m, [key]: value }));
  }, []);

  const columnsDirty = useMemo(
    () => JSON.stringify(colDraft) !== JSON.stringify(config.columnOverrides),
    [colDraft, config.columnOverrides],
  );

  // The "Update CSV" action: commit the column draft into the live config.
  const applyColumns = useCallback(() => {
    up({ columnOverrides: colDraft });
  }, [colDraft, up]);

  const resetColumns = useCallback(() => {
    setColDraft(config.columnOverrides);
  }, [config.columnOverrides]);

  const selectPreset = useCallback(
    (id: string) => {
      const found = [...BUILTIN_CONFIGS, ...loadCustomConfigs()].find(
        (c) => c.id === id,
      );
      if (found) {
        setConfig(cloneConfig(found));
        setPresetName(BUILTIN_IDS.has(found.id) ? "" : found.name);
      }
    },
    [],
  );

  const pickFile = useCallback((f: File | null) => {
    if (!f) return;
    if (f.type && f.type !== "application/pdf") {
      setStatus({ kind: "error", message: "Please choose a PDF file." });
      return;
    }
    setFile(f);
    setItems(null);
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
    setItems(null);
    setCellEdits({});
    try {
      const body = new FormData();
      body.append("file", file);

      const res = await fetch("/api/analyze", { method: "POST", body });
      const data = (await res.json()) as
        | { items: RawLineItem[]; warnings?: string[] }
        | { error: string };

      if (!res.ok || "error" in data) {
        const message =
          "error" in data ? data.error : `Request failed (${res.status}).`;
        setStatus({ kind: "error", message });
        return;
      }

      setItems(data.items);
      setStatus({ kind: "done", count: data.items.length });

      const entry: HistoryEntry = {
        id: Date.now().toString(),
        filename: file.name,
        timestamp: Date.now(),
        rowCount: data.items.length,
        items: data.items,
        config: cloneConfig(config),
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
  }, [file, config]);

  const saveCsv = useCallback((csv: string, filename: string) => {
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename.replace(/\.pdf$/i, "") + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  // History downloads regenerate from raw items (no per-cell edits apply — those
  // belong to the live document currently open).
  const downloadWith = useCallback(
    (srcItems: RawLineItem[], cfg: CompanyConfig, filename: string) => {
      saveCsv(generateCsv(applyConfig(srcItems, cfg), activeColumns(cfg)), filename);
    },
    [saveCsv],
  );

  // Main download uses the overlaid rows so manual cell edits are included.
  const download = useCallback(() => {
    if (!items || !file) return;
    saveCsv(generateCsv(rows, columns), file.name);
  }, [items, file, rows, columns, saveCsv]);

  const savePreset = useCallback(() => {
    const name = presetName.trim();
    if (!name) return;
    setCustomConfigs((prev) => {
      // Overwrite an existing custom preset with the same name, else add new.
      const existing = prev.find((c) => c.name === name);
      const id = existing ? existing.id : `custom-${Date.now()}`;
      const saved: CompanyConfig = { ...cloneConfig(config), id, name };
      const next = existing
        ? prev.map((c) => (c.id === id ? saved : c))
        : [...prev, saved];
      saveCustomConfigs(next);
      setConfig(cloneConfig(saved));
      return next;
    });
  }, [config, presetName]);

  const deletePreset = useCallback(() => {
    if (BUILTIN_IDS.has(config.id)) return;
    setCustomConfigs((prev) => {
      const next = prev.filter((c) => c.id !== config.id);
      saveCustomConfigs(next);
      return next;
    });
    setConfig(cloneConfig(GENERIC_CONFIG));
    setPresetName("");
  }, [config.id]);

  const reset = useCallback(() => {
    setFile(null);
    setItems(null);
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

  // Fabric-mapping editor helpers (fabricNameMap + itemCodeMap share keys).
  const fabricKeys = useMemo(() => {
    const set = new Set<string>([
      ...Object.keys(config.fabricNameMap),
      ...Object.keys(config.itemCodeMap),
    ]);
    return Array.from(set);
  }, [config.fabricNameMap, config.itemCodeMap]);

  const setMapping = useCallback(
    (key: string, field: "name" | "code", value: string) => {
      setConfig((c) => {
        if (field === "name") {
          return { ...c, fabricNameMap: { ...c.fabricNameMap, [key]: value } };
        }
        return { ...c, itemCodeMap: { ...c.itemCodeMap, [key]: value } };
      });
    },
    [],
  );

  const removeMapping = useCallback((key: string) => {
    setConfig((c) => {
      const fn = { ...c.fabricNameMap };
      const ic = { ...c.itemCodeMap };
      delete fn[key];
      delete ic[key];
      return { ...c, fabricNameMap: fn, itemCodeMap: ic };
    });
  }, []);

  const [newFabricKey, setNewFabricKey] = useState("");
  const addMapping = useCallback(() => {
    const key = newFabricKey.trim().toLowerCase();
    if (!key) return;
    setConfig((c) => ({
      ...c,
      fabricNameMap: { [key]: c.fabricNameMap[key] ?? "", ...c.fabricNameMap },
      itemCodeMap: { [key]: c.itemCodeMap[key] ?? "", ...c.itemCodeMap },
    }));
    setNewFabricKey("");
  }, [newFabricKey]);

  const loading = status.kind === "loading";
  const isCustom = !BUILTIN_IDS.has(config.id);

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

          {/* ═══════════════════════════ UPLOAD TAB ═══════════════════════════ */}
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
                  Upload a fabric purchase-order PDF, then tune the output to each
                  company&apos;s format and re-generate the CSV instantly — no
                  re-upload needed.
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
                  animate={dragging ? { scale: 1.015, borderColor: "#3b82f6" } : {}}
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
                    disabled={loading || (!file && !items)}
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

              {/* ── Company config panel ── */}
              <AnimatePresence>
                {items && items.length > 0 && (
                  <motion.div
                    className="card"
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    transition={{ duration: 0.35 }}
                  >
                    <div className="card-header">
                      <span className="card-title">Company Format</span>
                      <div className="preset-picker">
                        <select
                          value={config.id}
                          onChange={(e) => selectPreset(e.target.value)}
                        >
                          <optgroup label="Built-in">
                            {BUILTIN_CONFIGS.map((c) => (
                              <option key={c.id} value={c.id}>{c.name}</option>
                            ))}
                          </optgroup>
                          {customConfigs.length > 0 && (
                            <optgroup label="Saved">
                              {customConfigs.map((c) => (
                                <option key={c.id} value={c.id}>{c.name}</option>
                              ))}
                            </optgroup>
                          )}
                        </select>
                      </div>
                    </div>

                    <p className="hint" style={{ marginTop: 0 }}>
                      For each column pick <strong>Extracted</strong>, a{" "}
                      <strong>Custom</strong> value, or <strong>Blank</strong> —
                      or remove the column entirely. In{" "}
                      <strong>Extracted</strong> mode, click{" "}
                      <strong>Rename a value</strong> to pick one value and
                      change only it (e.g. only <em>Rib</em> →{" "}
                      <em>2×2 Lycra</em>). Then press <strong>Update CSV</strong>{" "}
                      and save it as a preset.
                    </p>

                    {/* ── Per-column editor (the simple, primary control) ── */}
                    <div className="col-editor">
                      <div className="col-row col-head">
                        <span>Column</span>
                        <span>Output</span>
                        <span>Custom value</span>
                        <span>Drop</span>
                      </div>
                      {COLUMNS.map((c) => {
                        const o = colDraft[c.key];
                        if (!o) return null;
                        const distinct = distinctByColumn[c.key] ?? [];
                        const sample = distinct[0] ?? "";
                        const canRemap =
                          o.mode === "extracted" &&
                          !o.removed &&
                          distinct.length >= 2;
                        const mapCount = Object.keys(o.valueMap).length;
                        const open = openValues.has(c.key);
                        return (
                          <Fragment key={c.key}>
                            <div
                              className={`col-row${o.removed ? " removed" : ""}`}
                            >
                              <span className="col-name">
                                <span className="col-name-line">
                                  {c.label}
                                  {canRemap && (
                                    <button
                                      type="button"
                                      className={`col-values-toggle${
                                        open ? " open" : ""
                                      }`}
                                      onClick={() => toggleValuesOpen(c.key)}
                                    >
                                      {mapCount > 0
                                        ? `${mapCount} renamed`
                                        : "Rename a value"}
                                    </button>
                                  )}
                                </span>
                                {sample &&
                                  o.mode === "extracted" &&
                                  !o.removed && (
                                    <span className="col-sample">
                                      e.g. {sample}
                                    </span>
                                  )}
                              </span>
                              <select
                                value={o.mode}
                                disabled={o.removed}
                                onChange={(e) =>
                                  setColMode(c.key, e.target.value as ColumnMode)
                                }
                              >
                                <option value="extracted">Extracted</option>
                                <option value="custom">Custom…</option>
                                <option value="blank">Blank</option>
                              </select>
                              <input
                                type="text"
                                value={o.value}
                                disabled={o.removed || o.mode !== "custom"}
                                onChange={(e) =>
                                  setColValue(c.key, e.target.value)
                                }
                                placeholder={
                                  o.mode === "custom" ? "type value…" : "—"
                                }
                              />
                              <label
                                className="col-remove"
                                title="Drop this column from the CSV"
                              >
                                <input
                                  type="checkbox"
                                  checked={o.removed}
                                  onChange={() => toggleColRemoved(c.key)}
                                />
                              </label>
                            </div>

                            {canRemap && open && (() => {
                              const picked = remapPick[c.key] ?? distinct[0] ?? "";
                              return (
                                <div className="col-values">
                                  <p className="col-values-hint">
                                    Pick the {c.label.toLowerCase()} you want to
                                    change, type its new value, then press Update
                                    CSV. Only that value changes.
                                  </p>
                                  <div className="col-remap">
                                    <select
                                      value={picked}
                                      onChange={(e) =>
                                        pickRemap(c.key, e.target.value)
                                      }
                                    >
                                      {distinct.map((v) => (
                                        <option key={v} value={v}>
                                          {(v || "(blank)") +
                                            (o.valueMap[v]
                                              ? ` → ${o.valueMap[v]}`
                                              : "")}
                                        </option>
                                      ))}
                                    </select>
                                    <span className="col-value-arrow">→</span>
                                    <input
                                      type="text"
                                      value={o.valueMap[picked] ?? ""}
                                      placeholder={`keep “${picked}”`}
                                      onChange={(e) =>
                                        setColValueMap(
                                          c.key,
                                          picked,
                                          e.target.value,
                                        )
                                      }
                                    />
                                  </div>
                                  {mapCount > 0 && (
                                    <div className="col-remap-list">
                                      {Object.entries(o.valueMap).map(
                                        ([from, to]) => (
                                          <span
                                            className="col-remap-chip"
                                            key={from}
                                          >
                                            {(from || "(blank)") + " → " + to}
                                            <button
                                              type="button"
                                              onClick={() =>
                                                setColValueMap(c.key, from, "")
                                              }
                                              title="Remove this rename"
                                            >
                                              ×
                                            </button>
                                          </span>
                                        ),
                                      )}
                                    </div>
                                  )}
                                </div>
                              );
                            })()}
                          </Fragment>
                        );
                      })}
                    </div>

                    <div className="col-actions">
                      <motion.button
                        className="btn btn-primary btn-sm"
                        onClick={applyColumns}
                        disabled={!columnsDirty}
                        whileHover={columnsDirty ? { scale: 1.03 } : {}}
                        whileTap={columnsDirty ? { scale: 0.97 } : {}}
                      >
                        Update CSV{columnsDirty ? " •" : ""}
                      </motion.button>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={resetColumns}
                        disabled={!columnsDirty}
                      >
                        Discard changes
                      </button>
                      {columnsDirty && (
                        <span className="col-dirty-note">
                          Unsaved column changes — press Update CSV to apply.
                        </span>
                      )}
                    </div>

                    {/* ── Advanced extraction settings (collapsible) ── */}
                    <details className="advanced">
                      <summary>Advanced extraction settings</summary>

                      <p className="hint" style={{ marginTop: 12 }}>
                        These control how the <em>Extracted</em> value is derived
                        from the PDF for this company. Most users never need
                        these.
                      </p>

                    <div className="cfg-grid">
                      <Field label="Style / PO source">
                        <select
                          value={config.stylePoSource}
                          onChange={(e) =>
                            up({ stylePoSource: e.target.value as CompanyConfig["stylePoSource"] })
                          }
                        >
                          <option value="styleCode">Per-booking style code (MS09B)</option>
                          <option value="bookingNumber">Booking number (1, 2, 3)</option>
                          <option value="documentPo">Document PO (CZ 02/2025)</option>
                        </select>
                      </Field>

                      <Field label="GSM source">
                        <select
                          value={config.gsmSource}
                          onChange={(e) =>
                            up({ gsmSource: e.target.value as CompanyConfig["gsmSource"] })
                          }
                        >
                          <option value="heading">Per-booking table heading</option>
                          <option value="metadata">Fabric metadata block</option>
                        </select>
                      </Field>

                      <Field label="Color / Code">
                        <select
                          value={config.colorMode}
                          onChange={(e) =>
                            up({ colorMode: e.target.value as CompanyConfig["colorMode"] })
                          }
                        >
                          <option value="full">Keep full (with Pantone/codes)</option>
                          <option value="clean">Clean to pure name</option>
                        </select>
                      </Field>

                      <Field label="Width">
                        <select
                          value={config.widthMode}
                          onChange={(e) =>
                            up({ widthMode: e.target.value as CompanyConfig["widthMode"] })
                          }
                        >
                          <option value="asExtracted">As written</option>
                          <option value="normalize">Normalize (Inch Open)</option>
                        </select>
                      </Field>

                      <Field label="Special Instruction">
                        <select
                          value={config.specialMode}
                          onChange={(e) =>
                            up({ specialMode: e.target.value as CompanyConfig["specialMode"] })
                          }
                        >
                          <option value="asExtracted">As extracted</option>
                          <option value="blank">Always blank</option>
                          <option value="fixed">Fixed value…</option>
                        </select>
                      </Field>

                      {config.specialMode === "fixed" && (
                        <Field label="Fixed instruction value">
                          <input
                            type="text"
                            value={config.specialFixedValue}
                            onChange={(e) => up({ specialFixedValue: e.target.value })}
                            placeholder="e.g. Y/D"
                          />
                        </Field>
                      )}

                      <Field label="Qty Unit">
                        <input
                          type="text"
                          value={config.qtyUnit}
                          onChange={(e) => up({ qtyUnit: e.target.value })}
                        />
                      </Field>

                      <Field label="Backorder Type">
                        <input
                          type="text"
                          value={config.backorderType}
                          onChange={(e) => up({ backorderType: e.target.value })}
                        />
                      </Field>

                      <Field label="Default Unit Price">
                        <input
                          type="text"
                          value={config.defaultUnitPrice}
                          onChange={(e) => up({ defaultUnitPrice: e.target.value })}
                          placeholder="(blank)"
                        />
                      </Field>

                      <Field label="Work-Type value">
                        <input
                          type="text"
                          value={config.workTypeValue}
                          onChange={(e) => up({ workTypeValue: e.target.value })}
                        />
                      </Field>
                    </div>

                    <div className="cfg-toggles">
                      <label className="cfg-check">
                        <input
                          type="checkbox"
                          checked={config.stylePoStripSuffix}
                          onChange={(e) => up({ stylePoStripSuffix: e.target.checked })}
                        />
                        Strip trailing “(…)” from Style / PO
                      </label>
                    </div>

                    {/* Fabric name / item-code mappings */}
                    <div className="cfg-subhead">Fabric mappings</div>
                    <div className="map-table">
                      <div className="map-row map-head">
                        <span>Raw name (from PDF)</span>
                        <span>Display name</span>
                        <span>Item code</span>
                        <span />
                      </div>
                      {fabricKeys.map((key) => (
                        <div className="map-row" key={key}>
                          <span className="map-key">{key}</span>
                          <input
                            type="text"
                            value={config.fabricNameMap[key] ?? ""}
                            onChange={(e) => setMapping(key, "name", e.target.value)}
                            placeholder="(keep as-is)"
                          />
                          <input
                            type="text"
                            value={config.itemCodeMap[key] ?? ""}
                            onChange={(e) => setMapping(key, "code", e.target.value)}
                            placeholder="(none)"
                          />
                          <button
                            className="btn btn-ghost btn-sm btn-icon"
                            onClick={() => removeMapping(key)}
                            title="Remove mapping"
                          >
                            <IconTrash />
                          </button>
                        </div>
                      ))}
                      <div className="map-row map-add">
                        <input
                          type="text"
                          value={newFabricKey}
                          onChange={(e) => setNewFabricKey(e.target.value)}
                          placeholder="add fabric key, e.g. rib"
                          onKeyDown={(e) => e.key === "Enter" && addMapping()}
                        />
                        <button className="btn btn-ghost btn-sm" onClick={addMapping}>
                          + Add mapping
                        </button>
                      </div>
                    </div>
                    </details>

                    {/* Save / delete preset */}
                    <div className="cfg-save">
                      <input
                        type="text"
                        value={presetName}
                        onChange={(e) => setPresetName(e.target.value)}
                        placeholder="Preset name (e.g. CZ Dia)"
                      />
                      <button
                        className="btn btn-primary btn-sm"
                        onClick={savePreset}
                        disabled={!presetName.trim()}
                      >
                        Save preset
                      </button>
                      {isCustom && (
                        <button
                          className="btn btn-ghost btn-sm"
                          onClick={deletePreset}
                        >
                          Delete “{config.name}”
                        </button>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* ── Preview / download ── */}
              <AnimatePresence>
                {items && items.length > 0 && (
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
                          ({rows.length} row{rows.length === 1 ? "" : "s"} ·{" "}
                          {config.name}
                          {editCount > 0
                            ? ` · ${editCount} edit${editCount === 1 ? "" : "s"}`
                            : ""}
                          )
                        </span>
                      </span>
                      <div className="preview-actions">
                        {editCount > 0 && (
                          <button
                            className="btn btn-ghost btn-sm"
                            onClick={clearCellEdits}
                            title="Revert all manual cell edits"
                          >
                            Clear edits
                          </button>
                        )}
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
                    </div>

                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            {columns.map((c) => (
                              <th key={c.key}>{c.label}</th>
                            ))}
                          </tr>
                          <tr className="code-row">
                            {columns.map((c) => (
                              <th key={c.key}>{c.code}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row, i) => (
                            <tr key={i}>
                              {columns.map((c) => {
                                const k = `${i}:${c.key}`;
                                const edited = k in cellEdits;
                                const value = row[c.key] ?? "";
                                return (
                                  <td
                                    key={c.key}
                                    className={`cell${edited ? " edited" : ""}`}
                                  >
                                    <input
                                      className="cell-input"
                                      value={value}
                                      spellCheck={false}
                                      onChange={(e) =>
                                        setCell(i, c.key, e.target.value)
                                      }
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
                      Row 1 = labels · Row 2 = ERP field codes. Every cell is
                      editable — click any value to change just that row. Column
                      controls above set the defaults; individual edits win.
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {/* ═══════════════════════════ HISTORY TAB ═══════════════════════════ */}
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
                  Re-download any previously extracted CSV — with the currently
                  selected company format — without re-uploading the PDF.
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
                            <span className="history-name">{entry.filename}</span>
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
                                downloadWith(entry.items, config, entry.filename)
                              }
                              whileHover={{ scale: 1.05 }}
                              whileTap={{ scale: 0.95 }}
                              title={`Download using “${config.name}” format`}
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
