// ollama-agent.js
// Uses persistent MCP connections — servers spin up once at startup and stay alive.

const { Ollama } = require("ollama");
const { spawn } = require("child_process");

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST ?? "http://localhost:11434",
});

// ── Persistent MCP client pool ────────────────────────────────────────────────
// One live process per MCP id, reused across all requests.

const mcpPool = new Map(); // mcpId → client

function createMcpClient(id, command, args, env) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let buffer = "";
    const pending = new Map();
    let msgId = 1;
    let ready = false;

    proc.stderr.on("data", () => {});

    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) reject(new Error(msg.error.message));
            else resolve(msg.result);
          }
        } catch (_) {}
      }
    });

    proc.on("error", (err) => {
      console.error(`[mcp-pool] Process error for ${id}:`, err.message);
      mcpPool.delete(id);
    });

    proc.on("exit", (code) => {
      console.error(`[mcp-pool] Process exited for ${id} (code ${code}) — will respawn on next request`);
      mcpPool.delete(id);
    });

    function send(method, params) {
      return new Promise((res, rej) => {
        const id = msgId++;
        pending.set(id, { resolve: res, reject: rej });
        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        // Timeout after 15s to avoid hanging forever
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            rej(new Error(`MCP request timed out (method: ${method})`));
          }
        }, 15000);
      });
    }

    // Handshake
    send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ollama-agent", version: "1.0.0" },
    })
      .then((result) => {
        proc.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
        );
        ready = true;
        console.error(`[mcp-pool] Connected: ${id}`);
        resolve({
          id,
          listTools: () => send("tools/list", {}),
          callTool: (name, args) => send("tools/call", { name, arguments: args }),
          isReady: () => ready,
          close: () => { ready = false; proc.kill(); },
        });
      })
      .catch(reject);
  });
}

// Get or create a persistent MCP client
async function getMcpClient(mcpId, mcpConfig) {
  if (mcpPool.has(mcpId)) {
    const client = mcpPool.get(mcpId);
    if (client.isReady()) return client;
    // Was marked not ready (crashed) — remove and respawn
    mcpPool.delete(mcpId);
  }

  console.error(`[mcp-pool] Spawning new process for: ${mcpId}`);
  const client = await createMcpClient(mcpId, mcpConfig.command, mcpConfig.args, mcpConfig.env || {});
  mcpPool.set(mcpId, client);
  return client;
}

// Call this from server.js at startup to pre-warm all MCP connections
async function initMcpPool(mcpRegistry) {
  console.error("[mcp-pool] Pre-warming MCP connections...");
  const results = await Promise.allSettled(
    Object.values(mcpRegistry).map((mcp) =>
      getMcpClient(mcp.id, { command: mcp.command, args: mcp.args, env: mcp.env })
    )
  );
  results.forEach((r, i) => {
    const id = Object.keys(mcpRegistry)[i];
    if (r.status === "fulfilled") console.error(`[mcp-pool] ✓ ${id} ready`);
    else console.error(`[mcp-pool] ✗ ${id} failed: ${r.reason?.message}`);
  });
}

// ── Tool schema helpers ───────────────────────────────────────────────────────

function mcpToolToOllamaTool(mcpTool) {
  return {
    type: "function",
    function: {
      name: mcpTool.name,
      description: mcpTool.description,
      // Strip verbose nested descriptions that confuse small models
      parameters: simplifySchema(mcpTool.inputSchema || { type: "object", properties: {} }),
    },
  };
}

function simplifySchema(schema) {
  if (!schema || !schema.properties) return schema;
  const simplified = { type: "object", properties: {}, required: schema.required || [] };
  for (const [key, val] of Object.entries(schema.properties)) {
    simplified.properties[key] = {
      type: val.type || "string",
      description: val.description || key,
      ...(val.enum ? { enum: val.enum } : {}),
    };
  }
  return simplified;
}

// ── Text tool call fallback (for weaker models) ───────────────────────────────

function extractTextToolCalls(content) {
  if (!content || typeof content !== "string") return null;
  const trimmed = content.trim();

  if (trimmed.startsWith("{") && trimmed.includes('"name"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.name && (parsed.parameters || parsed.arguments)) {
        const args = parsed.parameters || parsed.arguments;
        // Make sure args are actual values not schema objects
        if (typeof args === "object" && !args.type) {
          return [{ function: { name: parsed.name, arguments: args } }];
        }
      }
    } catch (_) {}
  }

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed[0]?.name) {
        return parsed.map(p => ({
          function: { name: p.name, arguments: p.parameters || p.arguments || {} },
        }));
      }
    } catch (_) {}
  }

  return null;
}

// ── Main agent loop ───────────────────────────────────────────────────────────

async function runOllamaAgent({ message, history = [], model, mcpId, mcpConfig, systemPrompt }) {
  model = model ?? process.env.OLLAMA_MODEL ?? "qwen2.5";

  // Get persistent connection — no cold start after first request
  const mcp = await getMcpClient(mcpId, mcpConfig);

  // Cache tool list per MCP (tools don't change at runtime)
  if (!mcp.cachedTools) {
    const { tools: mcpTools } = await mcp.listTools();
    mcp.cachedTools = mcpTools.map(mcpToolToOllamaTool);
    console.error(`[ollama-agent] Cached ${mcp.cachedTools.length} tools for ${mcpId}`);
  }
  const tools = mcp.cachedTools;

  const messages = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  for (const m of history) messages.push({ role: m.role, content: m.content });
  messages.push({ role: "user", content: message });

  let finalText = "";
  const MAX_TURNS = 8;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    console.error(`[ollama-agent] Turn ${turn + 1} (${model})`);

    const response = await ollama.chat({ model, messages, tools, stream: false });
    const assistantMsg = response.message;
    messages.push(assistantMsg);

    console.error(`[ollama-agent] content: "${assistantMsg.content?.slice(0, 80)}", tool_calls: ${assistantMsg.tool_calls?.length ?? 0}`);

    const toolCalls = (assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0)
      ? assistantMsg.tool_calls
      : extractTextToolCalls(assistantMsg.content);

    if (!toolCalls) {
      finalText = assistantMsg.content || "";
      break;
    }

    // Execute tool calls (in parallel if multiple)
    const toolResults = await Promise.all(
      toolCalls.map(async (toolCall) => {
        const toolName = toolCall.function.name;
        const toolArgs = typeof toolCall.function.arguments === "string"
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments || {};

        console.error(`[ollama-agent] Calling: ${toolName}(${JSON.stringify(toolArgs).slice(0, 80)})`);

        try {
          const mcpResult = await mcp.callTool(toolName, toolArgs);
          const result = mcpResult.content?.map((c) => c.text).join("\n") || JSON.stringify(mcpResult);
          console.error(`[ollama-agent] Result: ${result.slice(0, 120)}`);
          return { role: "tool", content: result };
        } catch (err) {
          console.error(`[ollama-agent] Tool error: ${err.message}`);
          return { role: "tool", content: `Tool error: ${err.message}` };
        }
      })
    );

    messages.push(...toolResults);
  }

  return { content: finalText || "No response returned.", model };
}

// Shut down all MCP processes cleanly
function shutdownMcpPool() {
  for (const [id, client] of mcpPool.entries()) {
    console.error(`[mcp-pool] Closing: ${id}`);
    client.close();
  }
  mcpPool.clear();
}

module.exports = { runOllamaAgent, initMcpPool, shutdownMcpPool, getMcpClient };
