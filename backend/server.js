require("dotenv").config();
const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const { chatConfig, agentConfig, mcpRegistry } = require("./claude.config");

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

app.get("/api/mcps", (_req, res) => {
  res.json({
    mcps: Object.values(mcpRegistry).map((mcp) => ({
      id: mcp.id,
      label: mcp.label,
    })),
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required." });
    }

    const response = await client.messages.create({
      model: chatConfig.model,
      max_tokens: chatConfig.maxTokens,
      system: chatConfig.systemPrompt,
      messages: [...history, { role: "user", content: message }],
    });

    const text =
      response.content?.find((c) => c.type === "text")?.text ||
      "No text response returned.";

    res.json({ reply: text });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.status(500).json({ error: "Claude request failed.", details: err.message });
  }
});

app.post("/api/agent", async (req, res) => {
  try {
    const { message, history = [], mcpId = "census" } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required." });
    }

    const selectedMcp = mcpRegistry[mcpId];
    if (!selectedMcp) {
      return res.status(400).json({ error: `Unknown MCP: ${mcpId}` });
    }

    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const historyContext = history
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");

    const fullPrompt = historyContext
      ? `Previous conversation:\n${historyContext}\n\nUser: ${message}`
      : message;

    const mcpServers = {
      [selectedMcp.id]: {
        command: selectedMcp.command,
        args: selectedMcp.args,
        env: selectedMcp.env,
      },
    };

    let finalText = "";
    let lastText = "";

    for await (const msg of query({
      prompt: fullPrompt,
      options: {
        permissionMode: agentConfig.permissionMode,
        allowDangerouslySkipPermissions: agentConfig.allowDangerouslySkipPermissions,
        maxTurns: agentConfig.maxTurns,
        mcpServers,
        allowedTools: [`mcp__${selectedMcp.id}__*`],
      },
    })) {
      if (msg.type === "assistant") {
        if (typeof msg.message?.content === "string") {
          lastText = msg.message.content;
        } else if (Array.isArray(msg.message?.content)) {
          const text = msg.message.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          if (text) lastText = text;
        }
      }

      if (msg.type === "result" && msg.subtype === "success") {
        finalText =
          typeof msg.result === "string"
            ? msg.result
            : JSON.stringify(msg.result, null, 2);
      }
    }

    res.json({
      reply: finalText || lastText || "No response returned.",
      selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
    });
  } catch (err) {
    console.error("AGENT ERROR:", err.message);
    res.status(500).json({ error: "Agent request failed.", details: err.message });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});