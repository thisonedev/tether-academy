import { loadModel, QWEN3_600M_INST_Q4, finetune, unloadModel } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  // 1: call finetune() and store the handle

  // 2: iterate handle.progressStream and log each tick

  // 3: await handle.result and log the status

  await unloadModel({ modelId });
}

main().catch(console.error);