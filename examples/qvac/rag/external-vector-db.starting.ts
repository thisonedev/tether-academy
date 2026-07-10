import { embed, loadModel, unloadModel, GTE_LARGE_FP16 } from "@qvac/sdk";
import sqlite3InitModule from "@sqliteai/sqlite-wasm";

async function main() {
  const query = process.argv[2] || "machine learning algorithms";
  console.log(`▸ Query: "${query}"`);

  const samples = [
    { id: 1, text: "Machine learning is a subset of artificial intelligence that focuses on algorithms that can learn from data." },
    { id: 2, text: "Deep learning uses neural networks with multiple layers to process complex data patterns." },
    { id: 3, text: "Natural language processing combines computational linguistics with machine learning." },
  ];

  // 1: init SQLite, loadModel, and CREATE TABLE documents

  // 2: embed each sample and INSERT

  // 3: call vector_init and vector_quantize

  // 4: embed the query, run vector_quantize_scan, and log each result

  await unloadModel({ modelId: "" }).catch(() => {});
}

main().catch(console.error);