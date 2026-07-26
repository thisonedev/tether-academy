import { loadModel, QWEN3_600M_INST_Q4, getModelInfo } from "@qvac/sdk";

async function main() {
  await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });
  const info = await getModelInfo({ name: QWEN3_600M_INST_Q4.name });
  
  console.log("Quantization:", info.quantization);
  const quantization = info.quantization.toUpperCase().replace(/^Q(\d)$/, "Q$1_0");
  const fineTunableQuantizations = ["F32", "F16", "Q4_0", "Q8_0", "TQ1_0", "TQ2_0"];
  console.log(
    "Fine-tunable:",
    fineTunableQuantizations.includes(quantization) ? "yes" : "no",
  );
}

main().catch(console.error);



