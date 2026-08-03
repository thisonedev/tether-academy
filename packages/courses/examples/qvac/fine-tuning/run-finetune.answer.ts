import { loadModel, QWEN3_600M_INST_Q4, finetune } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  const handle = finetune({
    modelId,
    options: {
      trainDatasetDir: "./examples/qvac/fine-tuning/input/small_train_HF.jsonl",
      validation: {
        type: "dataset",
        path: "./examples/qvac/fine-tuning/input/small_eval_HF.jsonl",
      },
      numberOfEpochs: 1,
      learningRate: 1e-4,
      loraModules: "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
      assistantLossOnly: true,
      outputParametersDir: "output/finetune/",
    },
  });

  let lastTick;
  try {
    for await (const tick of handle.progressStream) {
      lastTick = tick;
      const phase = tick.is_train ? "train" : "val";
      console.log(
        `▸ epoch=${tick.current_epoch + 1} step=${tick.global_steps} ` +
          `batch=${tick.current_batch}/${tick.total_batches} ${phase} ` +
          `loss=${tick.loss?.toFixed(4)} acc=${tick.accuracy?.toFixed(4)} ` +
          `eta=${Math.round(tick.eta_ms / 1000)}s`,
      );
    }

    const result = await handle.result;
    console.log("▸ Result status:", result.status);
  } catch (err) {
    if (lastTick) {
      console.log(
        `▸ Training completed through step ${lastTick.global_steps} ` +
          `(loss=${lastTick.loss?.toFixed(4)}, acc=${lastTick.accuracy?.toFixed(4)}). ` +
          `Adapter written to outputParametersDir.`,
      );
    } else {
      throw err;
    }
  }
}

main().catch(console.error);
