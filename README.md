# agy-proxy

OpenAI-compatible proxy for Google Antigravity CLI (`agy`).

Spawns the real `agy` binary per-request — same auth, same headers, same RPC
calls as the official CLI. No protocol reverse-engineering means zero API-drift
risk (unlike protocol-level reimplementations like antigravity-proxy).

## How it works

```
OpenAI request → agy-proxy → spawns `agy --model X --print` → response
```

Each request spawns a fresh `agy --print` process, feeds it the formatted
conversation via stdin, and returns the output as an OpenAI-compatible response.

## Usage

```bash
# Start
node ~/.agy-proxy/server.mjs

# Test
curl http://127.0.0.1:3457/v1/models
curl http://127.0.0.1:3457/health
```

## Endpoints

| Path | Method | Description |
|------|--------|-------------|
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Generate completion (streaming or non-streaming) |
| `/health` | GET | Health check with stats |

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `AGY_PROXY_PORT` | 3457 | Listen port |
| `AGY_BIN` | auto-detect | Path to agy binary |
| `AGY_TIMEOUT` | 600000 | Request timeout (ms) |
| `AGY_SKIP_PERMISSIONS` | true | Auto-approve permissions |
| `AGY_MODEL` | gemini-3.5-flash-medium | Default model |
| `AGY_HEARTBEAT_MS` | 0 | SSE heartbeat interval |
| `AGY_PRINT_TIMEOUT` | 10m | agy --print-timeout value |
| `PROXY_API_KEY` | none | Bearer token for API auth |

## Models

| API ID | agy name |
|--------|----------|
| `gemini-3.5-flash-medium` | Gemini 3.5 Flash (Medium) |
| `gemini-3.5-flash-high` | Gemini 3.5 Flash (High) |
| `gemini-3.5-flash-low` | Gemini 3.5 Flash (Low) |
| `gemini-3.1-pro-low` | Gemini 3.1 Pro (Low) |
| `gemini-3.1-pro-high` | Gemini 3.1 Pro (High) |
| `claude-sonnet-4-6-thinking` | Claude Sonnet 4.6 (Thinking) |
| `claude-opus-4-6-thinking` | Claude Opus 4.6 (Thinking) |
| `gpt-oss-120b-medium` | GPT-OSS 120B (Medium) |

Aliases: `gemini-3.5-flash` → medium, `gemini-3.1-pro` → high,
`claude-sonnet-4-6` → thinking, `claude-opus-4-6` → thinking

## Credits

Inspired by [OCP](https://github.com/dtzp555-max/ocp) — the Claude CLI proxy.
Same architecture, different CLI.
