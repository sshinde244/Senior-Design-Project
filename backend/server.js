require("dotenv").config();
const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");
const { chatWithOllama, listOllamaModels } = require("./ollama.js");
const { runOllamaAgent, initMcpPool, shutdownMcpPool, getMcpClient } = require("./ollama-agent.js");
const { chatConfig, agentConfig, mcpRegistry } = require("./claude.config");

const app = express();
const port = process.env.PORT || 3000;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

const lastNewsResultsByChat = new Map();

function getHistoryKey(history = []) {
  if (!Array.isArray(history) || history.length === 0) return "default";
  const tail = history.slice(-6).map((m) => `${m.role}:${m.content}`).join(" | ");
  return tail || "default";
}

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "../frontend/index.html"));
});

app.get("/api/mcps", (_req, res) => {
  res.json({
    mcps: Object.values(mcpRegistry).map((mcp) => ({ id: mcp.id, label: mcp.label })),
  });
});

// ── Plain Claude chat ─────────────────────────────────────────────────────────

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
    const text = response.content?.find((c) => c.type === "text")?.text || "No text response returned.";
    res.json({ reply: text });
  } catch (err) {
    console.error("CHAT ERROR:", err);
    res.status(500).json({ error: "Claude request failed.", details: err.message });
  }
});

// ── Claude agent with MCP tools ───────────────────────────────────────────────

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

    console.log("Requested mcpId:", mcpId);
    console.log("Selected MCP:", selectedMcp.id);

    const normalizedMessage = message.trim().toLowerCase();
    const historyKey = getHistoryKey(history);

    const wantsLiteralHeadlineList =
      selectedMcp.id === "news" &&
      /^(show|list|display)\s+(me\s+)?(the\s+)?headlines$/i.test(normalizedMessage);

    const wantsSpecificArticle =
      selectedMcp.id === "news" &&
      /^(read|open|show)\s+(me\s+)?(article|headline|number|#)\s*\d+$/i.test(normalizedMessage);

    const asksIfUsedMcp =
      selectedMcp.id === "news" &&
      /using the mcp|use the mcp|did you use the mcp|is this using the mcp/i.test(normalizedMessage);

    if (selectedMcp.id === "news" && wantsSpecificArticle) {
      const match = normalizedMessage.match(/(\d+)/);
      const requestedNumber = match ? parseInt(match[1], 10) : null;
      const savedArticles = lastNewsResultsByChat.get(historyKey) || [];
      if (!requestedNumber || requestedNumber < 1 || requestedNumber > savedArticles.length) {
        return res.json({
          reply: "I couldn't find that article number in the last headline list.",
          selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
          usedTool: false,
        });
      }
      const article = savedArticles[requestedNumber - 1];
      return res.json({
        reply: [
          `${requestedNumber}. ${article.title || "Untitled"}`,
          `Source: ${article.source || "Unknown source"}`,
          `Published: ${article.publishedAt || "Unknown date"}`,
          article.description || "No description available.",
          article.url ? `URL: ${article.url}` : "",
        ].filter(Boolean).join("\n"),
        selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
        usedTool: false,
      });
    }

    const systemPrompts = {
      news: `You are a helpful assistant with access to the News API MCP.
For any question about current events, headlines, or recent news, always use the available tools.
Do not answer from memory. Do not guess.`,
      census: `You are a helpful assistant with access to the US Census MCP.
For any request involving U.S. demographics, population, housing, or geography, always use the available tools.
Do not answer from memory.`,
      tmdb: `You are a helpful assistant with access to the TMDB Movies & TV MCP.
For any request involving movies, actors, directors, or TV shows, always use the available tools.
Do not answer from memory.`,
    };
    const systemPrompt = systemPrompts[selectedMcp.id] ||
      `You are a helpful assistant with access to the ${selectedMcp.label}. Always use the available tools.`;

    const mcp = await getMcpClient(selectedMcp.id, {
      command: selectedMcp.command,
      args: selectedMcp.args,
      env: selectedMcp.env,
    });

    if (!mcp.cachedAnthropicTools) {
      const { tools: mcpTools } = await mcp.listTools();
      mcp.cachedAnthropicTools = mcpTools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema || { type: "object", properties: {} },
      }));
      console.log(`[agent] Cached ${mcp.cachedAnthropicTools.length} tools for ${selectedMcp.id}`);
    }
    const tools = mcp.cachedAnthropicTools;

    const messages = [...history, { role: "user", content: message }];
    let finalText = "";
    let sawTool = false;
    let newsToolPayload = null;
    const MAX_TURNS = 10;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      console.log(`[agent] Turn ${turn + 1} (${selectedMcp.id})`);
      const response = await client.messages.create({
        model: chatConfig.model,
        max_tokens: 4096,
        system: systemPrompt,
        tools,
        messages,
      });
      console.log(`[agent] stop_reason: ${response.stop_reason}`);

      const textBlocks = response.content.filter((b) => b.type === "text");
      if (textBlocks.length > 0) finalText = textBlocks.map((b) => b.text).join("\n");
      if (response.stop_reason === "end_turn") break;

      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      if (toolUseBlocks.length === 0) break;

      sawTool = true;
      messages.push({ role: "assistant", content: response.content });

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (toolUse) => {
          console.log(`[agent] Calling: ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 100)})`);
          try {
            const mcpResult = await mcp.callTool(toolUse.name, toolUse.input);
            const resultText = mcpResult.content?.map((c) => c.text).join("\n") || JSON.stringify(mcpResult);
            if (selectedMcp.id === "news") {
              try { const p = JSON.parse(resultText); if (p?.articles) newsToolPayload = p; } catch (_) {}
            }
            console.log(`[agent] Result: ${resultText.slice(0, 150)}`);
            return { type: "tool_result", tool_use_id: toolUse.id, content: resultText };
          } catch (err) {
            console.error(`[agent] Tool error: ${err.message}`);
            return { type: "tool_result", tool_use_id: toolUse.id, content: `Tool error: ${err.message}`, is_error: true };
          }
        })
      );
      messages.push({ role: "user", content: toolResults });
    }

    if (selectedMcp.id === "news" && asksIfUsedMcp) {
      return res.json({
        reply: sawTool ? "Yes — this answer used the News MCP." : "No — the News MCP was not used.",
        selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
        usedTool: sawTool,
      });
    }

    if (selectedMcp.id === "news" && wantsLiteralHeadlineList) {
      if (!sawTool) {
        return res.json({
          reply: "The News MCP could not be used, so I can't verify live headlines right now.",
          selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
          usedTool: false,
        });
      }
      if (!newsToolPayload || !Array.isArray(newsToolPayload.articles) || newsToolPayload.articles.length === 0) {
        return res.json({
          reply: "The News MCP ran, but it did not return any readable headlines.",
          selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
          usedTool: true,
        });
      }
      const articles = newsToolPayload.articles.slice(0, 8);
      lastNewsResultsByChat.set(historyKey, articles);
      const lines = articles.map((article, i) => {
        return `${i + 1}. ${article.title || "Untitled"}\n   Source: ${article.source || "Unknown source"}\n   Published: ${article.publishedAt || "Unknown date"}`;
      });
      return res.json({
        reply: `Top headlines from News MCP:\n\n${lines.join("\n\n")}`,
        selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
        usedTool: true,
      });
    }

    if (selectedMcp.id === "news" && newsToolPayload?.articles?.length) {
      lastNewsResultsByChat.set(historyKey, newsToolPayload.articles.slice(0, 8));
    }

    return res.json({
      reply: finalText || "No response returned.",
      selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
      usedTool: sawTool,
    });

  } catch (err) {
    console.error("AGENT ERROR:", err);
    res.status(500).json({ error: "Agent request failed.", details: err.message });
  }
});

// ── Ollama routes ─────────────────────────────────────────────────────────────

app.post("/api/ollama", async (req, res) => {
  try {
    const { message, system, model, history = [], mcpId } = req.body;
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required." });
    }

    if (mcpId) {
      const selectedMcp = mcpRegistry[mcpId];
      if (!selectedMcp) return res.status(400).json({ error: `Unknown MCP: ${mcpId}` });

      const systemPrompt = system || `You are a helpful assistant with access to the ${selectedMcp.label}. Use the available tools to answer accurately. Do not guess — use the tools.`;

      const result = await runOllamaAgent({
        message, history, model, mcpId,
        mcpConfig: { command: selectedMcp.command, args: selectedMcp.args, env: selectedMcp.env },
        systemPrompt,
      });

      return res.json({
        reply: result.content,
        model: result.model,
        usedTool: true,
        selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
      });
    }

    const messages = [];
    if (system) messages.push({ role: "system", content: system });
    for (const m of history) messages.push({ role: m.role, content: m.content });
    messages.push({ role: "user", content: message });

    const response = await chatWithOllama(messages, model);
    res.json({ reply: response.content, model: response.model, usedTool: false });
  } catch (err) {
    console.error("OLLAMA ERROR:", err);
    res.status(500).json({ error: "Ollama request failed.", details: err.message });
  }
});

app.get("/api/ollama/models", async (_req, res) => {
  try {
    const models = await listOllamaModels();
    res.json({ models });
  } catch (err) {
    res.status(500).json({ error: "Could not fetch Ollama models.", details: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  initMcpPool(mcpRegistry).catch((err) => console.error("MCP pool init error:", err.message));
});

process.on("SIGINT", () => { shutdownMcpPool(); process.exit(0); });
process.on("SIGTERM", () => { shutdownMcpPool(); process.exit(0); });