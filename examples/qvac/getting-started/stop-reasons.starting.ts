import { completion, loadModel, unloadModel, QWEN3_600M_INST_Q4 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelConfig: { ctx_size: 4096 },
  });

  // 1: call completion() with generationParams: { predict: 10 } and stream: true

  // 2: iterate result.tokenStream to completion

  // 3: await result.final and read final.stopReason

  // 4: branch on final.stopReason and log a message

  await unloadModel({ modelId });
}

main().catch(console.error);