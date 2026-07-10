import { loadModel, QWEN3_600M_INST_Q4, finetune, unloadModel } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  const baseOptions = {
    trainDatasetDir: "./examples/finetune/input/small_train_HF.jsonl",
    validation: { type: "dataset", path: "./examples/finetune/input/small_eval_HF.jsonl" },
    numberOfEpochs: 4,
    learningRate: 1e-4,
    loraModules: "attn_q,attn_k,attn_v,attn_o,ffn_gate,ffn_up,ffn_down",
    assistantLossOnly: true,
    outputParametersDir: "./examples/finetune/results",
  };

  const handle = finetune({ modelId, options: baseOptions });

  for await (const step of handle.progressStream) {
    console.log("step:", step);

    // 1: pause when the loss explodes

    // 2: resume once it's settled

    // 3: cancel before the loop ends
  }

  await unloadModel({ modelId });
}

main().catch(console.error);