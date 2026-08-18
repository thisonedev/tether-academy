// Progress for the run console, read off the output a lesson already prints.
// Nothing here asks the lesson to cooperate: each matcher targets a line
// format that exists in packages/courses today, so a new lesson gets a bar
// for free as long as it prints one of them.

export interface LessonProgress {
  /** What the run is doing, e.g. "Downloading a model". */
  label: string;
  /** The counts behind the percentage, e.g. "512/1024 MB". */
  detail: string;
  percent: number;
  completed: boolean;
}

export interface ProgressLine {
  stream: string;
  line: string;
}

// `▸ Downloading 40% (512/1024 MB)`
const DOWNLOAD = /▸\s*Downloading\s+(\d+(?:\.\d+)?)%\s*\(([\d.]+)\/([\d.]+)\s*(\w+)\)/;
// `▸ step 3/16`, printed per diffusion step by the image lessons.
const IMAGE_STEP = /▸\s*step\s+(\d+)\/(\d+)/;
// `▸ decoding: 3/16`, the music lesson's stage stream.
const STAGE_STEP = /▸\s*([A-Za-z][\w -]*?):\s*(\d+)\/(\d+)\s*$/;
// `▸ epoch=1 step=5 batch=3/16`, the finetune trainer's tick.
const FINETUNE = /epoch=(\d+)\s+step=(\d+)\s+batch=(\d+)\/(\d+)/;
const FINETUNE_DONE = /(Training completed through step \d+|status:\s*COMPLETED)/;

function pct(current: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The most recent progress signal in the output, or null when there is none.
 * Later lines win, so a run that downloads and then generates moves from one
 * bar to the next instead of freezing on the finished download.
 */
export function parseProgress(lines: ProgressLine[]): LessonProgress | null {
  let latest: LessonProgress | null = null;
  // The trainer skips a tick on the last step, so the bar needs the completion
  // line to reach 100 rather than stalling just short of it.
  let finetuneBatches = 0;
  let finetuneDone = false;

  for (const { line } of lines) {
    if (typeof line !== 'string' || line.length === 0) continue;

    if (FINETUNE_DONE.test(line)) finetuneDone = true;

    const download = DOWNLOAD.exec(line);
    if (download) {
      const [, percent, current, total, unit] = download;
      const done = Math.max(0, Math.min(100, Math.round(Number(percent))));
      latest = {
        label: 'Downloading a model',
        detail: `${current}/${total} ${unit}`,
        percent: done,
        // Nothing follows a finished download until the run prints its own
        // progress, so say it landed rather than sitting at a full bar.
        completed: done >= 100,
      };
      continue;
    }

    const tick = FINETUNE.exec(line);
    if (tick) {
      const epoch = Number(tick[1]);
      const step = Number(tick[2]);
      if (Number(tick[4]) > finetuneBatches) finetuneBatches = Number(tick[4]);
      const totalEpochs = Math.max(1, Math.ceil(step / Math.max(1, finetuneBatches)));
      const totalSteps = totalEpochs * finetuneBatches;
      latest = {
        label: 'Fine-tuning a model',
        detail: `step ${step}/${totalSteps} (epoch ${epoch}/${totalEpochs})`,
        percent: pct(step, totalSteps),
        completed: false,
      };
      continue;
    }

    const step = IMAGE_STEP.exec(line);
    if (step) {
      const current = Number(step[1]);
      const total = Number(step[2]);
      latest = {
        label: 'Creating an image',
        detail: `${current}/${total}`,
        percent: pct(current, total),
        completed: false,
      };
      continue;
    }

    const stage = STAGE_STEP.exec(line);
    if (stage) {
      const current = Number(stage[2]);
      const total = Number(stage[3]);
      latest = {
        label: titleCase(stage[1].trim()),
        detail: `${current}/${total}`,
        percent: pct(current, total),
        completed: false,
      };
    }
  }

  if (latest && finetuneDone && latest.label === 'Fine-tuning a model') {
    return { ...latest, percent: 100, completed: true };
  }
  return latest;
}
