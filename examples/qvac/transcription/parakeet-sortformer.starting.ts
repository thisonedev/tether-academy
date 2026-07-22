import {
  loadModel,
  unloadModel,
  transcribe,
  PARAKEET_TDT_0_6B_V3_Q8_0,
  PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
} from "@qvac/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const audioFilePath = "./examples/audio/diarization-sample-16k.wav";

function readPcm(wavPath: string): Buffer {
  const buf = readFileSync(wavPath);
  const dataOffset = buf.indexOf("data") + 4;
  return buf.subarray(dataOffset + 4, dataOffset + 4 + buf.readUInt32LE(dataOffset));
}

function writeWavSlice(
  pcm: Buffer,
  startSec: number,
  endSec: number,
  outPath: string,
): boolean {
  const SR = 16000;
  const BPS = 2;
  const startByte = Math.floor(startSec * SR) * BPS;
  const endByte = Math.min(Math.ceil(endSec * SR) * BPS, pcm.length);
  if (startByte >= endByte) return false;

  const slice = pcm.subarray(startByte, endByte);
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0);
  hdr.writeUInt32LE(36 + slice.length, 4);
  hdr.write("WAVEfmt ", 8);
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1, 20);
  hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(SR, 24);
  hdr.writeUInt32LE(SR * BPS, 28);
  hdr.writeUInt16LE(BPS, 32);
  hdr.writeUInt16LE(16, 34);
  hdr.write("data", 36);
  hdr.writeUInt32LE(slice.length, 40);

  writeFileSync(outPath, Buffer.concat([hdr, slice]));
  return true;
}

async function main() {
  // 1: load Sortformer, transcribe, parse into segments

  // 2: load TDT and transcribe each segment via writeWavSlice

  // 3: console.log one line per result

  await unloadModel({ modelId: "" }).catch(() => {});
}

main().catch(console.error);
