# AGENTS.md — agy-proxy

## Project Overview

OpenAI-compatible HTTP proxy for the Google Antigravity CLI (`agy`). Instead of reverse-engineering Antigravity's API, each incoming request spawns a fresh `agy --print` process, feeds it the conversation via stdin, and returns the output. This means auth, headers, and RPC calls are always identical to the real CLI.

**Single-file architecture**: `server.mjs` (~625 lines, zero dependencies) + `models.json` for model definitions. No build step, no transpilation, no framework.

## Commands

```bash
npm start          # Start the proxy (node server.mjs)
npm run health     # Quick health check via HTTP
bash health.sh     # Full health check (process, HTTP, models, agy binary)
```

No test suite, no linter, no build. The project uses plain Node.js with no dependencies.

## Architecture

```
HTTP request (OpenAI format)
  → server.mjs (Node.js, no framework, raw `createServer`)
    → messagesToPrompt() converts messages array to plain text prompt
    → spawnAgy() spawns `agy --model X --print` with prompt on stdin
    → stdout → OpenAI-compatible response (JSON or SSE stream)
```

**Key data flow**:
- `models.json` defines available models and aliases → loaded into `MODEL_MAP` at startup
- Incoming model ID is resolved through `MODEL_MAP` to the `agyName` used by the CLI
- Messages are converted to a `System:/User:/Assistant:` text prompt format (not JSON)
- Tool/function messages are silently dropped (not supported by the CLI)
- Each request gets a fresh `agy` process (no session reuse)

**Process lifecycle**: `spawnAgy()` → tracks in `activeProcesses` Set → cleanup on exit/error → SIGTERM/SIGINT kills all active child processes.

## Code Conventions

- **ES Modules** (`"type": "module"` in package.json, `.mjs` extension)
- **No dependencies** — only `node:*` builtins (`http`, `child_process`, `crypto`, `fs`, `path`, `os`)
- **No framework** — raw `http.createServer` with manual URL routing in a `switch` statement
- **Functions over classes** — all logic is top-level functions, no OOP
- **Env vars for config** — all configuration via environment variables with defaults, no config files
- **Error sanitization** — `sanitizeError()` strips control chars and truncates to 500 chars before sending to clients

## Configuration (Environment Variables)

| Variable | Default | Notes |
|----------|---------|-------|
| `AGY_PROXY_PORT` | 3457 | Listen port |
| `AGY_BIN` | auto-detect via PATH | Must be executable |
| `AGY_TIMEOUT` | 600000 | Per-request timeout in ms |
| `AGY_SKIP_PERMISSIONS` | false | Adds `--dangerously-skip-permissions` flag |
| `AGY_MODEL` | gemini-3.5-flash-medium | Fallback model |
| `AGY_HEARTBEAT_MS` | 0 | SSE heartbeat (disabled by default) |
| `AGY_PRINT_TIMEOUT` | 10m | Format: `\d+[smh]` — validated at startup |
| `PROXY_API_KEY` | none | Bearer token for API auth |

## Gotchas

- **No `models.schema.json`** exists, and `models.json` no longer references one. Model IDs/aliases are validated in code at startup. Don't create a schema file unless asked.
- **Streaming is faked**: `agy --print` outputs all text at once. The proxy sends SSE chunks as they arrive from stdout, so clients see bursts rather than true token-by-token streaming. Output is decoded with a `StringDecoder` so multibyte UTF-8 is never split across chunks.
- **Streaming errors surface to the client**: a non-zero `agy` exit emits an SSE `error` event (with sanitized stderr) before `[DONE]`, not a clean `finish_reason: "stop"`.
- **Client disconnect kills the child**: `res.on("close")` SIGTERMs the `agy` process so an aborted request doesn't keep running to the timeout.
- **`AGY_HEARTBEAT_MS > 0`** sends `: keepalive\n\n` SSE comments on an interval to keep idle connections alive through proxies/LBs.
- **`/health` and `/v1/health` are auth-exempt** (served before `checkAuth`) so monitoring works even with `PROXY_API_KEY` set.
- **Usage stats are placeholders**: `prompt_tokens`, `completion_tokens`, `total_tokens` are always `-1` — agy doesn't expose token counts.
- **`AGY_PRINT_TIMEOUT` format** is validated at startup with a regex (`/^\d+[smh]$/`). Invalid values cause `process.exit(1)`.
- **Model lookup is strict**: an unknown model ID returns `400` with a message pointing to `/v1/models`. `DEFAULT_MODEL` is only used when the request omits `model` entirely.
- **Env var cleanup in child processes**: `spawnAgy()` deletes proxy-related env vars from the child to prevent loops.
- **SIGTERM/SIGINT** handler kills all active child processes with SIGKILL, then closes the HTTP server.
- **Port binding**: server binds to `127.0.0.1` only — not `0.0.0.0`. Not accessible from other machines.
- **Deployment paths are hardcoded** in `docs/` — they assume `~/.agy-proxy/` as install location.

## Model Configuration

Edit `models.json` to add/remove models. Each entry needs:
- `id` — the API-facing ID (what clients send)
- `agyName` — the exact string `agy --model` expects
- `contextWindow`, `maxTokens` — metadata (not enforced by proxy)

Aliases map shorthand names to full model IDs (e.g., `gemini-3.5-flash` → `gemini-3.5-flash-medium`).
