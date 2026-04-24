// ollama-agent.js
// Persistent MCP connections: MCP servers spin up once and stay alive.

const { Ollama } = require("ollama");
const { spawn } = require("child_process");

const ollama = new Ollama({
  host: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
});

const mcpPool = new Map();
let initPromise = null;

function createMcpClient(id, command, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    let buffer = "";
    const pending = new Map();
    let msgId = 1;
    let ready = false;

    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text) console.error(`[mcp:${id}:stderr] ${text}`);
    });

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
            const { resolve, reject, timeout } = pending.get(msg.id);
            clearTimeout(timeout);
            pending.delete(msg.id);

            if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
            else resolve(msg.result);
          }
        } catch (_) {
          // Ignore non-JSON stdout lines from MCP servers.
        }
      }
    });

    proc.on("error", (err) => {
      console.error(`[mcp-pool] Process error for ${id}: ${err.message}`);
      ready = false;
      mcpPool.delete(id);
      reject(err);
    });

    proc.on("exit", (code) => {
      console.error(`[mcp-pool] Process exited for ${id} (code ${code}) — will respawn on next request`);
      ready = false;
      mcpPool.delete(id);
    });

    function send(method, params = {}) {
      return new Promise((res, rej) => {
        const requestId = msgId++;

        const timeout = setTimeout(() => {
          if (pending.has(requestId)) {
            pending.delete(requestId);
            rej(new Error(`MCP request timed out (method: ${method})`));
          }
        }, 15000);

        pending.set(requestId, { resolve: res, reject: rej, timeout });

        proc.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            method,
            params,
          }) + "\n"
        );
      });
    }

    send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "ollama-agent", version: "1.0.0" },
    })
      .then(() => {
        proc.stdin.write(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "notifications/initialized",
          }) + "\n"
        );

        ready = true;
        console.error(`[mcp-pool] Connected: ${id}`);

        resolve({
          id,
          listTools: () => send("tools/list", {}),
          callTool: (name, args) =>
            send("tools/call", { name, arguments: args || {} }),
          isReady: () => ready,
          close: () => {
            ready = false;
            proc.kill();
          },
        });
      })
      .catch((err) => {
        ready = false;
        try {
          proc.kill();
        } catch (_) {}
        reject(err);
      });
  });
}

async function getMcpClient(mcpId, mcpConfig) {
  if (!mcpConfig) {
    throw new Error(`Missing MCP config for ${mcpId}`);
  }

  const existing = mcpPool.get(mcpId);
  if (existing?.isReady()) return existing;

  mcpPool.delete(mcpId);

  console.error(`[mcp-pool] Spawning new process for: ${mcpId}`);

  const client = await createMcpClient(
    mcpId,
    mcpConfig.command,
    mcpConfig.args || [],
    mcpConfig.env || {}
  );

  mcpPool.set(mcpId, client);
  return client;
}

async function initMcpPool(mcpRegistry) {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    console.error("[mcp-pool] Pre-warming MCP connections...");

    const entries = Object.values(mcpRegistry);
    const results = await Promise.allSettled(
      entries.map((mcp) => getMcpClient(mcp.id, mcp))
    );

    results.forEach((result, index) => {
      const id = entries[index].id;

      if (result.status === "fulfilled") {
        console.error(`[mcp-pool] ✓ ${id} ready`);
      } else {
        console.error(`[mcp-pool] ✗ ${id} failed: ${result.reason?.message}`);
      }
    });
  })();

  return initPromise;
}

function mcpToolToOllamaTool(mcpTool) {
  return {
    type: "function",
    function: {
      name: mcpTool.name,
      description: mcpTool.description || mcpTool.name,
      parameters: simplifySchema(
        mcpTool.inputSchema || { type: "object", properties: {} }
      ),
    },
  };
}

function simplifySchema(schema) {
  if (!schema || !schema.properties) return schema;

  const simplified = {
    type: "object",
    properties: {},
    required: schema.required || [],
  };

  for (const [key, val] of Object.entries(schema.properties)) {
    simplified.properties[key] = {
      type: val.type || "string",
      description: val.description || key,
      ...(val.enum ? { enum: val.enum } : {}),
    };
  }

  return simplified;
}

function extractTextToolCalls(content) {
  if (!content || typeof content !== "string") return null;

  const trimmed = content.trim();

  if (trimmed.startsWith("{") && trimmed.includes('"name"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.name && (parsed.parameters || parsed.arguments)) {
        return [
          {
            function: {
              name: parsed.name,
              arguments: parsed.parameters || parsed.arguments || {},
            },
          },
        ];
      }
    } catch (_) {}
  }

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed[0]?.name) {
        return parsed.map((p) => ({
          function: {
            name: p.name,
            arguments: p.parameters || p.arguments || {},
          },
        }));
      }
    } catch (_) {}
  }

  return null;
}

function compressToolResult(toolName, rawResult) {
  if (toolName !== "resolve-geography-fips") return rawResult;

  try {
    const jsonStart = rawResult.indexOf("[");
    if (jsonStart === -1) return rawResult;

    const geographies = JSON.parse(rawResult.slice(jsonStart));
    if (!Array.isArray(geographies) || geographies.length === 0) return rawResult;

    // Prefer state-level match first, then place/city/cdp
    const stateBest = geographies.find((g) =>
      /^state$/i.test(g.summary_level_name || "")
    );
    const placeBest = geographies.find((g) =>
      /cdp|place|town|city/i.test(g.summary_level_name || "")
    );
    const best = stateBest || placeBest || geographies[0];

    // Use the MCP-provided for_param/in_param directly — these are authoritative
    if (best.for_param) {
      const inClause = best.in_param ? `, in="${best.in_param}"` : "";
      console.error(`[compress-fips] Using for_param="${best.for_param}" in_param="${best.in_param || "none"}" name="${best.name}"`);
      return (
        `FIPS result: name="${best.name}". ` +
        `Now call fetch-aggregate-data with for="${best.for_param}"${inClause}, dataset="acs/acs5", year=2022, get={"variables":["NAME","B01003_001E"]}.`
      );
    }

    // Fallback: derive FIPS manually
    const fipsCode = best.fips_code || best.geoid || String(best.id);
    const stateFips = best.state_fips || best.state || (fipsCode.length >= 2 ? fipsCode.slice(0, 2) : null);
    const levelRaw = (best.summary_level_name || "").toLowerCase();
    const geoLevel =
      levelRaw.includes("place") || levelRaw.includes("cdp") ? "place" : "county";

    const inClause = (geoLevel === "place" && stateFips)
      ? `, in="state:${stateFips}"`
      : "";

    return (
      `FIPS result: name="${best.name}", fips_code="${fipsCode}", geo_level="${geoLevel}". ` +
      `Now call fetch-aggregate-data with for="${geoLevel}:${fipsCode}"${inClause}, dataset="acs/acs5", year=2022, get={"variables":["NAME","B01003_001E"]}.`
    );
  } catch (_) {
    return rawResult;
  }
}

function sanitizeCensusArgs(toolArgs) {
  if (!toolArgs.dataset || toolArgs.dataset === "acs/acs1") {
    toolArgs.dataset = "acs/acs5";
  }

  toolArgs.year = 2022; // Always use 2022

  const getVal = toolArgs.get;
  const hasValidGet =
    getVal &&
    typeof getVal === "object" &&
    Array.isArray(getVal.variables) &&
    getVal.variables.length > 0 &&
    getVal.variables.every((v) => typeof v === "string");

  if (!hasValidGet) {
    toolArgs.get = { variables: ["NAME", "B01003_001E"] };
  }

  if (toolArgs.for && /^(state|place|county):/i.test(toolArgs.for)) {
    // Only delete "in" for state-level queries; place/county queries may need it
    if (/^state:/i.test(toolArgs.for)) {
      delete toolArgs.in;
    }
  }

  return toolArgs;
}

const STATE_FIPS = {
  alabama:"01",alaska:"02",arizona:"04",arkansas:"05",california:"06",
  colorado:"08",connecticut:"09",delaware:"10",florida:"12",georgia:"13",
  hawaii:"15",idaho:"16",illinois:"17",indiana:"18",iowa:"19",kansas:"20",
  kentucky:"21",louisiana:"22",maine:"23",maryland:"24",massachusetts:"25",
  michigan:"26",minnesota:"27",mississippi:"28",missouri:"29",montana:"30",
  nebraska:"31",nevada:"32","new hampshire":"33","new jersey":"34",
  "new mexico":"35","new york":"36","north carolina":"37","north dakota":"38",
  ohio:"39",oklahoma:"40",oregon:"41",pennsylvania:"42","rhode island":"44",
  "south carolina":"45","south dakota":"46",tennessee:"47",texas:"48",
  utah:"49",vermont:"50",virginia:"51",washington:"53","west virginia":"54",
  wisconsin:"55",wyoming:"56",
  al:"01",ak:"02",az:"04",ar:"05",ca:"06",co:"08",ct:"09",de:"10",
  fl:"12",ga:"13",hi:"15",id:"16",il:"17",in:"18",ia:"19",ks:"20",
  ky:"21",la:"22",me:"23",md:"24",ma:"25",mi:"26",mn:"27",ms:"28",
  mo:"29",mt:"30",ne:"31",nv:"32",nh:"33",nj:"34",nm:"35",ny:"36",
  nc:"37",nd:"38",oh:"39",ok:"40",or:"41",pa:"42",ri:"44",sc:"45",
  sd:"46",tn:"47",tx:"48",ut:"49",vt:"50",va:"51",wa:"53",wv:"54",
  wi:"55",wy:"56",
};

function resolveStateFips(name) {
  if (!name) return null;
  return STATE_FIPS[name.trim().toLowerCase()] || null;
}

function normalizeToolArgs(args) {
  if (!args) return {};
  if (typeof args === "string") {
    try {
      return JSON.parse(args);
    } catch (_) {
      return {};
    }
  }
  return args;
}

async function runOllamaAgent({
  message,
  history = [],
  model,
  mcpId,
  mcpConfig,
  systemPrompt,
}) {
  const selectedModel =
    model || process.env.OLLAMA_TOOL_MODEL || process.env.OLLAMA_MODEL || "qwen2.5:latest";

  const mcp = await getMcpClient(mcpId, mcpConfig);

  if (!mcp.cachedTools) {
    const { tools: mcpTools } = await mcp.listTools();
    mcp.cachedTools = mcpTools.map(mcpToolToOllamaTool);
    console.error(`[ollama-agent] Cached ${mcp.cachedTools.length} tools for ${mcpId}`);
  }

  const messages = [];

  if (systemPrompt) {
    messages.push({ role: "system", content: systemPrompt });
  }

  for (const m of history) {
    messages.push({ role: m.role, content: m.content });
  }

  messages.push({ role: "user", content: message });

  // Short-circuit: list tools without calling model
  if (/list.*(tools?|mcp)|what tools|available tools|show.*tools/i.test(message)) {
    const toolList = mcp.cachedTools.map(t =>
      `• **${t.function.name}**: ${t.function.description}`
    ).join("\n");
    return {
      content: `Available tools for this MCP:\n\n${toolList}`,
      model: selectedModel,
      toolsUsed: [],
      usedTool: false,
    };
  }

  let finalText = "";
  const calledTools = [];
  let emptyTurns = 0;
  const MAX_TURNS = 10;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    console.error(`[ollama-agent] Turn ${turn + 1} (${selectedModel})`);

    const response = await ollama.chat({
      model: selectedModel,
      messages,
      tools: mcp.cachedTools,
      stream: false,
    });

    const assistantMsg = response.message || { role: "assistant", content: "" };
    messages.push(assistantMsg);

    console.error(
      `[ollama-agent] content: "${(assistantMsg.content || "").slice(0, 100)}", ` +
        `tool_calls: ${assistantMsg.tool_calls?.length || 0}`
    );

    const toolCalls =
      assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0
        ? assistantMsg.tool_calls
        : extractTextToolCalls(assistantMsg.content);

    if (!toolCalls) {
      if (!assistantMsg.content || assistantMsg.content.trim() === "") {
        emptyTurns++;

        if (emptyTurns >= 2) {
          console.error("[ollama-agent] Stalled twice — giving up");
          break;
        }

        console.error("[ollama-agent] Empty response — injecting nudge");
        messages.push({
          role: "user",
          content: "You have the tool results above. Please summarize the answer now.",
        });
        continue;
      }

      finalText = assistantMsg.content;
      break;
    }

    emptyTurns = 0;

    const toolResults = await Promise.all(
      toolCalls.map(async (toolCall) => {
        const toolName = toolCall.function.name;
        let toolArgs = normalizeToolArgs(toolCall.function.arguments);

        console.error(
          `[ollama-agent] Calling: ${toolName}(${JSON.stringify(toolArgs).slice(0, 150)})`
        );

        // Intercept resolve-geography-fips for US states — use local table, MCP returns wrong results
        if (toolName === "resolve-geography-fips") {
          const geoName = toolArgs.geography_name || toolArgs.name || "";
          const stateFips = resolveStateFips(geoName);
          if (stateFips) {
            console.error(`[ollama-agent] State FIPS shortcut: "${geoName}" => ${stateFips}`);
            return {
              role: "tool",
              content: `FIPS result: name="${geoName}". Now call fetch-aggregate-data with for="state:${stateFips}", dataset="acs/acs5", year=2022, get={"variables":["NAME","B01003_001E"]}.`,
            };
          }
        }

        // Block empty-arg calls
        const argValues = Object.values(toolArgs);
        const allEmpty = argValues.length === 0 || argValues.every(
          v => v === "" || v === 0 || v === null ||
          (Array.isArray(v) && v.length === 0) ||
          (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0)
        );
        if (allEmpty && toolName !== "list-datasets") {
          console.error(`[ollama-agent] Blocked empty-arg call to ${toolName}`);
          return { role: "tool", content: `Error: called ${toolName} with all-empty arguments. Provide real values.` };
        }

        calledTools.push(toolName);

        if (toolName === "fetch-aggregate-data") {
          if (toolArgs.for && !/^[a-z ]+:\S+$/i.test(toolArgs.for)) {
            console.error(`[ollama-agent] Census: bad "for" "${toolArgs.for}" — blocked`);

            return {
              role: "tool",
              content:
                `Error: "for" must be "geography-level:fips-code" e.g. "place:73980". ` +
                `Call resolve-geography-fips first to look up the code, then retry fetch-aggregate-data.`,
            };
          }

          toolArgs = sanitizeCensusArgs(toolArgs);
          console.error(`[ollama-agent] Census patched args: ${JSON.stringify(toolArgs).slice(0, 150)}`);
        }

        try {
          const mcpResult = await mcp.callTool(toolName, toolArgs);
          const rawResult =
            mcpResult.content?.map((c) => c.text).join("\n") ||
            JSON.stringify(mcpResult);

          const result = compressToolResult(toolName, rawResult);

          console.error(`[ollama-agent] Result: ${result.slice(0, 300)}`);

          return {
            role: "tool",
            content: result,
          };
        } catch (err) {
          console.error(`[ollama-agent] Tool error: ${err.message}`);

          return {
            role: "tool",
            content: `Tool error: ${err.message}. Do NOT guess or estimate — tell the user the data could not be retrieved.`,
          };
        }
      })
    );

    messages.push(...toolResults);
  }

  const uniqueTools = [...new Set(calledTools)];

  return {
    content: finalText || "No response returned.",
    model: selectedModel,
    toolsUsed: uniqueTools,
    usedTool: uniqueTools.length > 0,
  };
}

function shutdownMcpPool() {
  for (const [id, client] of mcpPool.entries()) {
    console.error(`[mcp-pool] Closing: ${id}`);
    client.close();
  }

  mcpPool.clear();
  initPromise = null;
}

module.exports = {
  runOllamaAgent,
  initMcpPool,
  shutdownMcpPool,
  getMcpClient,
};