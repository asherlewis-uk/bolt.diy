import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8787);
const OLLAMA_BASE = (process.env.OLLAMA_BASE || "http://127.0.0.1:11434/v1").replace(/\/$/, "");
const PRIMARY_MODEL = process.env.PRIMARY_MODEL || "deepseek-v3.1:671b-cloud";
const CHALLENGER_MODEL = process.env.CHALLENGER_MODEL || "qwen3-coder-next:cloud";
const PACKET_PATH = process.env.AUDIT_PACKET_PATH || path.resolve(__dirname, "../../deepseek_qwen_audit_packet.md");

function readPacket() {
  return fs.readFileSync(PACKET_PATH, "utf8");
}

async function ollamaChat(model, messages) {
  const res = await fetch(`${OLLAMA_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer ollama",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      stream: false,
    }),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(`Model call failed (${model}): ${JSON.stringify(data)}`);
  }

  return data.choices?.[0]?.message?.content ?? "";
}

function getLastUserMessage(messages = []) {
  const reversed = [...messages].reverse();
  const user = reversed.find((m) => m.role === "user");
  return user?.content || "Run the full audit packet against this repo and return release blockers first.";
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: true,
        primaryModel: PRIMARY_MODEL,
        challengerModel: CHALLENGER_MODEL,
        packetPath: PACKET_PATH,
      }));
      return;
    }

    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body || "{}");

      const packet = readPacket();
      const userRequest = getLastUserMessage(payload.messages);

      const primaryPrompt = [
        {
          role: "system",
          content: [
            "You are the PRIMARY AUDIT AUTHOR.",
            "Follow the audit packet exactly.",
            "Be exhaustive, concrete, repo-grounded, and adversarial.",
            "Do not skip runtime, state, mobile, deployment, and edge-case failures.",
            "",
            "AUDIT PACKET:",
            packet,
          ].join("\n"),
        },
        {
          role: "user",
          content: userRequest,
        },
      ];

      const primary = await ollamaChat(PRIMARY_MODEL, primaryPrompt);

      const challengerPrompt = [
        {
          role: "system",
          content: [
            "You are the CHALLENGER AUDITOR.",
            "Attack the primary draft.",
            "Find missed edge cases, false greens, hidden trust-boundary bugs, state corruption risks, runtime failures, mobile failures, and release risks.",
            "Be strict and adversarial.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            "USER REQUEST:",
            userRequest,
            "",
            "PRIMARY AUDIT DRAFT:",
            primary,
          ].join("\n"),
        },
      ];

      const challenger = await ollamaChat(CHALLENGER_MODEL, challengerPrompt);

      const synthesisPrompt = [
        {
          role: "system",
          content: [
            "You are the FINAL SYNTHESIZER.",
            "Merge the primary audit and challenger critique into one final audit.",
            "Keep what is correct, fix what is weak, and surface clear release blockers.",
            "Return a final, structured, production-grade audit packet.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            "USER REQUEST:",
            userRequest,
            "",
            "PRIMARY AUDIT:",
            primary,
            "",
            "CHALLENGER AUDIT:",
            challenger,
          ].join("\n"),
        },
      ];

      const synthesis = await ollamaChat(PRIMARY_MODEL, synthesisPrompt);

      const response = {
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "audit-orchestrator",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: synthesis,
            },
            finish_reason: "stop",
          },
        ],
      };

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(response));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  } catch (error) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`audit-orchestrator listening on http://127.0.0.1:${PORT}`);
});
