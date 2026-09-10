import { downloadAsset, LLAMA_3_2_1B_INST_Q4_0, WHISPER_TINY } from "@qvac/sdk";

async function main() {
  const assets = [
    { name: "Llama 3.2 1B", src: LLAMA_3_2_1B_INST_Q4_0 },
    { name: "Whisper Tiny", src: WHISPER_TINY },
  ];

  // 1: map each asset to its own downloadAsset() call, logging progress per name

  // 2: await the batch with Promise.allSettled, then log OK or FAILED per asset
}

main().catch(console.error);
