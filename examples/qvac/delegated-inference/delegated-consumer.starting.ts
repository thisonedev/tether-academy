import { completion, LLAMA_3_2_1B_INST_Q4_0, loadModel, close } from "@qvac/sdk";

const providerPublicKey = process.argv[2];

async function main() {
  // 1: load the model with a delegate block

  // 2: call completion() against the delegated modelId

  // 3: stream the response tokens to stdout and log stats

  void close();
}

main().catch(console.error);