'use client';

import { BaseEdge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from '@xyflow/react';
import { Plus } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { PLAYGROUND_NODE_DEFS, typesCompatible } from './playground-node-defs.js';
import type { PlaygroundDataType } from './playground-types.js';

export interface PlaygroundEdgeData extends Record<string, unknown> {
  /** What's actually flowing through this wire: the source node's output type. */
  dataType: PlaygroundDataType;
  /** What the target node's input accepts, so an inserted node has to satisfy both ends. */
  targetType: PlaygroundDataType | null;
  onInsert: (edgeId: string, kind: string) => void;
}

/** Same bezier every default edge already draws, plus a "+" at the midpoint
 *  that opens a small kind picker and splices a node into the wire. */
export const PlaygroundFlowEdge = memo(function PlaygroundFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  data,
}: EdgeProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const edgeData = data as PlaygroundEdgeData | undefined;

  const candidates = edgeData
    ? Object.values(PLAYGROUND_NODE_DEFS).filter(
        (def) =>
          !def.inactive &&
          def.kind !== 'start' &&
          def.run &&
          typesCompatible(edgeData.dataType, def.input) &&
          (edgeData.targetType == null || typesCompatible(def.output, edgeData.targetType)),
      )
    : [];

  return (
    <>
      <BaseEdge id={id} path={edgePath} style={style} />
      <EdgeLabelRenderer>
        <div
          ref={menuRef}
          style={{
            position: 'absolute',
            // EdgeLabelRenderer's portal sits below `.react-flow__nodes` by default;
            // without this, a node card near the midpoint eats the menu's clicks.
            zIndex: 1000,
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          className="nodrag nopan"
        >
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((prev) => !prev);
            }}
            title="Insert a node on this wire"
            aria-label="Insert a node on this wire"
            className="flex size-4 items-center justify-center rounded-full border border-canvas-border bg-canvas text-canvas-muted-foreground shadow transition-colors hover:border-emerald-500/60 hover:text-emerald-400"
          >
            <Plus className="size-3" />
          </button>
          {open && candidates.length > 0 && (
            <div className="absolute left-1/2 top-full z-10 mt-1 w-48 -translate-x-1/2 rounded-md border border-canvas-border bg-canvas py-1 shadow-lg">
              {candidates.map((def) => (
                <button
                  key={def.kind}
                  type="button"
                  onClick={() => {
                    edgeData?.onInsert(id, def.kind);
                    setOpen(false);
                  }}
                  className="block w-full truncate px-2.5 py-1.5 text-left text-xs text-canvas-foreground hover:bg-canvas-muted"
                >
                  {def.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
