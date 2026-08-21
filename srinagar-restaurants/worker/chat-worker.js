// Cloudflare Worker — backend for the "Ask About Srinagar Restaurants" chat
// AND the feedback form on nabeelnisar.com/srinagar-restaurants/. Holds the
// Groq API key server-side so it never reaches the browser, and stores
// feedback submissions in Cloudflare KV.
//
// DEPLOY:
//   1. workers.cloudflare.com -> Create -> "Create Worker" -> paste this file in.
//   2. Settings -> Variables -> add secret GROQ_API_KEY (your Groq key).
//   3. Settings -> Variables -> add ALLOWED_ORIGIN = https://nabeelnisar.com
//   4. Settings -> Bindings -> add a KV Namespace binding named FEEDBACK_KV
//      (create a new namespace if you don't have one yet, e.g. "srinagar-feedback").
//   5. Deploy. Copy the *.workers.dev URL it gives you.
//   6. Paste that URL into CHAT_WORKER_URL in srinagar-restaurants/index.html.
//
// To read submitted feedback: Cloudflare dashboard -> Workers & Pages -> KV ->
// open the srinagar-feedback namespace -> browse keys. No custom admin UI needed.
//
// This intentionally caps context size and chat history on every request —
// the original Streamlit chatbot hit Groq's 8000 TPM rate limit because it
// resent the *entire* growing conversation on every turn. This never does that.

const SYSTEM_PROMPT = `You are a helpful assistant for a Srinagar restaurant guide.
For restaurant recommendations, you ONLY know about the restaurants explicitly
listed in the "REAL RESTAURANT DATA" block below, sourced from Google Places.
Never invent a restaurant, address, dish, rating, or fact not in that block.
For general questions about Srinagar itself (population, geography, well-known
attractions), you may also use the "SRINAGAR FACTS" block below, but never state
a number or fact about Srinagar that isn't in that block, say you don't have
verified data for it instead. If neither block answers the question, say so
honestly. Keep answers short (2-4 sentences), conversational, and cite specific
restaurant names from the data when recommending something.`;

const SRINAGAR_FACTS = `- Srinagar district population: 1,236,829 (Census of India 2011, the most recent official census; India's 2021 census was postponed and has not been conducted)
- Srinagar district sex ratio: 900 females per 1,000 males (Census 2011)
- Srinagar district literacy rate: 69.41% (Census 2011)
- Srinagar is the summer capital of Jammu and Kashmir, built along the Jhelum River and Dal Lake
- Well-known attractions: Dal Lake, Nishat Bagh, Shalimar Bagh, Chashme Shahi, Pari Mahal, Indira Gandhi Memorial Tulip Garden, Jawaharlal Nehru Memorial Botanical Garden, Shankaracharya Temple, Dargah Hazratbal, Naseem Bagh, Lal Chowk, Jhelum River`;

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

    const url = new URL(request.url);

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { ...headers, "Content-Type": "application/json" },
      });
    }

    if (url.pathname === "/feedback") {
      return handleFeedback(body, env, headers);
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
      { role: "user", content: `SRINAGAR FACTS:\n${SRINAGAR_FACTS}\n\nREAL RESTAURANT DATA:\n${context}\n\nQuestion: ${query}` },
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

async function handleFeedback(body, env, headers) {
  const text = (body.text || "").toString().trim().slice(0, 2000);
  const source = (body.source || "guide").toString().slice(0, 50);

  if (!text) {
    return new Response(JSON.stringify({ error: "Empty feedback" }), {
      status: 400,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }
  if (!env.FEEDBACK_KV) {
    return new Response(JSON.stringify({ error: "Feedback storage not configured" }), {
      status: 500,
      headers: { ...headers, "Content-Type": "application/json" },
    });
  }

  const key = `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
  await env.FEEDBACK_KV.put(key, JSON.stringify({ text, source, timestamp: new Date().toISOString() }));

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
