import { loadModel, completion, unloadModel, QWEN3_600M_INST_Q4 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelConfig: { ctx_size: 4096 },
  });

  // 1: call completion() with captureThinking: true

  // 2: iterate result.events, switch on event.type for contentDelta and thinkingDelta

  // 3: after the loop, await result.final and log final.thinkingText if set

  await unloadModel({ modelId });
}

main().catch(console.error);