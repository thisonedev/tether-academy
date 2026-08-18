// Host stages, read off the lines the peer worker already prints. Its phase
// reporter (apps/desktop/workers/peer/exec-host.cjs) writes `→ Label...` when a
// stage opens and `  ✓ Outcome (1.2s)` when it closes, both on stderr, so the
// rail needs no new plumbing. A same-device run prints neither and renders flat.

export interface StageLine {
  stream: string;
  line: string;
}

const STAGE_OPEN = /^→\s+(.+?)\s*$/;
const STAGE_CLOSE = /^\s*✓\s+(.+?)(?:\s+\((\d+(?:\.\d+)?)s\))?\s*$/;

export interface StageSegment {
  kind: 'stage';
  /** Wording when the stage opens. Preserved after close so the opener line
   *  doesn't get overwritten by the closer's text. */
  openLabel: string;
  /** Wording when the stage closes (or the open wording if it never closed). */
  closeLabel: string;
  /** 'note' is a ✓ with no opener, such as a stage the host skipped. */
  state: 'open' | 'done' | 'note';
  seconds: number | null;
}

export interface LinesSegment {
  kind: 'lines';
  /** Index of the first line, so the progress bar still renders at its own. */
  from: number;
  count: number;
}

export type RunSegment = StageSegment | LinesSegment;

/** Splits a run's output into stage rows and the output printed under each. */
export function splitStages(lines: StageLine[]): RunSegment[] {
  const segments: RunSegment[] = [];
  let open: StageSegment | null = null;

  for (let i = 0; i < lines.length; i++) {
    const entry = lines[i];
    if (typeof entry?.line !== 'string') continue;
    const fromHost = entry.stream === 'stderr';

    const opened = fromHost ? STAGE_OPEN.exec(entry.line) : null;
    if (opened) {
      open = { kind: 'stage', openLabel: opened[1], closeLabel: opened[1], state: 'open', seconds: null };
      segments.push(open);
      continue;
    }

    const closed = fromHost ? STAGE_CLOSE.exec(entry.line) : null;
    if (closed) {
      const seconds = closed[2] ? Number(closed[2]) : null;
      if (open) {
        // Closing in place: keep the opener wording on openLabel so the
        // transcript shows `→ Verifying the requesting device...` and
        // `✓ Device verified` as two distinct lines.
        open.closeLabel = closed[1];
        open.state = 'done';
        open.seconds = seconds;
        open = null;
      } else {
        segments.push({ kind: 'stage', openLabel: '', closeLabel: closed[1], state: 'note', seconds });
      }
      continue;
    }

    const last = segments[segments.length - 1];
    if (last?.kind === 'lines') last.count++;
    else segments.push({ kind: 'lines', from: i, count: 1 });
  }

  return segments;
}

/** `12.4s`, or `2m14s` past a minute, since `134.0s` takes a moment to read. */
export function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
}
