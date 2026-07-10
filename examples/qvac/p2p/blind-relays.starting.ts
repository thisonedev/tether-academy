// Replace with a real qvac.config.js path that exports { swarmRelays: [...] }.
process.env.QVAC_CONFIG_PATH = "./qvac.config.js";

import {
  downloadAsset,
  close,
  loadModel,
  unloadModel,
  LLAMA_3_2_1B_INST_Q4_0,
} from "@qvac/sdk";

async function main() {
  // 1: call loadModel and downloadAsset with the configured relays
}

main().catch(console.error);