# Hosting the Panda backend on Render

The app needs a server. This folder is that server.

## What it does

Implements exactly the endpoints `PandaApi.kt` calls, so the rebuilt app works once it points here.

| Endpoint | Purpose |
|---|---|
| `POST /v1/chat` | One agent step |
| `GET /v1/models` | Model list |
| `POST /v1/tts` | Text to speech |
| `POST /v1/stt` | Speech to text |
| `GET /v1/me` | Identity |
| `GET /health` | Render health check |

## The one thing that matters

The app does **not** use native OpenAI tool-calling. `PromptBuilder` writes the tool catalogue
into the *system prompt text*, and `TurnParser` reads back a **text** envelope:

```
{"tool_calls":[{"name":"tap","arguments":{...}}]}
```

or the single-call form:

```
{"name":"tap","arguments":{...}}
```

If a model returns native `tool_calls`, the agent sees an empty step and **stalls forever**. The
proxy handles this: it forwards a plain chat completion, and if the upstream still emits native
tool calls it converts them into the envelope above.

`test/e2e.js` asserts this. Run it after any change:

```bash
cd panda-backend
npm install
node test/e2e.js     # 15 assertions, no API key needed
```

## Deploy

### 1. Push this folder to GitHub

```bash
cd panda-backend
git init && git add . && git commit -m "panda proxy"
git remote add origin https://github.com/YOU/panda-proxy.git
git push -u origin main
```

### 2. Render

1. Go to [dashboard.render.com](https://dashboard.render.com) → **New** → **Web Service**
2. Connect the repo
3. Render reads `render.yaml`, or set manually:
   - **Runtime** Node
   - **Build** `npm install`
   - **Start** `npm start`
   - **Plan** Free
4. **Environment** → add:

| Key | Value |
|---|---|
| `LLM_API_KEY` | your key |
| `LLM_BASE_URL` | `https://api.openai.com/v1` |
| `LLM_MODEL` | `gpt-4o-mini` |

5. Deploy. You get `https://panda-proxy-xxxx.onrender.com`

### 3. Point the app at it

In the app: **Setup** tab → **Backend URL** field → paste your URL → **Save URL** → **Test**.

"✓ reachable" means it works. "no API key set on the server" means step 4 was skipped.

## Free-tier reality

Render's free tier **sleeps after 15 minutes** of inactivity. The next request takes ~30 seconds
to wake. This is not a bug and not something the code can fix.

Options:
- Accept the cold start (first command of the day is slow)
- Ping `/health` every 10 minutes from a free cron service (cron-job.org, UptimeRobot) to keep it warm
- Upgrade to a paid instance ($7/mo) — but you asked for free, so this is a trade-off, not a requirement

## Free LLM options

The proxy is OpenAI-compatible, so any of these work by changing `LLM_BASE_URL`:

| Provider | Base URL | Notes |
|---|---|---|
| Groq | `https://api.groq.com/openai/v1` | Fast, generous free tier, `llama-3.3-70b-versatile` |
| OpenRouter | `https://openrouter.ai/api/v1` | Has `:free` models |
| Together | `https://api.together.xyz/v1` | Free tier |
| DeepSeek | `https://api.deepseek.com/v1` | Cheap, not free |
| Ollama (local) | `http://localhost:11434/v1` | Fully free, needs your PC on and reachable |

**Groq is the best pick for free + fast.** It is genuinely quick, which matters because the agent
makes many sequential calls per task.

## Limitations, stated plainly

- **Connectors** (`/v1/connectors/run`) return **501**. There are no integrations behind them.
  They are not silently faked — a fake success would make the agent believe an action happened.
- **Extension generation** (`/v1/generate/ext`) returns **501**.
- **TTS/STT** need an OpenAI-compatible audio endpoint. Groq has no TTS; if you use Groq for chat,
  set `LLM_BASE_URL` to Groq and leave speech to the device's own TTS (the app falls back
  automatically when `/v1/tts` fails).
- **No auth.** Anyone with the URL can call it and spend your API key. For personal use that is
  fine; do not publish the URL. Adding a shared-secret header check is a small change if you want it.
