import { loadModel, QWEN3_600M_INST_Q4, getModelInfo } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  const info = await getModelInfo({ modelId });

  console.log("Quantization:", info.quantization);
  const fineTunableQuantizations = ["F32", "F16", "Q4_0", "Q8_0", "TQ1_0", "TQ2_0"];
  console.log(
    "Fine-tunable:",
    fineTunableQuantizations.includes(info.quantization) ? "yes" : "no",
  );
}

main().catch(console.error);
