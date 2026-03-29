// claude.config.js — place this in your backend/ folder

const chatConfig = {
  model: "claude-opus-4-5",
  maxTokens: 1024,
  systemPrompt: "You are a helpful assistant with access to US Census Bureau data.",
};

const agentConfig = {
  promptPrefix: "",
  permissionMode: "auto",
  allowDangerouslySkipPermissions: false,
  maxTurns: 10,
  mcpServers: {
    "mcp-census-api": {
      command: "wsl",
      args: [
        "bash",
        "/mnt/c/Users/OGWar/Documents/us-census-bureau-data-api-mcp-main/scripts/mcp-connect.sh"
      ],
      env: {
        CENSUS_API_KEY: process.env.CENSUS_API_KEY,
      },
    },
  },
  allowedTools: [],
};

module.exports = { chatConfig, agentConfig };