import { loadModel, completion, QWEN3_600M_INST_Q4 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  const history: Array<{ role: string; content: string }> = [
    { role: "user", content: "What is the capital of France?" },
  ];

  const r1 = completion({ modelId, history, stream: true });
  for await (const event of r1.events) {
    if (event.type === "contentDelta") process.stdout.write(event.text);
  }
  const text1 = await r1.text;

  history.push({ role: "assistant", content: text1 });
  history.push({ role: "user", content: "And which river runs through it?" });

  const r2 = completion({ modelId, history, stream: true });
  process.stdout.write("\n");
  for await (const event of r2.events) {
    if (event.type === "contentDelta") process.stdout.write(event.text);
  }
}

main().catch(console.error);