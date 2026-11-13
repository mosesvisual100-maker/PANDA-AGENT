/**
 * End-to-end contract test.
 *
 * Starts the mock provider, starts the proxy against it, then exercises every endpoint the app
 * calls and asserts the shapes `PandaApi.kt` and `TurnParser.kt` actually require. This is the
 * test that would have caught the `{"action":…}` envelope mistake.
 */
const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MOCK_PORT = 4999;
const PROXY_PORT = 4555;

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

/**
 * Mirrors TurnParser.parse from the app: tries to extract a tool call from the assistant text.
 * If this returns null for a chat reply, the agent would stall.
 */
function parseTurn(raw) {
  const text = (raw || "").trim();
  if (!text) return { prose: "", calls: [] };
  const startIdx = text.split("").findIndex((c) => c === "{" || c === "[");
  if (startIdx < 0) return { prose: text, calls: [] };

  let json = text.slice(startIdx);
  // balanced bracket extraction
  const open = json[0];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let end = -1;
  for (let i = 0; i < json.length; i++) {
    if (json[i] === open) depth++;
    else if (json[i] === close) {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return { prose: text, calls: [] };
  json = json.slice(0, end);

  let o;
  try {
    o = JSON.parse(json);
  } catch {
    return { prose: text, calls: [] };
  }

  // ToolCall.fromJson needs "name"; it will not accept "action".
  const fromJson = (x) => {
    if (!x || typeof x !== "object") return null;
    const name = x.name;
    if (!name) return null;
    return { name, args: x.arguments || x.args || {} };
  };

  const calls = [];
  if (Array.isArray(o)) {
    o.forEach((x) => {
      const c = fromJson(x);
      if (c) calls.push(c);
    });
  } else if ("tool_calls" in o) {
    (o.tool_calls || []).forEach((x) => {
      const c = fromJson(x);
      if (c) calls.push(c);
    });
  } else {
    const c = fromJson(o);
    if (c) calls.push(c);
  }
  return { prose: text.slice(0, startIdx).trim(), calls };
}

async function main() {
  console.log("\nPanda proxy contract test\n" + "=".repeat(46));

  const mock = spawn(process.execPath, [path.join(__dirname, "mock-provider.js")], {
    env: { ...process.env, MOCK_PORT },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let mockErr = "";
  mock.stderr.on("data", (d) => (mockErr += d.toString()));

  const proxy = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      PORT: PROXY_PORT,
      LLM_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v1`,
      LLM_API_KEY: "test-key",
      LLM_MODEL: "mock-1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let proxyLog = "";
  proxy.stdout.on("data", (d) => (proxyLog += d.toString()));
  proxy.stderr.on("data", (d) => (proxyLog += d.toString()));

  const base = `http://127.0.0.1:${PROXY_PORT}`;
  const ok = (await waitFor(`${base}/health`)) && (await waitFor(`http://127.0.0.1:${MOCK_PORT}/v1/models`));
  if (!ok) {
    console.log("servers did not start\nproxy:", proxyLog, "\nmock:", mockErr);
    mock.kill();
    proxy.kill();
    process.exit(1);
  }

  try {
    // 1. health
    const health = await (await fetch(`${base}/health`)).json();
    check("health ok", health.ok === true);
    check("health reports configured", health.configured === true);

    // 2. chat -> the envelope the agent can actually parse
    const chatRes = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "system", content: "You are Panda. <available_tools>[...]</available_tools>" }],
        max_tokens: 100,
      }),
    });
    const chat = await chatRes.json();
    check("chat 200", chatRes.status === 200, `got ${chatRes.status}`);
    check("chat has content field", typeof chat.content === "string" && chat.content.length > 0);

    const turn = parseTurn(chat.content);
    check("TurnParser finds a tool call", turn.calls.length === 1, JSON.stringify(chat.content));
    check("tool name is write_todo", turn.calls[0] && turn.calls[0].name === "write_todo",
      JSON.stringify(turn.calls));

    // 3. the envelope must NOT be the {"action":…} shape
    check(
      "envelope uses name, not action",
      !chat.content.includes('"action"'),
      chat.content.slice(0, 80)
    );

    // 4. second step -> done
    const chat2 = await (
      await fetch(`${base}/v1/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "again" }] }),
      })
    ).json();
    const turn2 = parseTurn(chat2.content);
    check("second step parses to done", turn2.calls.length === 1 && turn2.calls[0].name === "done",
      JSON.stringify(chat2.content));

    // 5. proxy must not forward native tools
    const chat3 = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "x", parameters: {} } }],
      }),
    });
    check("chat accepts a tools field without error", chat3.status === 200);

    // 6. models
    const models = await (await fetch(`${base}/v1/models`)).json();
    check("models returns data array", Array.isArray(models.data) && models.data.length > 0);

    // 7. stt rejects non-WAV clearly
    const sttBad = await fetch(`${base}/v1/stt`, {
      method: "POST",
      headers: { "Content-Type": "audio/wav" },
      body: Buffer.from("not a wav file at all, just text padding to exceed minimum size".repeat(3)),
    });
    check("stt rejects non-RIFF with 400", sttBad.status === 400, `got ${sttBad.status}`);

    // 8. connectors/run must be honest, not fake-success
    const conn = await fetch(`${base}/v1/connectors/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    check("connectors/run returns 501 not fake success", conn.status === 501, `got ${conn.status}`);

    // 9. me
    const me = await (await fetch(`${base}/v1/me`)).json();
    check("me returns an id", typeof me.id === "string" && me.id.length > 0);

    // 10. empty messages rejected
    const bad = await fetch(`${base}/v1/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [] }),
    });
    check("empty messages rejected with 400", bad.status === 400, `got ${bad.status}`);

    if (mockErr.includes("FAIL")) check("proxy did not forward native tools", false, mockErr);
    else check("proxy did not forward native tools", true);
  } finally {
    mock.kill();
    proxy.kill();
  }

  console.log("=".repeat(46));
  console.log(`  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("test crashed:", e);
  process.exit(1);
});
