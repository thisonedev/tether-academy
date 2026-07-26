import { loadModel, completion, QWEN3_600M_INST_Q4 } from "@qvac/sdk";

async function main() {
  const modelId = await loadModel({ modelSrc: QWEN3_600M_INST_Q4 });

  const PERSON_SCHEMA = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
      occupation: { type: "string" },
    },
    required: ["name", "age", "occupation"],
    additionalProperties: false,
  } as const;

  const result = completion({
    modelId,
    history: [
      { role: "system", content: "Extract structured info about people. /no_think" },
      { role: "user", content: "Hi, I'm Alice, 30, data engineer." },
    ],
    stream: true,
    responseFormat: {
      type: "json_schema",
      json_schema: { name: "person", schema: PERSON_SCHEMA },
    },
  });

  let raw = "";
  for await (const event of result.events) {
    if (event.type === "contentDelta") {
      raw += event.text;
      process.stdout.write(event.text);
    }
  }

  const parsed = JSON.parse(raw.trim()) as {
    name: string;
    age: number;
    occupation: string;
  };
  console.log("\n▸ Parsed:", parsed);
}

main().catch(console.error);