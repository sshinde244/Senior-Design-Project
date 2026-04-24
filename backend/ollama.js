require("dotenv").config();

const { Ollama } = require("ollama");

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
});

async function chatWithOllama(messages, model) {
  const selectedModel = model || process.env.OLLAMA_MODEL || "qwen2.5:latest";

  const response = await ollama.chat({
    model: selectedModel,
    messages,
    stream: false,
  });

  return {
    content: response.message?.content || "No response returned.",
    model: selectedModel,
  };
}

async function listOllamaModels() {
  const response = await ollama.list();

  return (response.models || []).map((m) => ({
    name: m.name,
    model: m.model,
    size: m.size,
    modified_at: m.modified_at,
  }));
}

module.exports = {
  chatWithOllama,
  listOllamaModels,
};
