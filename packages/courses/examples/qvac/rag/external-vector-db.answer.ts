import { embed, loadModel, unloadModel, GTE_LARGE_FP16 } from "@qvac/sdk";
import sqlite3InitModule from "@sqliteai/sqlite-wasm";

async function main() {
  const query = process.argv[2] || "machine learning algorithms";
  console.log(`▸ Query: "${query}"`);

  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(":memory:", "c");

  const modelId = await loadModel({ modelSrc: GTE_LARGE_FP16 });

  const samples = [
    {
      id: 1,
      text: "Machine learning is a subset of artificial intelligence that focuses on algorithms.",
    },
    {
      id: 2,
      text: "Deep learning uses neural networks with multiple layers for complex data patterns.",
    },
    {
      id: 3,
      text: "Natural language processing combines computational linguistics with machine learning.",
    },
  ];

  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL
    )
  `);

  for (const sample of samples) {
    const { embedding } = await embed({ modelId, text: sample.text });
    db.exec({
      sql: "INSERT INTO documents VALUES (?, ?, vector_as_f32(?))",
      bind: [sample.id, sample.text, JSON.stringify(embedding)],
    });
  }

  db.exec(`SELECT vector_init('documents', 'embedding', 'type=FLOAT32,dimension=1024')`);
  db.exec(`SELECT vector_quantize('documents', 'embedding')`);

  const { embedding: queryEmbedding } = await embed({ modelId, text: query });

  const results: { id: number; text: string; distance: number }[] = [];
  db.exec({
    sql: `
      SELECT d.id, d.text, v.distance
      FROM documents d
      JOIN vector_quantize_scan('documents', 'embedding', vector_as_f32(?), 3) v
      ON d.id = v.rowid
    `,
    bind: [JSON.stringify(queryEmbedding)],
    rowMode: "object",
    callback: (row) => {
      results.push(row as { id: number; text: string; distance: number });
    },
  });

  for (const [i, r] of results.entries()) {
    console.log(`${i + 1}. [ID: ${r.id}] (distance: ${r.distance.toFixed(4)})`);
    console.log(`   ${r.text}`);
  }

  await unloadModel({ modelId });
  db.close();
}

main().catch(console.error);
