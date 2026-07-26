// QVAC_CONFIG_PATH must be set BEFORE the SDK import: config is read at module-evaluation time.
// The config file is a regular JS module that exports the swarmRelays list.
process.env.QVAC_CONFIG_PATH = "./qvac.config.js";

import {
  downloadAsset,
  close,
  loadModel,
  unloadModel,
  LLAMA_3_2_1B_INST_Q4_0,
  type ModelProgressUpdate,
} from "@qvac/sdk";

// qvac.config.js
// export default {
//   swarmRelays: [
//     "rs1.relay.example.com:1234:abcdef...",
//     "rs2.relay.example.com:1234:fedcba...",
//   ],
// };

async function main() {
  console.log("▸ Starting model download from Hyperdrive...\n");

  const modelId = await loadModel({ modelSrc: LLAMA_3_2_1B_INST_Q4_0 });
  console.log(`▸ Model loaded with ID: ${modelId}`);

  await unloadModel({ modelId });

  await downloadAsset({
    assetSrc: LLAMA_3_2_1B_INST_Q4_0,
    onProgress: (p: ModelProgressUpdate) => {
      const mb = (n: number) => (n / 1e6).toFixed(1);
      const line = `▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
      process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
    },
  });

  console.log(`\n▸ Model downloaded successfully using blind relays!`);

  await close();
}

main().catch((err) => {
  console.error("✖", err);
  process.exit(1);
});