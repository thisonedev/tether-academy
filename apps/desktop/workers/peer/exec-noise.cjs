// @ts-check
'use strict';

// Drop known-harmless stderr: Chromium / Electron sandbox chatter, and
// the model-loader bookkeeping that llama.cpp / mmproj / QVAC SDK
// print while a vision model warms. A successful lesson that touches a
// vision model otherwise dumps hundreds of tensor lines into the output
// panel.

const NOISE_LINE = [
  // Chromium / Electron / sandbox chatter.
  /codesign_util\.cc/i,
  /task_name_for_pid/i,
  /mach_port_rendezvous/i,
  /MachPortRendezvousServer/i,
  /bootstrap_check_in/i,
  /Permission denied \(1100\)/,
  // llama.cpp / mmproj / QVAC SDK model loader.
  /^clip_model_loader: tensor\[/i,
  /^load_tensors: /i,
  /^load_hparams: /i,
  /^clip_image_batch_encode: /i,
  /^decoding image batch /i,
  /^image decoded /i,
  /^warmup: /i,
  /^alloc_compute_meta: /i,
  /^add_text: /i,
  /^clip_ctx: /i,
  // llama.cpp LOG_INF: `<tag>: <message>`. The `llama_` prefix covers every
  // llama.cpp call site. The short allowlist below covers SDK helpers
  // that wrap the same logging without the prefix, and which the
  // screenshot showed dumping tens of lines into a vision lesson.
  /^llama_/i,
  /^(common_init_result|initFromConfig|parse|load_internals): /i,
  // ggml backend probing and the Metal device dump, both `<tag>: <message>`.
  // An abort prints its assert with a source path first and its frames with a
  // leading index, so neither matches this and a real crash still shows up.
  /^ggml_[a-z0-9_]+: /i,
];

// Above this, a partial line is forwarded verbatim rather than held until the
// next newline. The noise filter cannot match a line that long, and a stream
// that never emits a newline would otherwise grow without bound.
const MAX_PARTIAL_LINE = 64 * 1024;

function isNoiseLine(line) {
  const s = String(line);
  if (!s.trim()) return false;
  return NOISE_LINE.some((re) => re.test(s));
}

/**
 * Streaming line filter: returns text ready to forward; call end() for remainder.
 * @returns {{ push: (chunk: string) => string, end: () => string }}
 */
function createNoiseFilter() {
  let buf = '';
  return {
    push(chunk) {
      buf += String(chunk ?? '');
      // A stream with no newline would otherwise grow until the child dies
      // or the worker runs out of memory. Flush what is there as a line; a
      // partial line this long is not noise-matchable, and the host's own
      // output budget on the executor caps the total a run can dump.
      if (buf.length > MAX_PARTIAL_LINE) {
        const flush = buf;
        buf = '';
        return flush;
      }
      const parts = buf.split('\n');
      buf = parts.pop() ?? '';
      const kept = [];
      for (const line of parts) {
        if (!isNoiseLine(line)) kept.push(line);
      }
      if (kept.length === 0) return '';
      return `${kept.join('\n')}\n`;
    },
    end() {
      if (!buf) return '';
      const rest = buf;
      buf = '';
      return isNoiseLine(rest) ? '' : rest;
    },
  };
}

module.exports = {
  isNoiseLine,
  createNoiseFilter,
  MAX_PARTIAL_LINE,
};
