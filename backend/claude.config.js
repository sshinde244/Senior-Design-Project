// claude.config.js

const path = require("path");

const chatConfig = {
  model: "claude-opus-4-5",
  maxTokens: 1024,
  systemPrompt: "You are a helpful assistant with access to tools selected by the app.",
};

const agentConfig = {
  promptPrefix: "",
  permissionMode: "auto",
  allowDangerouslySkipPermissions: false,
  maxTurns: 10,
};

const mcpRegistry = {
  census: {
    id: "census",
    label: "US Census MCP",
    command: "docker",
    args: ["exec", "-i", "-e", `CENSUS_API_KEY=${process.env.CENSUS_API_KEY}`, "mcp-server", "node", "dist/index.js"],
    env: { ...process.env },
  },

  tmdb: {
    id: "tmdb",
    label: "TMDB Movies & TV MCP",
    command: "node",
    args: [path.join(__dirname, "tmdb-mcp.js")],
    env: { ...process.env, TMDB_API_KEY: process.env.TMDB_API_KEY },
  },
};

module.exports = { chatConfig, agentConfig, mcpRegistry };