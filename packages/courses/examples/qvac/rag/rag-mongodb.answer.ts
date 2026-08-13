import { embed, loadModel, unloadModel, GTE_LARGE_FP16 } from "@qvac/sdk";
import { MongoClient } from "mongodb";

const INDEX_NAME = "documents_vector_index";

async function initializeMongoClient() {
  const client = new MongoClient(
    "mongodb://localhost:27017/?directConnection=true",
  );
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("▸ Connected to MongoDB server");
    return client;
  } catch {
    console.error("✖ Failed to connect to MongoDB server");
    console.error("▸ Please ensure the server is running on localhost:27017");
    console.error(
      "▸ One way to get a MongoDB with Atlas Vector Search: docker run -p 27017:27017 --name atlas-local mongodb/mongodb-atlas-local",
    );
    process.exit(1);
  }
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const query = process.argv[2] ?? "machine learning algorithms";
const category = process.argv[3] ?? "ai";
console.log(`▸ Query: "${query}" (category: "${category}")`);

const client = await initializeMongoClient();
const collection = client.db("qvac").collection("documents");

const modelId = await loadModel({
  modelSrc: GTE_LARGE_FP16,
  onProgress: (p) => {
    const mb = (n: number) => (n / 1e6).toFixed(1);
    console.log(`▸ Downloading ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`);
  },
});

const samples = [
  { id: 1, category: "ai", text: "Machine learning is a subset of artificial intelligence that focuses on algorithms that can learn and make predictions from data without being explicitly programmed for every task." },
  { id: 2, category: "ai", text: "Deep learning uses neural networks with multiple layers to process and learn from complex data patterns, enabling breakthroughs in image recognition and natural language processing." },
  { id: 3, category: "ai", text: "Natural language processing combines computational linguistics with machine learning to help computers understand, interpret, and generate human language in a meaningful way." },
  { id: 4, category: "ai", text: "Computer vision enables machines to interpret and understand visual information from the world, using techniques like image classification, object detection, and facial recognition." },
  { id: 5, category: "computing", text: "Quantum computing leverages quantum mechanical phenomena to process information in fundamentally different ways than classical computers, potentially solving certain problems exponentially faster." },
  { id: 6, category: "security", text: "Blockchain technology creates decentralized, immutable ledgers that enable secure peer-to-peer transactions without requiring a central authority or intermediary." },
  { id: 7, category: "computing", text: "Cloud computing delivers computing services over the internet, allowing users to access resources like storage, processing power, and applications on-demand from anywhere." },
  { id: 8, category: "security", text: "Cybersecurity protects digital systems, networks, and data from malicious attacks, unauthorized access, and various forms of cyber threats through multiple layers of defense." },
];

try {
  await collection.drop();
} catch {
  // collection didn't exist
}

console.log("▸ Embedding documents...");
const documents = [];
for (const sample of samples) {
  const { embedding } = await embed({ modelId, text: sample.text });
  documents.push({ id: sample.id, category: sample.category, text: sample.text, embedding });
}
await collection.insertMany(documents);

console.log("▸ Creating vector search index...");
await collection.createSearchIndex({
  name: INDEX_NAME,
  type: "vectorSearch",
  definition: {
    fields: [
      { type: "vector", path: "embedding", numDimensions: 1024, similarity: "cosine" },
      { type: "filter", path: "category" },
    ],
  },
});

for (let attempt = 0; attempt < 60; attempt++) {
  const [index] = (await collection.listSearchIndexes(INDEX_NAME).toArray()) as {
    queryable?: boolean;
  }[];
  if (index?.queryable) break;
  if (attempt === 59) throw new Error(`Index ${INDEX_NAME} did not become queryable`);
  await wait(1000);
}

console.log("▸ Searching for similar documents...");
const { embedding: queryEmbedding } = await embed({ modelId, text: query });

const results = await collection
  .aggregate<{ id: number; category: string; text: string; score: number }>([
    {
      $vectorSearch: {
        index: INDEX_NAME,
        path: "embedding",
        queryVector: queryEmbedding,
        filter: { category: { $eq: category } },
        numCandidates: 100,
        limit: 3,
      },
    },
    {
      $project: {
        _id: 0,
        id: 1,
        category: 1,
        text: 1,
        score: { $meta: "vectorSearchScore" },
      },
    },
  ])
  .toArray();

console.log("▸ Top 3 most similar documents:");
results.forEach((result, index) => {
  console.log();
  console.log(`${index + 1}. (Score: ${result.score.toFixed(4)}, Category: ${result.category})`);
  console.log(`   ${result.text}`);
});

await unloadModel({ modelId });
await client.close();