#!/usr/bin/env node
/**
 * agy-proxy — OpenAI-compatible proxy for Google Antigravity CLI (agy)
 *
 * Translates OpenAI chat/completions requests into `agy --print` CLI calls,
 * letting you use your Google Antigravity subscription as an OpenAI-compatible
 * provider. All network traffic is handled by the real agy binary — identical
 * headers, auth, and RPC calls as the official CLI. No protocol reverse-
 * engineering means no API-drift risk.
 *
 * Env vars:
 *   AGY_PROXY_PORT       — listen port (default: 3457)
 *   AGY_BIN              — path to agy binary (default: auto-detect via PATH)
 *   AGY_TIMEOUT          — per-request timeout in ms (default: 600000 = 10min)
 *   AGY_SKIP_PERMISSIONS — "true" to skip permission prompts (default: false)
 *   AGY_MODEL            — default model if none specified (default: gemini-3.5-flash-medium)
 *   AGY_HEARTBEAT_MS     — SSE heartbeat interval (default: 0 = disabled)
 *   AGY_PRINT_TIMEOUT    — value for --print-timeout flag (default: 10m)
 *   PROXY_API_KEY        — Bearer token for API auth (optional)
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, delimiter as pathDelimiter } from "node:path";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ───────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.AGY_PROXY_PORT || "3457", 10);
const TIMEOUT = parseInt(process.env.AGY_TIMEOUT || "600000", 10); // 10min
const SKIP_PERMISSIONS = process.env.AGY_SKIP_PERMISSIONS === "true";
const HEARTBEAT_MS = parseInt(process.env.AGY_HEARTBEAT_MS || "0", 10);
const PRINT_TIMEOUT = process.env.AGY_PRINT_TIMEOUT || "10m";
const API_KEY = process.env.PROXY_API_KEY || null;
const DEFAULT_MODEL = process.env.AGY_MODEL || "gemini-3.5-flash-medium";
const MAX_BODY_SIZE = 1024 * 1024; // 1MB

// Validate PRINT_TIMEOUT format
if (!/^\d+[smh]$/.test(PRINT_TIMEOUT)) {
  console.error(`Invalid AGY_PRINT_TIMEOUT: ${PRINT_TIMEOUT}. Use format like "10m", "1h", "30s"`);
  process.exit(1);
}

// Resolve agy binary
const AGY = resolveAgy();
let modelsConfig;
try {
  modelsConfig = JSON.parse(readFileSync(join(__dirname, "models.json"), "utf8"));
} catch (err) {
  console.error(`FATAL: Failed to load models.json: ${sanitizeError(err.message)}`);
  process.exit(1);
}

// Build model map: API ID → agy model name
const MODEL_MAP = {};
for (const m of modelsConfig.models) {
  MODEL_MAP[m.id] = m.agyName;
}
// Add aliases
for (const [alias, target] of Object.entries(modelsConfig.aliases || {})) {
  if (MODEL_MAP[target]) {
    MODEL_MAP[alias] = MODEL_MAP[target];
  }
}

// ── Stats ────────────────────────────────────────────────────────────────
const stats = {
  totalRequests: 0,
  activeRequests: 0,
  errors: 0,
  timeouts: 0,
  started: new Date().toISOString(),
};

// ── Resolve agy binary ───────────────────────────────────────────────────
function resolveAgy() {
  if (process.env.AGY_BIN) {
    try {
      accessSync(process.env.AGY_BIN, constants.X_OK);
      return process.env.AGY_BIN;
    } catch {
      console.error(`FATAL: AGY_BIN="${process.env.AGY_BIN}" is set but not executable.`);
      process.exit(1);
    }
  }

  // Search PATH
  const pathDirs = (process.env.PATH || "").split(pathDelimiter);
  for (const dir of pathDirs) {
    const candidate = join(dir, "agy");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not found */ }
  }

  // Check common locations
  const home = process.env.HOME || homedir();
  const common = [
    join(home, ".local/bin/agy"),
    "/usr/local/bin/agy",
    "/usr/bin/agy",
  ];
  for (const candidate of common) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not found */ }
  }

  console.error("FATAL: agy binary not found. Install it or set AGY_BIN.");
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function sanitizeError(msg) {
  return String(msg || "unknown error").replace(/[\x00-\x1f]/g, "").slice(0, 500);
}

function jsonResponse(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function sendSSE(res, data) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ── Auth (optional) ──────────────────────────────────────────────────────
function checkAuth(req) {
  if (!API_KEY) return true;
  const header = req.headers["authorization"] || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const provided = Buffer.from(match[1]);
  const expected = Buffer.from(API_KEY);
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(provided, expected);
  } catch {
    return false;
  }
}

// ── Message to prompt conversion ─────────────────────────────────────────
function extractSystemPrompt(messages) {
  return messages
    .filter(m => m.role === "system")
    .map(m => m.content)
    .filter(Boolean)
    .join("\n");
}

// NOTE: messages are flattened into a plain "System:/User:/Assistant:" text
// prompt, so a message body containing those role markers can forge turns.
// Acceptable for a localhost, single-user proxy; revisit if ever exposed.
function messagesToPrompt(messages) {
  const parts = [];
  const systemContent = extractSystemPrompt(messages);
  if (systemContent) {
    parts.push(`System: ${systemContent}`);
  }

  // Skip tool/function messages — they're for OpenAI tool calling, not plain text prompts
  const nonSystem = messages.filter(m => m.role !== "system" && m.role !== "tool" && m.role !== "function");
  for (const msg of nonSystem) {
    const role = msg.role === "user" ? "User" : "Assistant";
    const content = extractTextContent(msg);
    if (content) {
      parts.push(`${role}: ${content}`);
    }
  }

  // End with a User prompt if the last message is from the user
  if (nonSystem.length > 0 && nonSystem[nonSystem.length - 1].role === "user") {
    parts.push("Assistant:");
  }

  return parts.join("\n\n");
}

function extractTextContent(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(p => p.type === "text")
      .map(p => p.text)
      .join("\n");
  }
  return "";
}

// ── Spawn agy process ────────────────────────────────────────────────────
function spawnAgy(model, prompt) {
  const agyModel = MODEL_MAP[model] || model;

  const cliArgs = [
    "--model", agyModel,
    "--print",
    "--print-timeout", PRINT_TIMEOUT,
  ];

  if (SKIP_PERMISSIONS) {
    cliArgs.push("--dangerously-skip-permissions");
  }

  stats.activeRequests++;

  // Clean environment — strip anything that could interfere
  const env = { ...process.env };
  // Don't pass any proxy-related env vars that could loop
  delete env.AGY_PROXY_PORT;
  delete env.AGY_TIMEOUT;
  delete env.AGY_BIN;
  delete env.AGY_HEARTBEAT_MS;
  delete env.AGY_SKIP_PERMISSIONS;
  delete env.AGY_MODEL;
  delete env.AGY_PRINT_TIMEOUT;
  delete env.PROXY_API_KEY;

  const proc = spawn(AGY, cliArgs, {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  activeProcesses.add(proc);

  let cleaned = false;
  let overallTimer;

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(overallTimer);
    stats.activeRequests--;
  }

  proc.once("exit", cleanup);
  proc.once("error", cleanup);

  // Write prompt to stdin
  proc.stdin.write(prompt);
  proc.stdin.end();

  // Overall timeout
  overallTimer = setTimeout(() => {
    if (!cleaned) {
      stats.timeouts++;
      try { proc.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch {}
      }, 5000);
    }
  }, TIMEOUT);

  return { proc, cleanup, clearOverallTimer: () => clearTimeout(overallTimer) };
}

// ── Non-streaming handler ────────────────────────────────────────────────
function callAgy(model, messages) {
  return new Promise((resolve, reject) => {
    let ctx;
    try {
      ctx = spawnAgy(model, messagesToPrompt(messages));
    } catch (err) {
      return reject(err);
    }

    const { proc, cleanup, clearOverallTimer } = ctx;
    // Decoders buffer partial multibyte UTF-8 sequences across chunk boundaries
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      stdout += outDecoder.write(d);
    });

    proc.stderr.on("data", (d) => {
      stderr += errDecoder.write(d);
    });

    proc.on("close", (code, signal) => {
      activeProcesses.delete(proc);
      stdout += outDecoder.end();
      stderr += errDecoder.end();
      clearOverallTimer();
      cleanup();

      if (code !== 0) {
        stats.errors++;
        const reason = signal ? `agy killed by ${signal}` : `agy exit ${code}`;
        const errMsg = stderr.trim() || reason;
        console.error(`${reason}: ${sanitizeError(errMsg)}`);
        reject(new Error(sanitizeError(errMsg)));
      } else {
        resolve(stdout);
      }
    });

    proc.on("error", (err) => {
      cleanup();
      stats.errors++;
      reject(err);
    });
  });
}

// ── Active process tracking ──────────────────────────────────────────────
const activeProcesses = new Set();

// ── Streaming handler ────────────────────────────────────────────────────
function callAgyStreaming(model, messages, res) {
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);

  let ctx;
  try {
    ctx = spawnAgy(model, messagesToPrompt(messages));
  } catch (err) {
    return jsonResponse(res, 500, { error: { message: sanitizeError(err.message), type: "proxy_error" } });
  }

  const { proc, cleanup, clearOverallTimer } = ctx;
  // Decoder buffers partial multibyte UTF-8 sequences across chunk boundaries
  const outDecoder = new StringDecoder("utf8");
  let stderr = "";
  let headersSent = false;
  let hasError = false;
  let heartbeat = null;

  function stopHeartbeat() {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function ensureHeaders() {
    if (res.writableEnded || res.destroyed) return false;
    if (headersSent) return true;
    headersSent = true;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });
    // Initial role chunk
    sendSSE(res, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    });
    return true;
  }

  function sendContent(text) {
    if (!text || res.writableEnded || res.destroyed) return;
    sendSSE(res, {
      id, object: "chat.completion.chunk", created, model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
    });
  }

  // Send headers upfront before any data
  ensureHeaders();

  // Optional heartbeat — keeps idle SSE connections alive through proxies/LBs
  // while agy buffers output (it emits everything at once on completion).
  if (HEARTBEAT_MS > 0) {
    heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      res.write(": keepalive\n\n");
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
  }

  proc.stdout.on("data", (d) => {
    sendContent(outDecoder.write(d));
  });

  proc.stderr.on("data", (d) => {
    stderr += d.toString();
  });

  proc.on("close", (code, signal) => {
    activeProcesses.delete(proc);
    clearOverallTimer();
    stopHeartbeat();
    cleanup();

    // Flush any buffered multibyte remainder
    sendContent(outDecoder.end());

    if (code !== 0 && !hasError) {
      hasError = true;
      stats.errors++;
      const reason = signal ? `agy killed by ${signal}` : `agy exit ${code}`;
      const errMsg = stderr.trim() || reason;
      console.error(`Streaming ${reason}: ${sanitizeError(errMsg)}`);
      // Surface the failure to the client instead of a clean stop
      if (ensureHeaders() && !res.writableEnded && !res.destroyed) {
        sendSSE(res, { error: { message: sanitizeError(errMsg), type: "proxy_error" } });
      }
    } else if (ensureHeaders()) {
      sendSSE(res, {
        id, object: "chat.completion.chunk", created, model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      });
    }

    if (!res.writableEnded && !res.destroyed) {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });

  proc.on("error", (err) => {
    hasError = true;
    stopHeartbeat();
    cleanup();
    stats.errors++;
    console.error(`Streaming error: ${sanitizeError(err.message)}`);
    if (!headersSent) {
      jsonResponse(res, 500, { error: { message: sanitizeError(err.message), type: "proxy_error" } });
    } else if (!res.writableEnded && !res.destroyed) {
      sendSSE(res, {
        error: { message: sanitizeError(err.message), type: "proxy_error" },
      });
      res.end();
    }
  });

  // If the client disconnects mid-stream, kill the child so we don't burn
  // quota and a process slot running to completion for nobody.
  res.on("close", () => {
    stopHeartbeat();
    if (!proc.killed && proc.exitCode === null) {
      try { proc.kill("SIGTERM"); } catch {}
    }
  });
}

// ── Request handlers ─────────────────────────────────────────────────────

function handleModels(req, res) {
  const list = modelsConfig.models.map(m => ({
    id: m.id,
    object: "model",
    created: Math.floor(Date.now() / 1000),
    owned_by: "antigravity",
    permission: [],
    root: m.id,
  }));
  jsonResponse(res, 200, { object: "list", data: list });
}

function handleChatCompletions(req, res) {
  const chunks = [];
  let size = 0;
  let aborted = false;

  req.on("data", (d) => {
    if (aborted) return;
    size += d.length; // byte length of the Buffer chunk
    if (size > MAX_BODY_SIZE) {
      aborted = true;
      jsonResponse(res, 413, { error: { message: "Request too large", type: "invalid_request_error" } });
      req.destroy();
      return;
    }
    chunks.push(d);
  });

  req.on("error", () => {
    if (aborted) return;
    aborted = true;
    if (!res.writableEnded && !res.destroyed) {
      jsonResponse(res, 400, { error: { message: "Request stream error", type: "invalid_request_error" } });
    }
  });

  req.on("end", async () => {
    if (aborted) return;
    let parsed;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return jsonResponse(res, 400, { error: { message: "Invalid JSON body", type: "invalid_request_error" } });
    }

    const { messages, stream, model: reqModel } = parsed;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return jsonResponse(res, 400, { error: { message: "messages is required and must be a non-empty array", type: "invalid_request_error" } });
    }

    const model = reqModel || DEFAULT_MODEL;
    if (!MODEL_MAP[model]) {
      return jsonResponse(res, 400, {
        error: { message: `Unknown model: "${model}". Use /v1/models to list available models.`, type: "invalid_request_error" },
      });
    }
    const effectiveModel = model;

    stats.totalRequests++;

    if (stream) {
      callAgyStreaming(effectiveModel, messages, res);
    } else {
      try {
        const text = await callAgy(effectiveModel, messages);
        const id = `chatcmpl-${randomUUID()}`;
        const created = Math.floor(Date.now() / 1000);
        jsonResponse(res, 200, {
          id,
          object: "chat.completion",
          created,
          model: effectiveModel,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: text,
            },
            finish_reason: "stop",
          }],
          usage: {
            prompt_tokens: -1,
            completion_tokens: -1,
            total_tokens: -1,
          },
        });
      } catch (err) {
        console.error(`Completion error: ${sanitizeError(err.message)}`);
        jsonResponse(res, 500, { error: { message: sanitizeError(err.message), type: "proxy_error" } });
      }
    }
  });
}

function handleHealth(req, res) {
  jsonResponse(res, 200, {
    status: "ok",
    agy: AGY,
    uptime: Math.floor((Date.now() - new Date(stats.started).getTime()) / 1000),
    stats: {
      totalRequests: stats.totalRequests,
      activeRequests: stats.activeRequests,
      errors: stats.errors,
      timeouts: stats.timeouts,
    },
    models: modelsConfig.models.length,
  });
}

// ── HTTP server ──────────────────────────────────────────────────────────
const server = createServer((req, res) => {
  // CORS headers for all responses
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health checks are exempt from auth so monitoring works with PROXY_API_KEY set
  if (url.pathname === "/health" || url.pathname === "/v1/health") {
    return handleHealth(req, res);
  }

  if (!checkAuth(req)) {
    return jsonResponse(res, 401, {
      error: { message: "Unauthorized. Set PROXY_API_KEY or omit for no auth.", type: "auth_error" },
    });
  }

  switch (url.pathname) {
    case "/v1/models":
      return handleModels(req, res);
    case "/v1/chat/completions":
      return handleChatCompletions(req, res);
    default:
      jsonResponse(res, 404, {
        error: { message: `Not found: ${url.pathname}`, type: "not_found" },
      });
  }
});

function shutdown() {
  for (const proc of activeProcesses) {
    try { proc.kill("SIGKILL"); } catch {}
  }
  server.close(() => process.exit(0));
  // Force-exit if lingering connections (e.g. open SSE streams) keep the
  // server from closing cleanly.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`agy-proxy v${JSON.parse(readFileSync(join(__dirname, "package.json"), "utf8")).version}`);
  console.log(`  Binary:  ${AGY}`);
  console.log(`  Listen:  http://127.0.0.1:${PORT}`);
  console.log(`  Models:  ${modelsConfig.models.map(m => m.id).join(", ")}`);
  console.log(`  Timeout: ${TIMEOUT}ms`);
  console.log(`  Auth:    ${API_KEY ? "enabled" : "disabled"}`);
});
