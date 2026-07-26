import { loadModel, QWEN3_600M_INST_Q4, getModelInfo } from "@qvac/sdk";

async function main() {
  await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  // 1: call getModelInfo({ name: QWEN3_600M_INST_Q4.name }) and read info.quantization

  // 2: check quantization against the allowlist and log the verdict
}

main().catch(console.error);
