import { loadModel, QWEN3_600M_INST_Q4, finetune } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  const baseOptions = {
    trainDatasetDir: "./examples/qvac/fine-tuning/input/small_train_HF.jsonl",
    validation: { type: "dataset", path: "./examples/qvac/fine-tuning/input/small_eval_HF.jsonl" },
    numberOfEpochs: 1,
    learningRate: 1e-4,
    lrMin: 1e-8,
    loraModules: "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
    assistantLossOnly: true,
    checkpointSaveSteps: 2,
    checkpointSaveDir: "output/finetune/checkpoints/",
    outputParametersDir: "output/finetune/",
  };

  const finetuneParams = { modelId, options: baseOptions };

  const handle = finetune(finetuneParams);

  let pauseRequested = false;
  let pauseResultPromise;
  const progressTask = (async () => {
    for await (const tick of handle.progressStream) {
      const phase = tick.is_train ? "train" : "val";
      console.log(
        `▸ epoch=${tick.current_epoch + 1} step=${tick.global_steps} ` +
          `batch=${tick.current_batch}/${tick.total_batches} ${phase} ` +
          `loss=${tick.loss?.toFixed(4)} acc=${tick.accuracy?.toFixed(4)} ` +
          `eta=${Math.round(tick.eta_ms / 1000)}s`,
      );

      if (!pauseRequested && tick.global_steps >= 4) {
        pauseRequested = true;
        pauseResultPromise = finetune({ operation: "pause", modelId });
      }
    }
  })();

  const initialResult = await handle.result;
  await progressTask;
  if (pauseResultPromise) {
    const pauseResult = await pauseResultPromise;
    console.log("▸ Pausing... status:", pauseResult.status);
  }

  if (initialResult.status === "PAUSED") {
    const resumed = finetune({ ...finetuneParams, operation: "resume" });
    await resumed.result;
    console.log("▸ Resumed status: COMPLETED");
  }

  const cancelResult = await finetune({ operation: "cancel", modelId });
  console.log("▸ Cancelled status:", cancelResult.status);
}

main().catch(console.error);
