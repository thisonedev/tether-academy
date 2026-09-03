'use client';

import {
  Bot,
  FileQuestion,
  Filter,
  FolderOpen,
  GitBranch,
  Languages,
  type LucideIcon,
  Repeat,
} from 'lucide-react';
import { useState } from 'react';
import { CATEGORY_CLASSES, PLAYGROUND_NODE_DEFS } from './playground-node-defs.js';
import type { PlaygroundCategory, PlaygroundNodeKindDef } from './playground-types.js';

const KIND_ICON: Record<string, LucideIcon> = {
  'read-file': FolderOpen,
  filter: Filter,
  'ai-agent': Bot,
  if: GitBranch,
  'iterate-ai': Repeat,
  translate: Languages,
  'ask-doc': FileQuestion,
};

const CATEGORY_LABEL: Record<PlaygroundCategory, string> = {
  trigger: 'Trigger',
  conditions: 'Conditions',
  agent: 'AI agent',
  'ai-text': 'AI · Text',
  'ai-media': 'AI · Media',
  'ai-voice': 'AI · Voice',
  data: 'Files & data',
  transform: 'Transform',
  interface: 'Interface',
};

export const PLAYGROUND_DRAG_MIME = 'application/x-playground-node-kind';

function groupByCategory(defs: PlaygroundNodeKindDef[]): [PlaygroundCategory, PlaygroundNodeKindDef[]][] {
  const groups = new Map<PlaygroundCategory, PlaygroundNodeKindDef[]>();
  for (const def of defs) {
    const list = groups.get(def.category) ?? [];
    list.push(def);
    groups.set(def.category, list);
  }
  return [...groups.entries()];
}

/** Icon-only grid grouped by category; the label only shows on hover/tap, so the
 *  palette stays compact as more node kinds land instead of growing a full-width row each time. */
export function PlaygroundPalette() {
  const [activeKind, setActiveKind] = useState<string | null>(null);
  // Start is always on the canvas already, not something you drag in.
  const kinds = Object.values(PLAYGROUND_NODE_DEFS).filter((def) => def.kind !== 'start');

  return (
    <div className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto border-r border-canvas-border bg-canvas p-2.5 font-mono">
      <div className="px-1.5 text-[11px] font-semibold uppercase tracking-wide text-canvas-muted-foreground">
        Blocks
      </div>
      {groupByCategory(kinds).map(([category, defs]) => (
        <div key={category}>
          <div className="mb-1.5 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-canvas-muted-foreground/70">
            {CATEGORY_LABEL[category]}
          </div>
          <div className="flex flex-wrap gap-2">
            {defs.map((def) => {
              const Icon = KIND_ICON[def.kind];
              return (
                <div key={def.kind} className="relative">
                  {/* biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drag source; click/hover only reveal the label tooltip */}
                  <div
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData(PLAYGROUND_DRAG_MIME, def.kind);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onMouseEnter={() => setActiveKind(def.kind)}
                    onMouseLeave={() => setActiveKind((k) => (k === def.kind ? null : k))}
                    onClick={() => setActiveKind((k) => (k === def.kind ? null : def.kind))}
                    className={`flex size-11 cursor-grab items-center justify-center rounded-lg border active:cursor-grabbing ${CATEGORY_CLASSES[def.category]}`}
                  >
                    {Icon ? <Icon className="size-5" strokeWidth={2} /> : null}
                  </div>
                  {activeKind === def.kind && (
                    // Anchored to the icon's left edge, not centered: a centered tooltip on the
                    // leftmost column would spill past the sidebar's edge for longer labels.
                    <div className="pointer-events-none absolute left-0 top-full z-10 mt-1.5 whitespace-nowrap rounded-md border border-canvas-border bg-canvas-muted px-2 py-1 text-[11px] font-medium text-canvas-foreground shadow-xl">
                      {def.label}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
