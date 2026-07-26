import { completion, loadModel, QWEN3_600M_INST_Q4 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelConfig: { ctx_size: 4096 },
  });

  const result = completion({
    modelId,
    history: [{ role: "user", content: "Say hi in one word." }],
    stream: true,
    generationParams: { predict: 10 },
  });
  for await (const _ of result.tokenStream) {
    // drain
  }

  const final = await result.final;
  if (final.stopReason === "length") {
    console.log("▸ truncated: model hit the token budget");
  } else {
    console.log("▸ natural end of sequence");
  }
}

main().catch(console.error);