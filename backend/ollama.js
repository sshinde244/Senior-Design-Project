const { Ollama } = require("ollama");

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST ?? "http://localhost:11434",
});

/**
 * Send a chat request to a local Ollama model.
 */
async function chatWithOllama(messages, model) {
  model = model ?? process.env.OLLAMA_MODEL ?? "llama3.2";

  const response = await ollama.chat({
    model,
    messages,
    stream: false,
  });

  return {
    content: response.message.content,
    model: response.model,
    done: response.done,
  };
}

/**
 * Stream a chat response from Ollama.
 */
async function streamChatWithOllama(messages, model, onChunk) {
  model = model ?? process.env.OLLAMA_MODEL ?? "llama3.2";

  const stream = await ollama.chat({
    model,
    messages,
    stream: true,
  });

  let fullContent = "";
  for await (const chunk of stream) {
    const text = chunk.message.content;
    fullContent += text;
    onChunk(text);
  }

  return fullContent;
}

/**
 * List available models on this Ollama instance.
 */
async function listOllamaModels() {
  const { models } = await ollama.list();
  return models.map((m) => m.name);
}

module.exports = { chatWithOllama, streamChatWithOllama, listOllamaModels };