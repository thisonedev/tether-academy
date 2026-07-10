import { loadModel, completion, unloadModel, QWEN3_600M_INST_Q4 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  // 1: iterate result.events with a switch on event.type

  // 2: await result.final and log final.contentText and final.stopReason

  await unloadModel({ modelId });
}

main().catch(console.error);