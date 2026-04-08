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
    res.status(500).json({
      error: "Claude request failed.",
      details: err.message,
    });
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
        reply:
          `${requestedNumber}. ${article.title || "Untitled"}\n` +
          `Source: ${article.source || "Unknown source"}\n` +
          `Published: ${article.publishedAt || "Unknown date"}\n` +
          `${article.description || "No description available."}\n` +
          `${article.url ? `URL: ${article.url}` : ""}`.trim(),
        selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
        usedTool: false,
      });
    }

    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    const historyContext = history
      .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
      .join("\n");

    let toolInstruction = `You have access to the ${selectedMcp.label}. Use it when relevant.`;

    if (selectedMcp.id === "news") {
      toolInstruction = `
You have access to the ${selectedMcp.label}.

For any question about current events, headlines, breaking news, or recent developments, use the News MCP.
Do not answer from memory.
Do not guess.

If the user explicitly asks to "show headlines" or "list headlines", call the News MCP and return headline data.
If the user asks a broader question like "what is in the news today", use the News MCP but answer normally.
`;
    } else if (selectedMcp.id === "census") {
      toolInstruction = `
You have access to the ${selectedMcp.label}.

For any request involving U.S. Census facts, demographics, population, housing, geography, or comparisons by place, use the Census MCP instead of answering from memory.
If the MCP fails, say so clearly instead of guessing.
`;
    } else if (selectedMcp.id === "tmdb") {
      toolInstruction = `
You have access to the ${selectedMcp.label}.

For any request involving movies, actors, directors, TV shows, film credits, or trending titles, use the TMDB MCP instead of answering from memory.
If the MCP fails, say so clearly instead of guessing.
`;
    }

    const fullPrompt = historyContext
      ? `${toolInstruction}\n\nPrevious conversation:\n${historyContext}\n\nUser: ${message}`
      : `${toolInstruction}\n\nUser: ${message}`;

    const toolPrefix = `mcp__${selectedMcp.id}__`;

    const mcpServers = {
      [selectedMcp.id]: {
        command: selectedMcp.command,
        args: selectedMcp.args,
        env: selectedMcp.env,
      },
    };

    let finalText = "";
    let lastAssistantText = "";
    let sawSelectedTool = false;
    let newsToolPayload = null;

    for await (const msg of query({
      prompt: fullPrompt,
      options: {
        permissionMode: agentConfig.permissionMode,
        allowDangerouslySkipPermissions: agentConfig.allowDangerouslySkipPermissions,
        maxTurns: agentConfig.maxTurns,
        mcpServers,
        allowedTools: [`${toolPrefix}*`],
      },
    })) {
      console.dir(msg, { depth: null });

      const raw = JSON.stringify(msg);

      if (raw.includes(toolPrefix)) {
        sawSelectedTool = true;
      }

      if (
        selectedMcp.id === "news" &&
        msg.type === "user" &&
        Array.isArray(msg.message?.content)
      ) {
        for (const item of msg.message.content) {
          if (item.type === "tool_result" && Array.isArray(item.content)) {
            for (const part of item.content) {
              if (part.type === "text") {
                try {
                  const parsed = JSON.parse(part.text);
                  if (parsed && Array.isArray(parsed.articles)) {
                    newsToolPayload = parsed;
                  }
                } catch {
                  // ignore non-JSON tool output
                }
              }
            }
          }
        }
      }

      if (msg.type === "assistant") {
        if (typeof msg.message?.content === "string") {
          lastAssistantText = msg.message.content;
        } else if (Array.isArray(msg.message?.content)) {
          const text = msg.message.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          if (text) lastAssistantText = text;
        }
      }

      if (msg.type === "result" && msg.subtype === "success") {
        finalText =
          typeof msg.result === "string"
            ? msg.result
            : JSON.stringify(msg.result, null, 2);
      }
    }

    if (selectedMcp.id === "news" && asksIfUsedMcp) {
      return res.json({
        reply: sawSelectedTool
          ? "Yes — this answer used the News MCP."
          : "No — the News MCP was not used.",
        selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
        usedTool: sawSelectedTool,
      });
    }

    if (selectedMcp.id === "news" && wantsLiteralHeadlineList) {
      if (!sawSelectedTool) {
        return res.json({
          reply: "The News MCP could not be used, so I can't verify live headlines right now.",
          selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
          usedTool: false,
        });
      }

      if (
        !newsToolPayload ||
        !Array.isArray(newsToolPayload.articles) ||
        newsToolPayload.articles.length === 0
      ) {
        return res.json({
          reply: "The News MCP ran, but it did not return any readable headlines.",
          selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
          usedTool: true,
        });
      }

      const articles = newsToolPayload.articles.slice(0, 8);
      lastNewsResultsByChat.set(historyKey, articles);

      const lines = articles.map((article, i) => {
        const title = article.title || "Untitled";
        const source = article.source || "Unknown source";
        const publishedAt = article.publishedAt || "Unknown date";
        return `${i + 1}. ${title}\n   Source: ${source}\n   Published: ${publishedAt}`;
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
      reply: finalText || lastAssistantText || "No response returned.",
      selectedMcp: { id: selectedMcp.id, label: selectedMcp.label },
      usedTool: sawSelectedTool,
    });
  } catch (err) {
    console.error("AGENT ERROR:", err);
    res.status(500).json({
      error: "Agent request failed.",
      details: err.message,
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});