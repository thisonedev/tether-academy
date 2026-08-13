import { embed, loadModel, unloadModel, GTE_LARGE_FP16 } from "@qvac/sdk";
import { MongoClient } from "mongodb";

const INDEX_NAME = "documents_vector_index";

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const query = process.argv[2] ?? "machine learning algorithms";
  const category = process.argv[3] ?? "ai";
  console.log(`▸ Query: "${query}" (category: "${category}")`);

  // 1: connect to MongoDB at mongodb://localhost:27017, ping admin, then load GTE_LARGE_FP16

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

  // 2: target the qvac.documents collection, drop it if it exists, then embed each sample and insertMany

  // 3: createSearchIndex with type vectorSearch, numDimensions: 1024, and a category filter field

  // 4: poll listSearchIndexes until queryable === true

  // 5: embed the query, run the $vectorSearch aggregation, and log each result with score, category, and text

  await unloadModel({ modelId: "" }).catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
