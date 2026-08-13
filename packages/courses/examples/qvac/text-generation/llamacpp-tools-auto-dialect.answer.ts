import { QWEN3_600M_INST_Q4, completion, loadModel, unloadModel } from "@qvac/sdk";

const modelSrc = process.argv[2] ?? QWEN3_600M_INST_Q4;

const modelId = await loadModel({
  modelSrc,
  modelType: "llamacpp-completion",
  modelConfig: { ctx_size: 4096, tools: true },
});
console.log(`▸ Model loaded: ${modelId}`);

const history = [
  {
    role: "system",
    content: "You are a helpful assistant that can call tools to look up weather and horoscopes.",
  },
  {
    role: "user",
    content: "What's the weather in Tokyo and my horoscope for Aquarius?",
  },
];

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
  {
    name: "get_horoscope",
    description: "Get today's horoscope for a zodiac sign",
    parameters: {
      type: "object",
      properties: { sign: { type: "string" } },
      required: ["sign"],
    },
  },
];

const result = completion({ modelId, history, stream: true, tools });

const tokensTask = (async () => {
  for await (const token of result.tokenStream) {
    process.stdout.write(token);
  }
})();

const toolsTask = (async () => {
  for await (const evt of result.toolCallStream) {
    if (evt.type === "toolCall") {
      console.log(`\n▸ ${evt.call.name}(${JSON.stringify(evt.call.arguments)})`);
    }
  }
})();

await Promise.all([tokensTask, toolsTask]);

await unloadModel({ modelId, clearStorage: false });