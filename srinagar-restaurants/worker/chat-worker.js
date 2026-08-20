// Cloudflare Worker — backend for the "Ask About Srinagar Restaurants" chat
// on nabeelnisar.com/srinagar-restaurants/. Holds the Groq API key server-side
// so it never reaches the browser.
//
// DEPLOY:
//   1. workers.cloudflare.com -> Create -> "Create Worker" -> paste this file in.
//   2. Settings -> Variables -> add secret GROQ_API_KEY (your Groq key).
//   3. Settings -> Variables -> add ALLOWED_ORIGIN = https://nabeelnisar.com
//   4. Deploy. Copy the *.workers.dev URL it gives you.
//   5. Paste that URL into CHAT_WORKER_URL in srinagar-restaurants/index.html.
//
// This intentionally caps context size and chat history on every request —
// the original Streamlit chatbot hit Groq's 8000 TPM rate limit because it
// resent the *entire* growing conversation on every turn. This never does that.

const SYSTEM_PROMPT = `You are a helpful assistant for a Srinagar restaurant guide.
You ONLY know about the restaurants explicitly listed in the "REAL RESTAURANT DATA"
block below, sourced from Google Places. Never invent a restaurant, address, dish,
or fact not in that block. If the block is empty or doesn't answer the question,
say so honestly. Keep answers short (2-4 sentences), conversational, and cite
specific restaurant names from the data when recommending something.`;

const GROQ_MODEL = "openai/gpt-oss-120b";
const MAX_HISTORY_TURNS = 4; // hard cap regardless of what the client sends

function corsHeaders(origin, allowedOrigin) {
  const allow = origin === allowedOrigin ? origin : allowedOrigin;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowedOrigin = env.ALLOWED_ORIGIN || "https://nabeelnisar.com";
    const headers = corsHeaders(origin, allowedOrigin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers });
    }
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "POST only" }), {
        status: 405,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const query = (body.query || "").toString().slice(0, 500);
    const context = (body.context || "").toString().slice(0, 3000);
    const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY_TURNS) : [];

    if (!query.trim()) {
      return new Response(JSON.stringify({ error: "Missing query" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...history,
      { role: "user", content: `REAL RESTAURANT DATA:\n${context}\n\nQuestion: ${query}` },
    ];

    try {
      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.GROQ_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages,
          max_tokens: 350,
          temperature: 0.4,
        }),
      });

      if (!groqRes.ok) {
        const errText = await groqRes.text();
        return new Response(
          JSON.stringify({ reply: "The AI is getting a lot of questions right now — try again in a moment.", debug: errText.slice(0, 300) }),
          { status: 200, headers: { ...headers, "Content-Type": "application/json" } }
        );
      }

      const data = await groqRes.json();
      const reply = data.choices?.[0]?.message?.content?.trim() || "Sorry, I couldn't get an answer just now.";

      return new Response(JSON.stringify({ reply }), {
        headers: { ...headers, "Content-Type": "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ reply: "Something went wrong reaching the AI. Try again shortly." }), {
        status: 200,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }
  },
};
