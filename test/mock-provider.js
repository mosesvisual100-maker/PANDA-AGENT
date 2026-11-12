/**
 * Mock OpenAI-compatible provider.
 *
 * Exists so the proxy can be tested end-to-end *before* any real API key is involved, and so the
 * test proves the wire contract rather than a live model's behaviour. It replays a fixed script:
 * step 1 returns a tool call in the app's envelope, step 2 returns done.
 */
const http = require("http");

const PORT = process.env.MOCK_PORT || 4999;

let step = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const send = (obj, code = 200) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (req.url === "/v1/chat/completions") {
      const parsed = JSON.parse(body || "{}");
      const msgs = parsed.messages || [];

      // Verify the proxy did not forward native tools (the app does not send them).
      if (parsed.tools) {
        console.error("FAIL: proxy forwarded native tools");
      }
      if (!Array.isArray(msgs) || msgs.length === 0) {
        return send({ error: "no messages" }, 400);
      }

      step++;

      // First call -> a tap action in the app's envelope. Second -> done.
      const content =
        step === 1
          ? JSON.stringify({
              tool_calls: [{ name: "write_todo", arguments: { items: [] } }],
            })
          : JSON.stringify({ tool_calls: [{ name: "done", arguments: { summary: "ok" } }] });

      return send({
        id: `mock-${step}`,
        model: "mock-1",
        choices: [{ message: { role: "assistant", content } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    }

    if (req.url === "/v1/models") {
      return send({ data: [{ id: "mock-1" }] });
    }

    send({ error: "not found" }, 404);
  });
});

server.listen(PORT, () => console.log(`mock provider on :${PORT}`));
