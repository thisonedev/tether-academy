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
  const sfModelId = await loadModel({
    modelSrc: PARAKEET_SORTFORMER_4SPK_V2_1_Q8_0,
    modelType: "parakeet-transcription",
  });

  const diarization = await transcribe({
    modelId: sfModelId,
    audioChunk: audioFilePath,
  });
  await unloadModel({ modelId: sfModelId });

  const segments = diarization
    .split("\n")
    .map((line) => line.match(/Speaker (\d+): ([\d.]+)s - ([\d.]+)s/))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ speaker: +m[1]!, start: +m[2]!, end: +m[3]! }))
    .sort((a, b) => a.start - b.start);

  const tdtModelId = await loadModel({
    modelSrc: PARAKEET_TDT_0_6B_V3_Q8_0,
    modelType: "parakeet-transcription",
  });

  const pcm = readPcm(audioFilePath);
  const sliceDir = join(tmpdir(), `qvac-diarize-${Date.now()}`);
  mkdirSync(sliceDir, { recursive: true });

  const results: { speaker: number; start: number; end: number; text: string }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const slicePath = join(sliceDir, `seg-${i}.wav`);

    if (!writeWavSlice(pcm, seg.start, seg.end, slicePath)) {
      results.push({ ...seg, text: "[No speech detected]" });
      continue;
    }

    const text = await transcribe({
      modelId: tdtModelId,
      audioChunk: slicePath,
    });
    results.push({ ...seg, text: text.trim() || "[No speech detected]" });
  }
  await unloadModel({ modelId: tdtModelId });

  for (const r of results) {
    console.log(
      `Speaker ${r.speaker} (${r.start.toFixed(2)}s - ${r.end.toFixed(2)}s): ${r.text}`,
    );
  }
}

main().catch(console.error);
