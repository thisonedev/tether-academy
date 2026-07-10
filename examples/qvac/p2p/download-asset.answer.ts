import {
  completion,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  downloadAsset,
  unloadModel,
} from "@qvac/sdk";

async function main() {
  await downloadAsset({
    assetSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (p) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
    },
  });

  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelConfig: { device: "gpu", ctx_size: 2048 },
  });

  const history = [
    { role: "user", content: "Explain quantum computing in one sentence." },
  ];

  const result = completion({ modelId, history, stream: true });
  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }

  console.log("\n▸ Done.");
  await unloadModel({ modelId, clearStorage: false });
}

main().catch(console.error);