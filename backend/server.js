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
app.use(express.static(path.join(__dirname, "public")));

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

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});