#!/usr/bin/env node
// tmdb-mcp.js - TMDB MCP Server (stdio)
// Place this file in your project root

const https = require("https");

const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const BASE_URL = "https://api.themoviedb.org/3";

function tmdbGet(path) {
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${path}${path.includes("?") ? "&" : "?"}api_key=${TMDB_API_KEY}`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

const TOOLS = [
  {
    name: "search-movies",
    description: "Search for movies by title",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Movie title to search for" },
        page: { type: "number", description: "Page number (default: 1)" },
      },
      required: ["query"],
    },
  },
  {
    name: "get-movie-details",
    description: "Get detailed information about a movie by TMDB ID",
    inputSchema: {
      type: "object",
      properties: {
        movie_id: { type: "number", description: "TMDB movie ID" },
      },
      required: ["movie_id"],
    },
  },
  {
    name: "get-trending-movies",
    description: "Get trending movies (day or week)",
    inputSchema: {
      type: "object",
      properties: {
        time_window: { type: "string", enum: ["day", "week"], description: "Trending window (default: week)" },
      },
    },
  },
  {
    name: "search-people",
    description: "Search for actors, directors, and other people",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Person name to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "get-person-details",
    description: "Get detailed information about a person including biography and filmography",
    inputSchema: {
      type: "object",
      properties: {
        person_id: { type: "number", description: "TMDB person ID" },
      },
      required: ["person_id"],
    },
  },
  {
    name: "get-movie-credits",
    description: "Get cast and crew for a movie",
    inputSchema: {
      type: "object",
      properties: {
        movie_id: { type: "number", description: "TMDB movie ID" },
      },
      required: ["movie_id"],
    },
  },
  {
    name: "search-tv-shows",
    description: "Search for TV shows by title",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "TV show title to search for" },
      },
      required: ["query"],
    },
  },
  {
    name: "get-tv-details",
    description: "Get detailed information about a TV show by TMDB ID",
    inputSchema: {
      type: "object",
      properties: {
        tv_id: { type: "number", description: "TMDB TV show ID" },
      },
      required: ["tv_id"],
    },
  },
];

async function callTool(name, args) {
  switch (name) {
    case "search-movies": {
      const data = await tmdbGet(`/search/movie?query=${encodeURIComponent(args.query)}&page=${args.page || 1}`);
      const results = (data.results || []).slice(0, 5).map((m) => ({
        id: m.id,
        title: m.title,
        year: m.release_date?.slice(0, 4) || "N/A",
        rating: m.vote_average?.toFixed(1),
        overview: m.overview,
      }));
      return { results, total: data.total_results };
    }

    case "get-movie-details": {
      const m = await tmdbGet(`/movie/${args.movie_id}`);
      return {
        id: m.id,
        title: m.title,
        tagline: m.tagline,
        year: m.release_date?.slice(0, 4),
        rating: m.vote_average?.toFixed(1),
        runtime: m.runtime ? `${m.runtime} min` : null,
        genres: m.genres?.map((g) => g.name) || [],
        overview: m.overview,
        budget: m.budget ? `$${m.budget.toLocaleString()}` : null,
        revenue: m.revenue ? `$${m.revenue.toLocaleString()}` : null,
        poster: m.poster_path ? `https://image.tmdb.org/t/p/w500${m.poster_path}` : null,
        imdb_id: m.imdb_id,
      };
    }

    case "get-trending-movies": {
      const window = args.time_window || "week";
      const data = await tmdbGet(`/trending/movie/${window}`);
      return (data.results || []).slice(0, 10).map((m) => ({
        id: m.id,
        title: m.title,
        year: m.release_date?.slice(0, 4),
        rating: m.vote_average?.toFixed(1),
        overview: m.overview,
      }));
    }

    case "search-people": {
      const data = await tmdbGet(`/search/person?query=${encodeURIComponent(args.query)}`);
      return (data.results || []).slice(0, 5).map((p) => ({
        id: p.id,
        name: p.name,
        known_for_department: p.known_for_department,
        known_for: p.known_for?.map((k) => k.title || k.name).slice(0, 3) || [],
      }));
    }

    case "get-person-details": {
      const [person, credits] = await Promise.all([
        tmdbGet(`/person/${args.person_id}`),
        tmdbGet(`/person/${args.person_id}/combined_credits`),
      ]);
      const topCredits = (credits.cast || [])
        .sort((a, b) => b.popularity - a.popularity)
        .slice(0, 10)
        .map((c) => ({ title: c.title || c.name, year: (c.release_date || c.first_air_date || "").slice(0, 4), character: c.character }));
      return {
        id: person.id,
        name: person.name,
        birthday: person.birthday,
        birthplace: person.place_of_birth,
        biography: person.biography,
        known_for_department: person.known_for_department,
        top_credits: topCredits,
      };
    }

    case "get-movie-credits": {
      const data = await tmdbGet(`/movie/${args.movie_id}/credits`);
      return {
        cast: (data.cast || []).slice(0, 10).map((c) => ({ name: c.name, character: c.character, id: c.id })),
        director: data.crew?.find((c) => c.job === "Director")?.name || null,
        writers: data.crew?.filter((c) => c.job === "Writer" || c.job === "Screenplay").map((c) => c.name).slice(0, 3) || [],
      };
    }

    case "search-tv-shows": {
      const data = await tmdbGet(`/search/tv?query=${encodeURIComponent(args.query)}`);
      return (data.results || []).slice(0, 5).map((s) => ({
        id: s.id,
        name: s.name,
        first_air_date: s.first_air_date?.slice(0, 4),
        rating: s.vote_average?.toFixed(1),
        overview: s.overview,
      }));
    }

    case "get-tv-details": {
      const s = await tmdbGet(`/tv/${args.tv_id}`);
      return {
        id: s.id,
        name: s.name,
        first_air_date: s.first_air_date,
        last_air_date: s.last_air_date,
        status: s.status,
        seasons: s.number_of_seasons,
        episodes: s.number_of_episodes,
        rating: s.vote_average?.toFixed(1),
        genres: s.genres?.map((g) => g.name) || [],
        overview: s.overview,
        networks: s.networks?.map((n) => n.name) || [],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// MCP stdio protocol
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
    } catch (e) {
      // ignore parse errors
    }
  }
});

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

async function handleMessage(msg) {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0", id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "tmdb-mcp", version: "1.0.0" },
      },
    });
  } else if (msg.method === "notifications/initialized") {
    // no response needed
  } else if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === "tools/call") {
    try {
      const result = await callTool(msg.params.name, msg.params.arguments || {});
      send({
        jsonrpc: "2.0", id: msg.id,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
      });
    } catch (e) {
      send({
        jsonrpc: "2.0", id: msg.id,
        error: { code: -32000, message: e.message },
      });
    }
  } else if (msg.id !== undefined) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
  }
}