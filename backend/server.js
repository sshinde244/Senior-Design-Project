require("dotenv").config();
const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const { chatConfig, agentConfig } = require("./claude.config");

const app = express();
const port = process.env.PORT || 3000;

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required." });
    }

    const messages = [
      ...history,
      { role: "user", content: message }
    ];

    const response = await client.messages.create({
      model: chatConfig.model,
      max_tokens: chatConfig.maxTokens,
      system: chatConfig.systemPrompt,
      messages,
    });

    const text =
      response.content?.find((c) => c.type === "text")?.text ||
      "No text response returned.";

    res.json({ reply: text });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.status(500).json({
      error: "Claude request failed.",
      details: err.message || "Unknown error"
    });
  }
});

app.post("/api/agent", async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required." });
    }

    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    console.log("ANTHROPIC KEY PRESENT:", !!process.env.ANTHROPIC_API_KEY);
    console.log("CENSUS KEY PRESENT:", !!process.env.CENSUS_API_KEY);

    // Inject conversation history into the prompt as context
    const historyContext = history
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");

    const fullPrompt = historyContext
      ? `${agentConfig.promptPrefix}Previous conversation:\n${historyContext}\n\nUser: ${message}`
      : `${agentConfig.promptPrefix}${message}`;

    let finalText = "";
    const events = [];

    for await (const msg of query({
      prompt: fullPrompt,
      options: {
        permissionMode: agentConfig.permissionMode,
        allowDangerouslySkipPermissions: agentConfig.allowDangerouslySkipPermissions,
        maxTurns: agentConfig.maxTurns,
        mcpServers: agentConfig.mcpServers,
        allowedTools: agentConfig.allowedTools,
      },
    })) {
      events.push(msg);
      console.dir(msg, { depth: null });

      if (msg.type === "result" && msg.subtype === "success") {
        finalText = msg.result;
      }
    }

    res.json({
      reply: finalText || "No response returned.",
      debugCount: events.length
    });
  } catch (err) {
    console.error("AGENT ERROR:", err);
    res.status(500).json({
      error: "Agent request failed.",
      details: err.message || "Unknown error",
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});