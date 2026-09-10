import { downloadAsset, LLAMA_3_2_1B_INST_Q4_0, WHISPER_TINY } from "@qvac/sdk";

async function main() {
  const assets = [
    { name: "Llama 3.2 1B", src: LLAMA_3_2_1B_INST_Q4_0 },
    { name: "Whisper Tiny", src: WHISPER_TINY },
  ];

  const downloads = assets.map((asset) =>
    downloadAsset({
      assetSrc: asset.src,
      onProgress: (p) => {
        process.stderr.write(`▸ [${asset.name}] ${p.percentage.toFixed(0)}%\n`);
      },
    })
  );

  const results = await Promise.allSettled(downloads);

  for (let i = 0; i < assets.length; i++) {
    const status = results[i].status === "fulfilled" ? "OK" : "FAILED";
    console.log(`▸ ${status} ${assets[i].name}`);
  }
}

main().catch(console.error);
