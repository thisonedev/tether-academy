import {
  downloadAsset,
  close,
  LLAMA_3_2_1B_INST_Q4_0,
  loadModel,
  unloadModel,
} from "@qvac/sdk";

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
});

await unloadModel({ modelId, clearStorage: false });

console.log("▸ Done.");
await close();
