import { loadModel, QWEN3_600M_INST_Q4, getModelInfo } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  // 1: call getModelInfo and read info.quantization

  // 2: check quantization against the allowlist and log the verdict
}

main().catch(console.error);