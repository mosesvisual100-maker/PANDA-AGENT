/**
 * Panda proxy — the backend the app expects.
 *
 * Implements the exact contract `PandaApi.kt` calls, so a rebuilt Panda points at this URL and
 * works. No third-party SDKs: Node 20 has global `fetch`, and keeping dependencies to Express
 * alone means Render builds in seconds and nothing breaks on a transitive bump.
 *
 * Endpoints
 *   POST /v1/chat          — one agent step; returns assistant text the app parses for tool calls
 *   GET  /v1/models        — model ids
 *   POST /v1/tts           — text to speech, returns audio bytes
 *   POST /v1/stt           — WAV bytes to text
 *   GET  /v1/me            — identity echo
 *   POST /v1/connectors    — list connectors
 *   POST /v1/connectors/run— run a connector (unsupported here, says so honestly)
 *   POST /v1/generate/ext  — extension generation (unsupported here, says so honestly)
 *   POST /v1/feedback      — accepted and logged
 *   POST /v1/telemetry     — accepted and discarded
 *   GET  /health           — liveness probe for Render
 *
 * Provider: any OpenAI-compatible chat-completions API. Set OPENAI_API_KEY (OpenAI) or
 * set LLM_BASE_URL + LLM_API_KEY to point at Groq/Together/OpenRouter/DeepSeek/Ollama.
 * If no key is configured the server still starts and reports itself as unconfigured rather
 * than pretending to work.
 */

const express = require("express");

const app = express();

// Agent transcripts with big tool lists can be large; the app sends full history each step.
app.use(express.json({ limit: "25mb" }));
app.use(express.raw({ type: ["audio/wav", "audio/*", "application/octet-stream"], limit: "25mb" }));

// ---------------------------------------------------------------- config

const PORT = process.env.PORT || 3000;

const LLM_BASE_URL = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

// Optional speech providers. Both degrade to a clear error, never to silence.
const TTS_MODEL = process.env.TTS_MODEL || "tts-1";
const TTS_VOICE = process.env.TTS_VOICE || "alloy";
const STT_MODEL = process.env.STT_MODEL || "whisper-1";

const configured = () => Boolean(LLM_API_KEY);

// ---------------------------------------------------------------- logging

function log(...a) {
  console.log(new Date().toISOString(), ...a);
}

// Request log without bodies — transcripts contain the user's messages.
app.use((req, _res, next) => {
  log(req.method, req.path, req.headers["content-length"] || "-");
  next();
});

// CORS: the app is native so it does not need this, but a browser test does.
app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("Access-Control-Allow-Methods", "*");
  next();
});

// ---------------------------------------------------------------- helpers

function fail(res, status, message) {
  res.status(status).json({ error: { message, type: "panda_error" } });
}

/**
 * The app accepts a bare string, or `data.content`, or `data.message.content`.
 * We return the richest shape so every branch in `PandaApi.chat` resolves the same text.
 */
function reply(res, { text, model, inputTokens, outputTokens, id }) {
  res.json({
    id: id || `chatcmpl-${Date.now()}`,
    model: model || LLM_MODEL,
    content: text,
    text,
    usage: { input_tokens: inputTokens || 0, output_tokens: outputTokens || 0 },
    data: {
      id: id || `chatcmpl-${Date.now()}`,
      model: model || LLM_MODEL,
      content: text,
      usage: { input_tokens: inputTokens || 0, output_tokens: outputTokens || 0 },
    },
  });
}

// ---------------------------------------------------------------- health

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    configured: configured(),
    model: LLM_MODEL,
    provider: LLM_BASE_URL,
    uptime_s: Math.round(process.uptime()),
  });
});

// ---------------------------------------------------------------- chat

app.post("/v1/chat", async (req, res) => {
  if (!configured()) {
    return fail(
      res,
      503,
      "Server has no LLM_API_KEY set. Add one in the Render dashboard (Environment) and redeploy."
    );
  }

  const { messages, model, max_tokens } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return fail(res, 400, "messages must be a non-empty array");
  }

  /*
   * IMPORTANT — how the app actually talks to us.
   *
   * `PromptBuilder.build()` puts the whole tool catalogue into the *system prompt text* under
   * <available_tools>, and `AgentLoop` sends only plain {role, content} messages. The app does
   * NOT send native `tools`/`tool_choice`, and it does NOT read native `tool_calls` back.
   *
   * What it reads is text, parsed by `TurnParser`, which accepts:
   *   1. {"tool_calls":[{"name":…,"arguments":{…}}]}
   *   2. {"name":…,"arguments":{…}}          <- single call
   *   3. [{…},{…}]                           <- bare array
   *
   * So we must forward a plain chat completion and return the model's text unchanged. Passing
   * native tools would make the upstream return `tool_calls` that the app never looks at, and
   * the agent would stall with an empty step forever.
   */
  const body = {
    model: model || LLM_MODEL,
    messages,
    max_tokens: Math.min(Number(max_tokens) || 4096, 8192),
    temperature: 0.2,
  };

  const started = Date.now();
  try {
    const r = await fetch(`${LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify(body),
    });

    const raw = await r.text();
    if (!r.ok) {
      log("upstream", r.status, raw.slice(0, 300));
      return fail(res, r.status, `Upstream ${r.status}: ${raw.slice(0, 400)}`);
    }

    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      return fail(res, 502, "Upstream returned non-JSON");
    }

    const choice = json.choices && json.choices[0];
    if (!choice) return fail(res, 502, "Upstream returned no choices");

    const msg = choice.message || {};

    // Belt and braces: if a model ignores instructions and emits native tool_calls anyway,
    // convert them into the envelope TurnParser understands instead of returning empty text.
    let text = msg.content || "";
    if (!text && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      const calls = msg.tool_calls.map((tc) => {
        let args = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}");
        } catch {
          args = {};
        }
        return { name: tc.function.name, arguments: args };
      });
      text = JSON.stringify({ tool_calls: calls });
      log("converted native tool_calls ->", calls.length);
    }

    log("chat ok", Date.now() - started, "ms", "len", text.length);

    reply(res, {
      text,
      model: json.model,
      inputTokens: json.usage?.prompt_tokens,
      outputTokens: json.usage?.completion_tokens,
      id: json.id,
    });
  } catch (e) {
    log("chat error", e.message);
    fail(res, 502, `Upstream request failed: ${e.message}`);
  }
});

// ---------------------------------------------------------------- models

app.get("/v1/models", async (_req, res) => {
  if (!configured()) {
    return res.json({ data: [LLM_MODEL], configured: false });
  }
  try {
    const r = await fetch(`${LLM_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${LLM_API_KEY}` },
    });
    if (!r.ok) return res.json({ data: [LLM_MODEL] });
    const j = await r.json();
    const ids = (j.data || []).map((m) => m.id).filter(Boolean);
    res.json({ data: ids.length ? ids : [LLM_MODEL] });
  } catch {
    res.json({ data: [LLM_MODEL] });
  }
});

// ---------------------------------------------------------------- speech

app.post("/v1/tts", async (req, res) => {
  if (!configured()) return fail(res, 503, "Server has no LLM_API_KEY set.");

  const { text, voice, speed } = req.body || {};
  if (!text) return fail(res, 400, "text required");

  try {
    const r = await fetch(`${LLM_BASE_URL}/audio/speech`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: TTS_MODEL,
        voice: voice || TTS_VOICE,
        input: String(text).slice(0, 4000),
        speed: Number(speed) || 1,
        response_format: "mp3",
      }),
    });

    if (!r.ok) {
      const t = await r.text();
      log("tts upstream", r.status, t.slice(0, 200));
      // Say so clearly: the app's Speaker falls back to the device's own TTS on a failure.
      return fail(res, r.status, `TTS unavailable: ${t.slice(0, 200)}`);
    }

    const buf = Buffer.from(await r.arrayBuffer());
    res.set("Content-Type", "audio/mpeg").send(buf);
  } catch (e) {
    fail(res, 502, `TTS failed: ${e.message}`);
  }
});

app.post("/v1/stt", async (req, res) => {
  if (!configured()) return fail(res, 503, "Server has no LLM_API_KEY set.");

  // The app posts raw WAV bytes as the body.
  let audio = req.body;
  if (!Buffer.isBuffer(audio) || audio.length < 100) {
    return fail(res, 400, "expected raw WAV bytes in the body");
  }

  if (audio.slice(0, 4).toString() !== "RIFF") {
    return fail(res, 400, "body is not a RIFF/WAV file");
  }

  try {
    const form = new FormData();
    form.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
    form.append("model", STT_MODEL);
    form.append("language", req.query.language || "en");

    const r = await fetch(`${LLM_BASE_URL}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${LLM_API_KEY}` },
      body: form,
    });

    const raw = await r.text();
    if (!r.ok) {
      log("stt upstream", r.status, raw.slice(0, 200));
      return fail(res, r.status, `STT unavailable: ${raw.slice(0, 200)}`);
    }

    let text = "";
    try {
      text = JSON.parse(raw).text || "";
    } catch {
      text = raw;
    }
    res.json({ text, data: { text } });
  } catch (e) {
    fail(res, 502, `STT failed: ${e.message}`);
  }
});

// ---------------------------------------------------------------- misc

app.get("/v1/me", (req, res) => {
  res.json({
    id: "panda-local",
    email: null,
    plan: "free",
    auth: req.headers.authorization ? "present" : "absent",
  });
});

app.post("/v1/connectors", (_req, res) => {
  res.json({ data: [] });
});

app.post("/v1/connectors/run", (_req, res) => {
  // Honest: this build has no connector integrations. Returning fake success would make the
  // agent believe an action happened when it did not.
  fail(res, 501, "Connectors are not implemented in this server.");
});

app.post("/v1/generate/ext", (_req, res) => {
  fail(res, 501, "Extension generation is not implemented in this server.");
});

app.post("/v1/feedback", (req, res) => {
  log("feedback", JSON.stringify(req.body).slice(0, 200));
  res.json({ ok: true });
});

app.post("/v1/telemetry", (_req, res) => {
  res.json({ ok: true });
});

// ---------------------------------------------------------------- boot

app.listen(PORT, "0.0.0.0", () => {
  log(`panda-proxy listening on :${PORT}`);
  log(`provider=${LLM_BASE_URL} model=${LLM_MODEL} configured=${configured()}`);
  if (!configured()) {
    log("WARNING: no LLM_API_KEY — /v1/chat will return 503 until one is set.");
  }
});
