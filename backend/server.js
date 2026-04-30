require("dotenv").config();

const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const { chatWithOllama, listOllamaModels } = require("./ollama.js");
const {
  runOllamaAgent,
  initMcpPool,
  shutdownMcpPool,
  getMcpClient,
} = require("./ollama-agent.js");

const { chatConfig, mcpRegistry } = require("./claude.config");

const app = express();
const port = process.env.PORT || 3000;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

const lastNewsResultsByChat = new Map();

function getHistoryKey(history = []) {
  if (!Array.isArray(history) || history.length === 0) return "default";
  const tail = history
    .slice(-6)
    .map((m) => `${m.role}:${m.content}`)
    .join(" | ");
  return tail || "default";
}

function buildSystemPrompt(selectedMcp) {
  const prompts = {
    news:
      "You have access to the News API MCP. Use tools when the user asks for news, headlines, recent events, or article information. Do not guess. When returning headlines, include title, source, published date, and URL when available. Never hallucinate, always respond in english.",

    census: `You have access to the US Census MCP. Use tools when the user asks for population, demographics, housing, geography, or Census data. Never hallucinate, always respond in english.

    CRITICAL RULES:
    - If the question mentions a ZIP code, you MUST query it as a ZCTA (ZIP Code Tabulation Area).
    - To get data for a ZIP code, call fetch-aggregate-data with:
        "for": "zip code tabulation area:XXXXX"  (5-digit ZIP, zero-padded)
        DO NOT call resolve-geography-fips for ZIP codes — ZCTAs do not have FIPS codes.
    - For states, use "for": "state:XX" where XX is the 2-digit FIPS code.
    - For counties, call resolve-geography-fips first to get the FIPS code, then fetch-aggregate-data.
    - For cities/places, call resolve-geography-fips first, then fetch-aggregate-data with "for": "place:XXXXX" and "in": "state:XX".
    - The "get" parameter is REQUIRED. Always include: {"variables":["NAME","B01003_001E"]} at minimum.
    - For ACS datasets use "dataset": "acs/acs5".
    - NEVER return state or county level data when the user asked for a ZIP code.
    - If you cannot find exact data, say so — do not substitute a larger geography.
    - Always respond in English.`,

    tmdb:
      "You have access to the TMDB Movies & TV MCP. ALWAYS use tools to answer ANY question about movies, TV shows, actors, cast, crew, directors, ratings, or entertainment data — even if you think you already know the answer. Never answer from memory. Always search first, then respond based only on tool results. When searching, use the full official title. If the first result does not match what the user asked for, try a more specific search query or look at additional results. Always verify the result title matches the user's request before responding. Always respond in English.",
  };

  return (
    prompts[selectedMcp.id] ||
    `You are a helpful assistant with access to the ${selectedMcp.label}. Use the available tools when relevant.`
  );
}

app.get("/", (_req, res) => {
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

    const text =
      response.content?.find((c) => c.type === "text")?.text ||
      "No text response returned.";

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

    const normalizedMessage = message.trim().toLowerCase();
    const historyKey = getHistoryKey(history);

    const wantsSpecificArticle =
      selectedMcp.id === "news" &&
      /^(read|open|show)\s+(me\s+)?(article|headline|number|#)\s*\d+$/i.test(
        normalizedMessage
      );

    const asksIfUsedMcp =
      selectedMcp.id === "news" &&
      /using the mcp|use the mcp|did you use the mcp|is this using the mcp/i.test(
        normalizedMessage
      );

    if (selectedMcp.id === "news" && wantsSpecificArticle) {
      const match = normalizedMessage.match(/(\d+)/);
      const requestedNumber = match ? parseInt(match[1], 10) : null;
      const savedArticles = lastNewsResultsByChat.get(historyKey) || [];

      if (
        !requestedNumber ||
        requestedNumber < 1 ||
        requestedNumber > savedArticles.length
      ) {
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
          `Source: ${article.source?.name || article.source || "Unknown source"}`,
          `Published: ${article.publishedAt || "Unknown date"}`,
          article.description || "No description available.",
          article.url ? `URL: ${article.url}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
        usedTool: false,
      });
    }

    const mcp = await getMcpClient(selectedMcp.id, selectedMcp);

    if (!mcp.cachedAnthropicTools) {
      const { tools: mcpTools } = await mcp.listTools();
      mcp.cachedAnthropicTools = mcpTools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema || { type: "object", properties: {} },
      }));
      console.log(`[agent] Cached ${mcp.cachedAnthropicTools.length} tools for ${selectedMcp.id}`);
    }

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
        system: buildSystemPrompt(selectedMcp),
        tools: mcp.cachedAnthropicTools,
        messages,
      });

      const textBlocks = response.content.filter((b) => b.type === "text");
      if (textBlocks.length > 0) {
        finalText = textBlocks.map((b) => b.text).join("\n");
      }

      if (response.stop_reason === "end_turn") break;

      const toolUseBlocks = response.content.filter((b) => b.type === "tool_use");
      if (toolUseBlocks.length === 0) break;

      sawTool = true;
      messages.push({ role: "assistant", content: response.content });

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (toolUse) => {
          console.log(
            `[agent] Calling: ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 120)})`
          );

          try {
            const mcpResult = await mcp.callTool(toolUse.name, toolUse.input);
            const resultText =
              mcpResult.content?.map((c) => c.text).join("\n") ||
              JSON.stringify(mcpResult);

            if (selectedMcp.id === "news") {
              try {
                const parsed = JSON.parse(resultText);
                if (parsed?.articles) newsToolPayload = parsed;
              } catch (_) {}
            }

            console.log(`[agent] Result: ${resultText.slice(0, 300)}`);

            return {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: resultText,
            };
          } catch (err) {
            console.error(`[agent] Tool error: ${err.message}`);
            return {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: `Tool error: ${err.message}`,
              is_error: true,
            };
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
      if (!selectedMcp) {
        return res.status(400).json({ error: `Unknown MCP: ${mcpId}` });
      }

      if (/what tools did you use|which tools did you use|what mcp|can you give me the tools|give me the tools/i.test(message)) {
        const lastAgentMsg = [...(history || [])]
          .reverse()
          .find((m) => m.role === "assistant" && Array.isArray(m._toolsUsed));

        if (lastAgentMsg) {
          const toolList = lastAgentMsg._toolsUsed.map((t) => `• ${t}`).join("\n");
          return res.json({
            reply: `For the previous response I used the **${selectedMcp.label}** with these tools:\n${toolList}`,
            model: process.env.OLLAMA_TOOL_MODEL || process.env.OLLAMA_MODEL,
            usedTool: false,
            selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
          });
        }

        return res.json({
          reply: `I used the **${selectedMcp.label}**, but I do not have a detailed tool breakdown stored for the previous response.`,
          model: process.env.OLLAMA_TOOL_MODEL || process.env.OLLAMA_MODEL,
          usedTool: false,
          selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
        });
      }

      // Only keep the last N conversational turns, not tool results
      const trimmedHistory = history.slice(-4);

      const result = await runOllamaAgent({
        message,
        history: trimmedHistory,
        model: process.env.OLLAMA_TOOL_MODEL || model,
        mcpId,
        mcpConfig: selectedMcp,
        systemPrompt:
          system || buildSystemPrompt(selectedMcp) + " Always respond in English. Never call list-datasets unless the user explicitly asks what datasets exist.",
      });

      return res.json({
        reply: result.content,
        model: result.model,
        usedTool: result.usedTool,
        toolsUsed: result.toolsUsed,
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

// ── Start once ────────────────────────────────────────────────────────────────

let serverStarted = false;

async function startServer() {
  if (serverStarted) return;
  serverStarted = true;

  try {
    await initMcpPool(mcpRegistry);
  } catch (err) {
    console.error("MCP pool init error:", err.message);
  }

  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

process.on("SIGINT", () => {
  shutdownMcpPool();
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdownMcpPool();
  process.exit(0);
});

module.exports = { app, startServer };