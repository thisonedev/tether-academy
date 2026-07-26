import { loadModel, completion, QWEN3_600M_INST_Q4 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({
    modelSrc: QWEN3_600M_INST_Q4,
    modelConfig: { ctx_size: 4096 },
  });

  const result = completion({
    modelId,
    history: [
      { role: "user", content: "Why is the sky blue?" },
    ],
    stream: true,
    captureThinking: true,
  });

  let thinking = "";
  for await (const event of result.events) {
    if (event.type === "thinkingDelta") {
      thinking += event.text;
    } else if (event.type === "contentDelta") {
      process.stdout.write(event.text);
    }
  }
  if (thinking) process.stdout.write(thinking);

  const final = await result.final;
  if (final.thinkingText) {
    console.log("Final thinking text:", final.thinkingText.length, "chars");
  }
}

main().catch(console.error);
