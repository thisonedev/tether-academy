import {
  loadModel,
  unloadModel,
  bciTranscribeStream,
  BCI_WINDOWED,
} from "@qvac/sdk";
import { readFileSync } from "node:fs";

const neuralFilePath = process.argv[2] ?? "./examples/bci/input/sample.bin";
const CHUNK_SIZE = 64 * 1024;

async function main() {
  // 1: load the BCI model

  // 2: open a streaming session

  // 3: drain the session, write chunks, end, await, unload
}

main().catch(console.error);