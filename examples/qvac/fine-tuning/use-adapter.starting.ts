import { completion, loadModel, QWEN3_600M_INST_Q4, unloadModel } from "@qvac/sdk";

async function main() {
  // 1: load the model with modelConfig.lora

  // 2: build a history

  // 3: call completion and stream the result

  await unloadModel({ modelId });
}

main().catch(console.error);