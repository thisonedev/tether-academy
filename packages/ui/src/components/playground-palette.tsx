'use client';

import {
  Bot,
  CircleCheck,
  FileQuestion,
  FileText,
  Filter,
  FolderOpen,
  GitBranch,
  Image as ImageIcon,
  Languages,
  type LucideIcon,
  Mic,
  Music,
  Pencil,
  Repeat,
  ScanText,
  Search,
  Tags,
  Video,
  Volume2,
  Zap,
} from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { CATEGORY_CLASSES, PLAYGROUND_NODE_DEFS } from './playground-node-defs.js';
import type { PlaygroundCategory, PlaygroundNodeKindDef } from './playground-types.js';

const KIND_ICON: Record<string, LucideIcon> = {
  start: Zap,
  'read-file': FolderOpen,
  'text-input': FileText,
  filter: Filter,
  'ai-agent': Bot,
  if: GitBranch,
  'iterate-ai': Repeat,
  translate: Languages,
  'ask-doc': FileQuestion,
  'search-documents': Search,
  'text-to-speech': Volume2,
  'speech-to-text': Mic,
  'generate-image': ImageIcon,
  'generate-video': Video,
  'generate-music': Music,
  ocr: ScanText,
  'classify-image': Tags,
  'ask-confirmation': CircleCheck,
};

const CATEGORY_LABEL: Record<PlaygroundCategory, string> = {
  trigger: 'Trigger',
  data: 'Files & Data',
  logic: 'Logic',
  'ai-text': 'Text',
  'ai-voice': 'Voice',
  'ai-media': 'Media',
  interface: 'Interface',
};

// Root at the bottom, crown at the top: read the palette from the bottom up
// and it's the same order a body stands in.
const CATEGORY_ORDER: PlaygroundCategory[] = [
  'interface',
  'ai-media',
  'ai-voice',
  'ai-text',
  'logic',
  'data',
  'trigger',
];

export const PLAYGROUND_DRAG_MIME = 'application/x-playground-node-kind';

function groupByCategory(defs: PlaygroundNodeKindDef[]): [PlaygroundCategory, PlaygroundNodeKindDef[]][] {
  const groups = new Map<PlaygroundCategory, PlaygroundNodeKindDef[]>();
  for (const def of defs) {
    const list = groups.get(def.category) ?? [];
    list.push(def);
    groups.set(def.category, list);
  }
  return CATEGORY_ORDER.filter((c) => groups.has(c)).map((c) => [c, groups.get(c) ?? []]);
}

export interface PlaygroundPaletteProps {
  workflowName: string;
  editingName: boolean;
  onStartEditing: () => void;
  onNameChange: (value: string) => void;
  onCommitName: () => void;
}

/** Icon-only grid grouped by category; the label only shows on hover/tap, so the
 *  palette stays compact as more node kinds land instead of growing a full-width row each time. */
export function PlaygroundPalette({
  workflowName,
  editingName,
  onStartEditing,
  onNameChange,
  onCommitName,
}: PlaygroundPaletteProps) {
  const [activeKind, setActiveKind] = useState<string | null>(null);
  // Portaled and fixed-positioned from the hovered icon's own rect: the sidebar's
  // overflow-y-auto also clips overflow-x per the CSS spec, which cut an absolutely
  // positioned tooltip off at the sidebar's edge instead of into the canvas.
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null);
  // Start stays in the list (not filtered out) so trigger/red still shows in the
  // palette; it just can't be dragged, since it's a singleton already on the canvas.
  const kinds = Object.values(PLAYGROUND_NODE_DEFS);

  const activeDef = activeKind ? PLAYGROUND_NODE_DEFS[activeKind] : null;
  const showTooltip = (kind: string, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    setTooltipPos({ left: Math.min(rect.left, window.innerWidth - 230), top: rect.bottom + 6 });
    setActiveKind(kind);
  };

  return (
    <div className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto border-r border-canvas-border bg-canvas p-2.5 font-mono">
      {editingName ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: opened by the user's own click on the name right next to it
          autoFocus
          value={workflowName}
          onChange={(e) => onNameChange(e.target.value)}
          onBlur={onCommitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onCommitName();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCommitName();
            }
          }}
          className="rounded border border-emerald-500/60 bg-canvas px-1.5 py-1 text-[13px] font-semibold text-canvas-foreground focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
        />
      ) : (
        <button
          type="button"
          onClick={onStartEditing}
          className="group flex items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors hover:bg-canvas-muted"
          title="Rename workflow"
        >
          <span className="truncate text-[13px] font-semibold text-canvas-foreground">{workflowName}</span>
          <Pencil className="size-3 shrink-0 text-canvas-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      )}
      {groupByCategory(kinds).map(([category, defs]) => (
        <div key={category}>
          <div className="mb-1.5 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-canvas-muted-foreground/70">
            {CATEGORY_LABEL[category]}
          </div>
          <div className="flex flex-wrap gap-2">
            {defs.map((def) => {
              const Icon = KIND_ICON[def.kind];
              const canDrag = !def.inactive && def.kind !== 'start';
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drag source; click/hover only reveal the label tooltip
                <div
                  key={def.kind}
                  draggable={canDrag}
                  onDragStart={(e) => {
                    if (!canDrag) return;
                    e.dataTransfer.setData(PLAYGROUND_DRAG_MIME, def.kind);
                    e.dataTransfer.effectAllowed = 'move';
                  }}
                  onMouseEnter={(e) => showTooltip(def.kind, e.currentTarget)}
                  onMouseLeave={() => setActiveKind((k) => (k === def.kind ? null : k))}
                  onClick={(e) => showTooltip(activeKind === def.kind ? '' : def.kind, e.currentTarget)}
                  className={`flex size-11 items-center justify-center rounded-lg border ${CATEGORY_CLASSES[def.category]} ${
                    canDrag ? 'cursor-grab active:cursor-grabbing' : 'cursor-not-allowed'
                  } ${def.inactive ? 'opacity-40' : ''}`}
                >
                  {Icon ? <Icon className="size-5" strokeWidth={2} /> : null}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {activeDef &&
        tooltipPos &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[60] max-w-[220px] whitespace-nowrap rounded-md border border-canvas-border bg-canvas-muted px-2 py-1 text-[11px] font-medium text-canvas-foreground shadow-xl"
            style={{ left: tooltipPos.left, top: tooltipPos.top }}
          >
            {activeDef.label}
            {activeDef.kind !== 'start' && activeDef.inactive ? ' (coming soon)' : ''}
          </div>,
          document.body,
        )}
    </div>
  );
}
