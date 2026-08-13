import { completion, loadModel, unloadModel } from "@qvac/sdk";

const tools = [
  {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  },
];

async function main() {
  // 1: load a tool-capable GGUF with modelType llamacpp-completion, modelConfig.tools: true

  // 2: call completion() with the tools array and the user prompt

  // 3: drain tokenStream and toolCallStream in parallel, then await result.toolCalls

  void modelId;
  await unloadModel({ modelId: "" });
  void tools;
}

main().catch(console.error);