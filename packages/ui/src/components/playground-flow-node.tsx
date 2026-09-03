'use client';

import { Handle, type NodeProps, Position } from '@xyflow/react';
import {
  Bot,
  FileQuestion,
  Filter,
  FolderOpen,
  GitBranch,
  Languages,
  type LucideIcon,
  Repeat,
  Zap,
} from 'lucide-react';
import { type CSSProperties, memo } from 'react';
import { BRANCH_COLOR, CATEGORY_CLASSES, PLAYGROUND_NODE_DEFS, PORT_COLOR } from './playground-node-defs.js';
import type { PlaygroundDataType, PlaygroundNodeData } from './playground-types.js';

const KIND_ICON: Record<string, LucideIcon> = {
  'read-file': FolderOpen,
  filter: Filter,
  'ai-agent': Bot,
  if: GitBranch,
  'iterate-ai': Repeat,
  translate: Languages,
  'ask-doc': FileQuestion,
};

function portStyle(type: PlaygroundDataType): CSSProperties {
  const color = PORT_COLOR[type];
  const base: CSSProperties = { background: '#1b1f27', border: `2px solid ${color}` };
  if (type === 'table') return { ...base, width: 14, height: 10, borderRadius: 2 };
  if (type === 'value') return { ...base, width: 13, height: 13, borderRadius: '50%' };
  if (type === 'bool') return { ...base, width: 11, height: 11, transform: 'rotate(45deg)' };
  // Dashed to visually flag "accepts/forwards whichever type actually connects".
  if (type === 'any') return { ...base, width: 12, height: 12, borderRadius: '50%', borderStyle: 'dashed' };
  return { ...base, width: 10, height: 10, borderRadius: '50%' };
}

// A branch's color says "which path," not "what data type": a dashed `any`-colored
// circle on both Yes and No looked identical and read as a stuck loading spinner.
function branchPortStyle(branch: 'true' | 'false'): CSSProperties {
  return { background: '#1b1f27', border: `2px solid ${BRANCH_COLOR[branch]}`, width: 12, height: 12, borderRadius: '50%' };
}

export const PlaygroundFlowNode = memo(function PlaygroundFlowNode({
  data,
  selected,
}: NodeProps & { data: PlaygroundNodeData }) {
  const def = PLAYGROUND_NODE_DEFS[data.kind];
  if (!def) return null;
  const Icon = KIND_ICON[data.kind];
  const title = def.label;

  if (data.kind === 'start') {
    return (
      <div
        className={`relative flex size-12 items-center justify-center rounded-full border bg-canvas-muted font-mono shadow-lg ${
          selected ? 'border-fuchsia-400 ring-2 ring-fuchsia-400/40' : 'border-red-300/40'
        }`}
      >
        <div className="absolute -top-6 left-1/2 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap rounded-full border border-red-300/40 bg-red-300/15 px-2.5 py-0.5 text-[10px] font-semibold text-red-300">
          <Zap className="size-3" strokeWidth={2.5} />
          Trigger
        </div>
        <Zap className="size-5 text-red-300" strokeWidth={2} />
        <Handle
          type="source"
          position={Position.Bottom}
          style={{ ...portStyle('flow'), bottom: -6 }}
        />
      </div>
    );
  }

  return (
    <div
      className={`relative flex w-52 items-center gap-3 rounded-2xl border bg-canvas-muted px-3.5 py-3 font-mono shadow-lg ${
        data.hasError
          ? 'border-red-500 ring-2 ring-red-500/40'
          : selected
            ? 'border-fuchsia-400 ring-2 ring-fuchsia-400/40'
            : 'border-canvas-border'
      }`}
    >
      {def.input && (
        <Handle
          type="target"
          position={Position.Top}
          style={{ ...portStyle(def.input), top: -7 }}
        />
      )}
      <div
        className={`flex size-9 shrink-0 items-center justify-center rounded-lg border ${CATEGORY_CLASSES[def.category]}`}
      >
        {Icon ? <Icon className="size-4.5" strokeWidth={2} /> : null}
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-semibold text-canvas-foreground">{title}</div>
      </div>
      {def.output && def.dualOutput ? (
        <>
          <Handle
            type="source"
            id="true"
            position={Position.Bottom}
            style={{ ...branchPortStyle('true'), bottom: -7, left: '30%' }}
          />
          {/* Same 30%/70% reference as the handles, recentered with -translate-x-1/2. Pill-styled
           *  to match the Start node's "Trigger" badge; pointer-events-none so it can't steal
           *  the handle's drag-to-connect gesture the way plain text underneath it once did. */}
          <span className="pointer-events-none absolute left-[30%] top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-full border border-emerald-400/40 bg-emerald-400/15 px-2 py-0.5 text-[9px] font-semibold text-emerald-400">
            Yes
          </span>
          <Handle
            type="source"
            id="false"
            position={Position.Bottom}
            style={{ ...branchPortStyle('false'), bottom: -7, left: '70%' }}
          />
          <span className="pointer-events-none absolute left-[70%] top-full mt-2 -translate-x-1/2 whitespace-nowrap rounded-full border border-rose-400/40 bg-rose-400/15 px-2 py-0.5 text-[9px] font-semibold text-rose-400">
            No
          </span>
        </>
      ) : (
        def.output && (
          <Handle
            type="source"
            position={Position.Bottom}
            style={{ ...portStyle(def.output), bottom: -7 }}
          />
        )
      )}
    </div>
  );
});
