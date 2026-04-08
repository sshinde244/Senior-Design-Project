#!/usr/bin/env node
const https = require("https");

const NEWS_API_KEY = process.env.NEWS_API_KEY || "";
const BASE_URL = "https://newsapi.org/v2";

console.error("NEWS MCP STARTED");
console.error("NEWS_API_KEY PRESENT IN MCP:", !!process.env.NEWS_API_KEY);

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "SeniorDesignProject/1.0 (News MCP)",
          "Accept": "application/json",
          "X-Api-Key": NEWS_API_KEY,
        },
      },
      (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);

            if (res.statusCode >= 400 || parsed.status === "error") {
              reject(new Error(parsed.message || `News API error (${res.statusCode})`));
              return;
            }

            resolve({ statusCode: res.statusCode, data: parsed });
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.on("error", reject);
  });
}

if (process.argv.includes("--self-test")) {
  const testUrl = `${BASE_URL}/top-headlines?country=us`;

  requestJson(testUrl)
    .then(({ statusCode, data }) => {
      console.error("SELF TEST STATUS:", statusCode);
      console.error("SELF TEST BODY:", JSON.stringify(data, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error("SELF TEST ERROR:", err.message);
      process.exit(1);
    });
}

function newsGet(path) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${path}`;

    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "SeniorDesignProject/1.0 (News MCP)",
          "Accept": "application/json",
          "X-Api-Key": NEWS_API_KEY,
        },
      },
      (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);

            if (res.statusCode >= 400 || parsed.status === "error") {
              reject(new Error(parsed.message || `News API error (${res.statusCode})`));
              return;
            }

            resolve(parsed);
          } catch (err) {
            reject(err);
          }
        });
      }
    );

    req.on("error", reject);
  });
}

const TOOLS = [
  {
    name: "get-top-headlines",
    description: "Get top breaking headlines by country/category/query",
    inputSchema: {
      type: "object",
      properties: {
        country: { type: "string", description: "2-letter country code like us" },
        category: {
          type: "string",
          enum: ["business", "entertainment", "general", "health", "science", "sports", "technology"],
          description: "News category"
        },
        query: { type: "string", description: "Optional keyword search" },
        page: { type: "number", description: "Page number" }
      }
    }
  },
  {
    name: "search-news",
    description: "Search articles across News API's article index",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords or phrase to search for" },
        from: { type: "string", description: "Start date YYYY-MM-DD" },
        to: { type: "string", description: "End date YYYY-MM-DD" },
        language: { type: "string", description: "Language code like en" },
        sortBy: {
          type: "string",
          enum: ["relevancy", "popularity", "publishedAt"],
          description: "Sort order"
        },
        page: { type: "number", description: "Page number" }
      },
      required: ["query"]
    }
  },
  {
    name: "list-news-sources",
    description: "List available news publishers by category/language/country",
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: ["business", "entertainment", "general", "health", "science", "sports", "technology"]
        },
        language: { type: "string", description: "Language code like en" },
        country: { type: "string", description: "2-letter country code like us" }
      }
    }
  }
];

function buildQuery(params) {
  const query = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      query.append(key, String(value));
    }
  });

  return query.toString();
}

async function callTool(name, args) {
  switch (name) {
    case "get-top-headlines": {
      const qs = buildQuery({
        country: args.country || "us",
        category: args.category,
        q: args.query,
        page: args.page || 1,
        pageSize: 10
      });

      const data = await newsGet(`/top-headlines?${qs}`);

      return {
        totalResults: data.totalResults,
        articles: (data.articles || []).slice(0, 10).map((a) => ({
          source: a.source?.name || null,
          title: a.title,
          description: a.description,
          url: a.url,
          publishedAt: a.publishedAt
        }))
      };
    }

    case "search-news": {
      const qs = buildQuery({
        q: args.query,
        from: args.from,
        to: args.to,
        language: args.language || "en",
        sortBy: args.sortBy || "publishedAt",
        page: args.page || 1,
        pageSize: 10
      });

      const data = await newsGet(`/everything?${qs}`);

      return {
        totalResults: data.totalResults,
        articles: (data.articles || []).slice(0, 10).map((a) => ({
          source: a.source?.name || null,
          title: a.title,
          description: a.description,
          url: a.url,
          publishedAt: a.publishedAt
        }))
      };
    }

    case "list-news-sources": {
      const qs = buildQuery({
        category: args.category,
        language: args.language || "en",
        country: args.country
      });

      const data = await newsGet(`/top-headlines/sources?${qs}`);

      return {
        sources: (data.sources || []).map((s) => ({
          id: s.id,
          name: s.name,
          category: s.category,
          language: s.language,
          country: s.country,
          url: s.url
        }))
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// MCP stdio
let buffer = "";
process.stdin.setEncoding("utf8");

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();

  for (const line of lines) {
    if (!line.trim()) continue;

    try {
      handleMessage(JSON.parse(line));
    } catch (_) {}
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handleMessage(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "news-mcp", version: "1.0.0" }
      }
    });
    return;
  }

  if (msg.method === "notifications/initialized") return;

  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { tools: TOOLS }
    });
    return;
  }

  if (msg.method === "tools/call") {
    try {
      const result = await callTool(msg.params.name, msg.params.arguments || {});
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        }
      });
    } catch (err) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32000,
          message: err.message
        }
      });
    }
    return;
  }

  if (msg.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      error: { code: -32601, message: "Method not found" }
    });
  }
}