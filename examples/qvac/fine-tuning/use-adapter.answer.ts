import { completion, loadModel, QWEN3_600M_INST_Q4, unloadModel } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelConfig: {
      lora: "./examples/finetune/results/adapter.gguf",
    },
  });
  console.log("Loaded with adapter");

  const history = [{ role: "user", content: "What's a peanut butter sandwich in one sentence?" }];
  const result = completion({ modelId, history, stream: true });
  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }
  process.stdout.write("\n");

  await unloadModel({ modelId });
}

main().catch(console.error);
