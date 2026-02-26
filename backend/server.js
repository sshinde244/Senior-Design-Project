require("dotenv").config();
const express = require("express");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

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

    // Messages API is stateless — send full history if you want continuity.
    const messages = [
      ...history,
      { role: "user", content: message }
    ];

    const response = await client.messages.create({
      model: "claude-sonnet-4-5", // use a model name available to your account
      max_tokens: 500,
      messages
    });

    // Anthropic response content is an array; usually text is in content[0].text
    const text =
      response.content?.find((c) => c.type === "text")?.text ||
      "No text response returned.";

    res.json({ reply: text });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Claude request failed.",
      details: err.message || "Unknown error"
    });
  }
});

app.post("/api/agent", async (req, res) => {
  try {
    const { message } = req.body;

    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Message is required." });
    }

    // Agent SDK expects an async generator prompt stream (not a plain string)
    async function* promptStream() {
      yield {
        type: "user",
        message: {
          role: "user",
          content: message,
        },
      };
    }

    // Your server.js is CommonJS (require). The Agent SDK is ESM-friendly.
    // Dynamic import avoids changing your whole project to ESM.
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    let finalText = "";

    for await (const msg of query({
      prompt: promptStream(),
      options: {
        // DEV MODE: don't get blocked by "grant permission" prompts
        permissionMode: "bypassPermissions",

        // ---- MCP SERVER CONFIG ----
        // Replace this with YOUR MCP server in Step 4.
        // For now, keep it as-is just to prove wiring works.
        // mcpServers: {
        //   "claude-code-docs": {
        //     type: "http",
        //     url: "https://code.claude.com/docs/mcp",
        //   },
        // },

        // // Allow tools from that MCP server
        // allowedTools: ["mcp__claude-code-docs__*"],

        mcpServers: {
          "mcp-census-api": {
            command: "bash",
            args: ["/Users/shaunak/Documents/SDP/us-census-bureau-data-api-mcp-main/scripts/mcp-connect.sh"],
            env: { CENSUS_API_KEY: process.env.CENSUS_API_KEY }
          }
        },
        allowedTools: ["mcp__mcp-census-api__*"], // dev

        maxTurns: 6,
      },
    })) {
      if (msg.type === "result" && msg.subtype === "success") {
        finalText = msg.result;
      }
    }

    res.json({ reply: finalText || "No response returned." });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Agent request failed.",
      details: err.message || "Unknown error",
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});