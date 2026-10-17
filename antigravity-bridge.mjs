import http from "node:http";
import { spawn } from "node:child_process";

const PORT = 18888;
const HOST = "127.0.0.1";
const MAX_PROMPT_CHARS = 65000; // Well within Linux MAX_ARG_STRLEN (131072 bytes)
const MAX_SYSTEM_CHARS = 20000;

function runAntigravity(prompt) {
  return new Promise((resolve, reject) => {
    const agy = spawn("agy", ["--output-format", "json", "-p", prompt], {
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    agy.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    agy.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    agy.on("error", (err) => {
      console.error("[Bridge] spawn error:", err);
      reject(err);
    });

    agy.on("close", (code) => {
      if (code !== 0) {
        console.error(`[Bridge] agy exited with code ${code}: ${stderr}`);
        return reject(new Error(stderr || `agy exited with code ${code}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.response || "");
      } catch (err) {
        resolve(stdout || "");
      }
    });
  });
}

function buildPrompt(messages) {
  let systemText = "";
  const conversationMessages = [];

  for (const msg of messages) {
    const role = msg.role;
    let content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    if (!content) continue;

    if (role === "system") {
      if (systemText) systemText += "\n";
      systemText += content;
    } else {
      conversationMessages.push({ role, content });
    }
  }

  // Truncate system text if unusually large
  if (systemText.length > MAX_SYSTEM_CHARS) {
    systemText = systemText.slice(-MAX_SYSTEM_CHARS);
  }

  let formattedSystem = systemText ? `[System Instruction: ${systemText}]\n\n` : "";
  const remainingBudget = Math.max(10000, MAX_PROMPT_CHARS - formattedSystem.length - 100);

  // Take recent messages from newest to oldest within remainingBudget
  const selected = [];
  let currentLen = 0;

  for (let i = conversationMessages.length - 1; i >= 0; i--) {
    const msg = conversationMessages[i];
    const prefix = msg.role === "user" ? "User: " : msg.role === "assistant" ? "Assistant: " : `${msg.role}: `;
    const line = `${prefix}${msg.content}\n`;
    if (currentLen + line.length > remainingBudget && selected.length > 0) {
      break;
    }
    selected.unshift(line);
    currentLen += line.length;
  }

  return `${formattedSystem}${selected.join("")}\nRespond as the Assistant directly and concisely:`;
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(200);
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || HOST}`);

  if (url.pathname === "/" || url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", provider: "antigravity" }));
  }

  if (url.pathname === "/v1/models" || url.pathname === "/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        object: "list",
        data: [
          {
            id: "antigravity",
            object: "model",
            created: Math.floor(Date.now() / 1000),
            owned_by: "antigravity",
          },
        ],
      })
    );
  }

  if (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions") {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Method Not Allowed" }));
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", async () => {
      try {
        const payload = JSON.parse(body || "{}");
        const messages = payload.messages || [];
        const isStreaming = Boolean(payload.stream);
        const reqModel = payload.model || "antigravity";

        const promptText = buildPrompt(messages);
        console.log(`[Bridge] Processing request (prompt length: ${promptText.length} chars, streaming=${isStreaming})`);

        let answer = "";
        try {
          answer = await runAntigravity(promptText);
        } catch (execErr) {
          console.error("[Bridge] Execution failed:", execErr);
          answer = "Maafi chahta hoon, request process karne me thodi technical dikkat aayi. Kripya apna sawal dobara bhejein.";
        }

        if (isStreaming) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          });

          const chunkId = `chatcmpl-${Date.now()}`;
          const timestamp = Math.floor(Date.now() / 1000);

          const dataChunk = {
            id: chunkId,
            object: "chat.completion.chunk",
            created: timestamp,
            model: reqModel,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content: answer },
                finish_reason: null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(dataChunk)}\n\n`);

          const doneChunk = {
            id: chunkId,
            object: "chat.completion.chunk",
            created: timestamp,
            model: reqModel,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          };
          res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
          res.write("data: [DONE]\n\n");
          return res.end();
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(
            JSON.stringify({
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion",
              created: Math.floor(Date.now() / 1000),
              model: reqModel,
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content: answer,
                  },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: Math.ceil(promptText.length / 4),
                completion_tokens: Math.ceil(answer.length / 4),
                total_tokens: Math.ceil((promptText.length + answer.length) / 4),
              },
            })
          );
        }
      } catch (err) {
        console.error("[Bridge] Unhandled error:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

server.listen(PORT, HOST, () => {
  console.log(`[Antigravity Bridge] Listening on http://${HOST}:${PORT}`);
});
