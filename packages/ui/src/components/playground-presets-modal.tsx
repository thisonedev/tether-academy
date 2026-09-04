'use client';

import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { loadPresets, type PresetEntry } from './playground-preset-data.js';

const CATEGORY_COLOR: Record<string, string> = {
  Text: '#4ade80',
  Translate: '#4ade80',
  Search: '#4ade80',
  OCR: '#818cf8',
  Classify: '#818cf8',
  Voice: '#60a5fa',
  Image: '#818cf8',
  Video: '#818cf8',
  Music: '#818cf8',
  Files: '#fb923c',
  Custom: '#c9a5f8',
};

export function PlaygroundPresetsModal({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (entry: PresetEntry) => void;
}) {
  const [presets, setPresets] = useState<PresetEntry[] | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');

  useEffect(() => {
    let cancelled = false;
    loadPresets().then((p) => {
      if (!cancelled) setPresets(p);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const categories = useMemo(() => ['All', ...Array.from(new Set((presets ?? []).map((p) => p.category)))], [presets]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (presets ?? []).filter((p) => {
      if (category !== 'All' && p.category !== category) return false;
      if (!q) return true;
      return p.workflow.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q);
    });
  }, [presets, query, category]);

  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center bg-black/55 pt-10" onClick={onClose}>
      <div
        className="flex max-h-[560px] w-[780px] flex-col overflow-hidden rounded-xl border border-canvas-border bg-canvas shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 border-b border-canvas-border px-4 py-3">
          <Search className="size-4 text-canvas-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search presets…"
            className="flex-1 rounded-md border border-canvas-border bg-canvas-muted px-2.5 py-1.5 font-mono text-[12.5px] text-canvas-foreground focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
          />
          <button type="button" onClick={onClose} className="text-canvas-muted-foreground hover:text-canvas-foreground">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5 px-4 pt-2.5">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategory(c)}
              className={`rounded-full border px-2.5 py-1 text-[11px] ${
                category === c
                  ? 'border-emerald-500/40 bg-emerald-500/12 text-canvas-foreground'
                  : 'border-canvas-border text-canvas-muted-foreground'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="grid flex-1 grid-cols-3 gap-2.5 overflow-y-auto p-4">
          {presets === null && <div className="col-span-3 text-center text-xs text-canvas-muted-foreground">Loading presets…</div>}
          {presets !== null && filtered.length === 0 && (
            <div className="col-span-3 text-center text-xs text-canvas-muted-foreground">No presets match.</div>
          )}
          {filtered.map((p) => {
            const color = CATEGORY_COLOR[p.category] ?? '#9aa4af';
            return (
              <button
                key={p.file}
                type="button"
                onClick={() => onSelect(p)}
                className="rounded-lg border border-canvas-border p-3 text-left transition-colors hover:border-emerald-500/40 hover:bg-canvas-muted"
              >
                <span
                  className="mb-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold"
                  style={{ color, backgroundColor: `color-mix(in oklab, ${color} 16%, transparent)` }}
                >
                  {p.category}
                </span>
                <div className="mb-1 truncate text-[12.5px] font-semibold text-canvas-foreground">{p.workflow.name}</div>
                <div className="text-[11px] leading-snug text-canvas-muted-foreground">{p.description}</div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
