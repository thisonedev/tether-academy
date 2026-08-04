// @ts-check
'use strict';

// Drop known-harmless stderr: Chromium / Electron sandbox chatter, and the
// model-loader bookkeeping that llama.cpp / mmproj / QVAC SDK print while a
// vision model warms.

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
  // Vision model hparams dump from the multimodal plugin (SmolVLM2 etc).
  // The earlier `clip_model_loader: tensor[` rule only strips tensors; the
  // surrounding `clip_model_loader: <key>: <value>` lines don't carry signal
  // for a learner, so the whole `clip_model_loader:` prefix is dropped.
  /^clip_model_loader: /i,
  // Standalone delimiter lines inside the multimodal hparams dump, e.g.
  // `--- vision hparams ---` or `--- llm hparams ---`.
  /^--- (vision|llm|text|image|audio) hparams ---$/i,
  // Hugging Face download progress bars the addon prints to stderr alongside
  // (or instead of) the onProgress callback. The lesson uses an explicit
  // `console.log(\`▸ Downloading N% (X/Y MB)\`)` for the same data; the
  // addon-side bar just doubles it up. Strip both shapes: `tag|<bar> N/N - rate`
  // and the standalone `N%|###|` columns UI emits.
  /^[^|]+\|=+[>=]?\s*\d+\/\d+/,
  /^[^|]+:\s*\d+%\s*\|.*\|/,
  /^\d+%\s*\|.*\|/,
  // llama.cpp LOG_INF: `<tag>: <message>`. `llama_` covers every llama.cpp
  // call site; the allowlist below covers SDK helpers wrapping the same
  // logging without the prefix.
  /^llama_/i,
  /^(common_init_result|common_init_from_model_and_params|initFromConfig|parse|load_internals): /i,
  // ggml backend probing and the Metal device dump, both `<tag>: <message>`.
  // A crash's assert and frames don't match this shape, so it still shows up.
  /^ggml_[a-z0-9_]+: /i,
];

// Above this, a partial line is forwarded verbatim rather than held until the
// next newline, so a stream with no newline can't grow without bound.
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
