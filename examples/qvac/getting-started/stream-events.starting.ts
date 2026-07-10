import {
  completion,
  loadModel,
  unloadModel,
  QWEN3_600M_INST_Q4,
  type CompletionEvent,
} from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelConfig: { ctx_size: 4096 },
  });

  // 1: call completion() with captureThinking: true and stream: true

  // 2: iterate result.events with a switch on event.type

  await unloadModel({ modelId });
}

main().catch(console.error);