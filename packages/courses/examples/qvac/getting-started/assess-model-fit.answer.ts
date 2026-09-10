import {
  assessModelFit,
  QWEN3_600M_INST_Q4,
  QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL,
} from "@qvac/sdk";

async function main() {
  const result = await assessModelFit({
    models: [
      { model: QWEN3_600M_INST_Q4, workload: { kind: "llm", contextTokens: 8192 } },
      { model: QWEN3_8_27B_MULTIMODAL_UD_Q8_K_XL, workload: { kind: "llm", contextTokens: 8192 } },
    ],
    execution: "sequential",
    policy: "interactive-v1",
  });

  const gib = (n: number) => (n / 1024 ** 3).toFixed(2);
  if (result.budget) {
    console.log(`▸ Budget: ${gib(result.budget.availableAfterReserveBytes)} GiB free`);
  }

  for (const model of result.models) {
    console.log(`▸ ${model.name}: ${model.verdict}`);
  }

  console.log("▸ Combined verdict:", result.verdict);
}

main().catch(console.error);
