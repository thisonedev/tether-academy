import { loadModel, QWEN3_600M_INST_Q4, finetune, unloadModel } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  const baseOptions = {
    trainDatasetDir: "./examples/qvac/fine-tuning/input/small_train_HF.jsonl",
    validation: { type: "dataset", path: "./examples/qvac/fine-tuning/input/small_eval_HF.jsonl" },
    numberOfEpochs: 4,
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
      // 1: pause from a callback after a few training steps
    }
  })();

  const initialResult = await handle.result;
  await progressTask;
  if (pauseResultPromise) {
    const pauseResult = await pauseResultPromise;
    console.log("▸ Pausing... status:", pauseResult.status);
  }

  if (initialResult.status === "PAUSED") {
    // 2: resume with the same params + operation: "resume"
  }

  // 3: cancel the run before unloading

  await unloadModel({ modelId });
}

main().catch(console.error);
