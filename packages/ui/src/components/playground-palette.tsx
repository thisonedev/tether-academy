'use client';

import { Bot, Filter, FolderOpen, type LucideIcon } from 'lucide-react';
import { CATEGORY_CLASSES, PLAYGROUND_NODE_DEFS } from './playground-node-defs.js';

const KIND_ICON: Record<string, LucideIcon> = {
  'read-file': FolderOpen,
  filter: Filter,
  'ai-agent': Bot,
};

export const PLAYGROUND_DRAG_MIME = 'application/x-playground-node-kind';

/** Small on purpose: proving drag mechanics matters here, not palette breadth. */
export function PlaygroundPalette() {
  // Start is always on the canvas already, not something you drag in.
  const kinds = Object.values(PLAYGROUND_NODE_DEFS).filter((def) => def.kind !== 'start');

  return (
    <div className="flex w-60 shrink-0 flex-col border-r border-canvas-border bg-canvas p-2.5 font-mono">
      <div className="mb-2 px-1.5 text-[11px] font-semibold uppercase tracking-wide text-canvas-muted-foreground">
        Blocks
      </div>
      {kinds.map((def) => {
        const Icon = KIND_ICON[def.kind];
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: HTML5 drag source, not a click target
          <div
            key={def.kind}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(PLAYGROUND_DRAG_MIME, def.kind);
              e.dataTransfer.effectAllowed = 'move';
            }}
            className="mb-1.5 flex cursor-grab items-center gap-2.5 rounded-lg border border-canvas-border bg-canvas-muted px-2.5 py-2 text-[12.5px] font-medium text-canvas-foreground active:cursor-grabbing"
          >
            <span className={`flex size-7 shrink-0 items-center justify-center rounded-md border ${CATEGORY_CLASSES[def.category]}`}>
              {Icon ? <Icon className="size-3.5" strokeWidth={2} /> : null}
            </span>
            {def.label}
          </div>
        );
      })}
    </div>
  );
}
