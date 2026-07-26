import { loadModel, QWEN3_600M_INST_Q4, finetune } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  const baseOptions = {
    trainDatasetDir: "./examples/qvac/fine-tuning/input/small_train_HF.jsonl",
    validation: { type: "dataset", path: "./examples/qvac/fine-tuning/input/small_eval_HF.jsonl" },
    numberOfEpochs: 1,
    learningRate: 1e-4,
    loraModules: "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
    assistantLossOnly: true,
    outputParametersDir: "./tether-academy-app-desktop/output/finetune/",
  };

  const handle = finetune({ modelId, options: baseOptions });

  try {
    let tickCount = 0;
    for await (const tick of handle.progressStream) {
      tickCount++;
      if (tickCount >= 3) {
        const pauseResult = await finetune({ operation: "pause", modelId });
        console.log("▸ Pausing... status:", pauseResult.status);
        break;
      }
    }
  } catch (err) {
    console.log("▸ Stream interrupted (worker cleanup crash):", err instanceof Error ? err.message : err);
  }

  const resumed = finetune({ modelId, ...baseOptions, operation: "resume" });
  await resumed.result;
  console.log("▸ Resumed status: COMPLETED");

  const cancelResult = await finetune({ operation: "cancel", modelId });
  console.log("▸ Cancelled status:", cancelResult.status);
}

main().catch(console.error);
