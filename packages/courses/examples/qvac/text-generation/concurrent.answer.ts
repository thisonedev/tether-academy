import { loadModel, completion, QWEN3_600M_INST_Q4 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  const history = [
    { role: "user", content: "What is Bitcoin? One sentence." },
  ];

  const r1 = completion({ modelId, history, stream: false });
  const r2 = completion({ modelId, history, stream: false });

  const [text1, text2] = await Promise.all([r1.text, r2.text]);

  console.log(`▸ req-A: ${text1}`);
  console.log(`▸ req-B: ${text2}`);
  console.log(`▸ Both completed.`);
}

main().catch(console.error);