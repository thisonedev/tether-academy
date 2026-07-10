import { loadModel, QWEN3_600M_INST_Q4, finetune, unloadModel } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  const handle = finetune({
    modelId,
    options: {
      trainDatasetDir: "./examples/finetune/input/small_train_HF.jsonl",
      validation: {
        type: "dataset",
        path: "./examples/finetune/input/small_eval_HF.jsonl",
      },
      numberOfEpochs: 2,
      learningRate: 1e-4,
      lrMin: 1e-8,
      loraModules: "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
      assistantLossOnly: true,
      checkpointSaveSteps: 2,
      checkpointSaveDir: "./examples/finetune/results/checkpoints",
      outputParametersDir: "./examples/finetune/results",
    },
  });

  for await (const step of handle.progressStream) {
    console.log(
      `Train [${step.current_epoch}/${step.total_epochs ?? "?"}] ` +
        `loss=${step.loss?.toFixed(3) ?? "?"} step=${step.global_steps}/${step.total_batches ?? "?"}`,
    );
  }

  await handle.result;
  console.log("Done. Adapter saved.");

  await unloadModel({ modelId });
}

main().catch(console.error);
