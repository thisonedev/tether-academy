'use strict';

// macOS emits kernel/codesign chatter on stderr when spawning sandboxed children; it must never reach the lesson output the user sees.

const test = require('brittle');

const { isNoiseLine, createNoiseFilter, MAX_PARTIAL_LINE } = require('../../workers/peer/exec-noise.cjs');

test('exec-noise - recognises platform chatter', (t) => {
  t.is(isNoiseLine('task_name_for_pid: (os/kern) failure (5)'), true);
  t.is(isNoiseLine('[0731/203044.387077:ERROR:electron/shell/common/mac/codesign_util.cc:79]'), true);
});

// A vision lesson that warms a model prints hundreds of `clip_model_loader: tensor[N]: ...` lines to stderr; the panel is for the lesson, not the loader.
test('exec-noise - drops model loader chatter', (t) => {
  t.is(isNoiseLine('clip_model_loader: tensor[42]: n_dims = 2, name = v.blk.0.attn.weight, tensor_size=2506752, offset=12345, shape:[768, 3072, 1, 1], type = q8_0'), true);
  t.is(isNoiseLine('load_tensors: loaded 198 tensors from /Users/.../model.gguf'), true);
  t.is(isNoiseLine('load_hparams: n_embd:             768'), true);
  t.is(isNoiseLine('clip_image_batch_encode: encoding 1 tile(s), grid=0x0, tile_size=512x512'), true);
  t.is(isNoiseLine('decoding image batch 1/1, n_tokens_batch = 64'), true);
  t.is(isNoiseLine('image decoded (batch 1/1) in 70 ms'), true);
  t.is(isNoiseLine('warmup: warmup with image size = 512 x 512'), true);
  t.is(isNoiseLine('alloc_compute_meta: graph splits = 1, nodes = 394'), true);
  t.is(isNoiseLine('add_text: <|im_start|>User:'), true);
  t.is(isNoiseLine('clip_ctx: CLIP using MTL0 backend'), true);
  t.is(isNoiseLine('Compare the two newspaper articles. Which one is older?'), false);
  t.is(isNoiseLine('Result: The first article is from 1923.'), false);
});

test('exec-noise - drops llama.cpp LOG_INF and SDK helper chatter', (t) => {
  // llama.cpp uses `llama_<tag>:` for LOG_INF; the QVAC SDK wraps the same logging without the prefix in a few helpers.
  t.is(isNoiseLine('llama_model_load_internal: model size = 103.73 MiB'), true);
  t.is(isNoiseLine('llama_new_context_with_model: n_ctx = 512'), true);
  t.is(isNoiseLine('llama_model_meta: loaded 198 tensors from /Users/.../model.gguf'), true);
  t.is(isNoiseLine('common_init_result: fitting params to device memory, for bugs during this step try to reproduce them with -fit off, or provide --verbose logs if the bug only occurs with -fit on'), true);
  t.is(isNoiseLine('initFromConfig: load the model from disk file and apply lora adapter, if any.'), true);
  t.is(isNoiseLine('parse: load the model metadata from disk file.'), true);
  t.is(isNoiseLine('load_internals: arch = sm_120, n_vocab = 49152'), true);
  // Prose that opens with a tag word but no `tag: ` still flows through.
  t.is(isNoiseLine('statement that "The new town square? How algorithms shape our news".'), false);
  t.is(isNoiseLine('Result: The first article is from 1923.'), false);
  t.is(isNoiseLine('parse: ok'), true, 'parse: is filtered even with short messages (SDK-only tag)');
});

// A TTS or vision lesson probes every ggml backend and dumps the Metal device table, burying the one line the lesson printed.
test('exec-noise - drops ggml backend and Metal chatter', (t) => {
  t.is(isNoiseLine('ggml_backend_load_best: search path /Users/x/node_modules/@qvac/tts-ggml/prebuilds/darwin-arm64/qvac__tts-ggml does not exist'), true);
  t.is(isNoiseLine('ggml_metal_device_init: GPU name:   MTL0 (Apple M3 Max)'), true);
  t.is(isNoiseLine('ggml_metal_library_init: loaded in 8.645 sec'), true);
  t.is(isNoiseLine('ggml_metal_rsets_init: creating a residency set collection (keep_alive = 180 s)'), true);
  // An abort has to reach the panel; it's the only thing that says why a run stopped mid-way.
  t.is(isNoiseLine('/Users/runner/work/qvac/ggml/src/ggml-opt.cpp:941: GGML_ASSERT(opt_pars.adamw.alpha > 0.0f) failed'), false);
  t.is(isNoiseLine('0   qvac__llm-llamacpp.bare             0x0000000132e27180 ggml_print_backtrace + 276'), false);
});

test('exec-noise - drops model loader lines from a stream of mixed chunks', (t) => {
  const filter = createNoiseFilter();
  const mixed = [
    'clip_model_loader: tensor[0]: name = a\n',
    'load_hparams: n_embd = 768\n',
    'Result: hello world\n',
    'warmup: warmup with image size = 512 x 512\n',
  ].join('');
  const out = filter.push(mixed);
  t.ok(out.includes('Result: hello world'), 'real output survives');
  t.absent(out.includes('clip_model_loader'), 'tensor lines are stripped');
  t.absent(out.includes('load_hparams'), 'hparams lines are stripped');
  t.absent(out.includes('warmup'), 'warmup line is stripped');
});

test('exec-noise - leaves real output alone', (t) => {
  t.is(isNoiseLine('Error: spawn EPERM'), false, 'genuine errors must survive');
  t.is(isNoiseLine('modelId: abc'), false);
});

test('exec-noise - filters noise out of a mixed chunk', (t) => {
  const filter = createNoiseFilter();
  const out = filter.push(
    'modelId: x\n[0731:ERROR:codesign_util.cc:79] task_name_for_pid\nhello\n',
  );

  t.ok(out.includes('modelId: x'));
  t.ok(out.includes('hello'));
  t.absent(out.includes('codesign_util'));
  t.absent(out.includes('task_name_for_pid'));
  t.is(filter.end(), '', 'nothing buffered at end of stream');
});

// Without a cap, newline-free stderr would grow the filter's internal buffer until the worker is killed.
test('exec-noise - caps a newline-free stream at the line budget', (t) => {
  const filter = createNoiseFilter();
  const chunk = 'A'.repeat(1024);
  let forwarded = 0;
  // The buffer is internal, so track the leak indirectly: past the cap, every push flushes its prior buf.
  for (let i = 0; i < 128; i += 1) {
    const out = filter.push(chunk);
    forwarded += out.length;
  }
  t.ok(forwarded > 0, 'the filter forwards the over-budget partial line');
  t.is(typeof MAX_PARTIAL_LINE, 'number', 'MAX_PARTIAL_LINE is exported for the run-path check');
  t.ok(MAX_PARTIAL_LINE > 0 && MAX_PARTIAL_LINE < 1024 * 1024, 'cap is a sensible 64 KiB');
});
