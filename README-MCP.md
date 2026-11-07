# VacuumTube MCP control server (fork addition)

This fork adds an optional **MCP (Model Context Protocol) server** to
VacuumTube so an AI agent can control playback directly — "play this video",
"what's playing?", "pause" — instead of simulating remote-control button
presses. Everything else is upstream VacuumTube, unchanged.

The implementation lives in `src/mcp/server.js` and is wired into
`src/index.js` with a few lines after window creation, so upstream merges
stay easy.

## Behavior

- **Transport:** MCP Streamable HTTP, stateless, JSON responses.
- **Endpoint:** `http://127.0.0.1:8977/mcp` — binds to **localhost only**.
  Reach it from the same machine, or through a trusted tunnel/bridge. Do not
  port-forward it.
- **Port override:** `VACUUMTUBE_MCP_PORT` env var.
- **Disabled by default:** if no tokens are configured, the server never
  starts and the app behaves exactly like upstream.

## Auth — one token per agent

Every request needs `Authorization: Bearer <token>`. Multiple tokens are
supported so each agent/client gets its **own** token (issue and revoke
independently).

Configure tokens either way:

1. Env var (comma-separated):
   ```sh
   VACUUMTUBE_MCP_TOKENS="token-for-agent-a,token-for-agent-b"
   ```
2. A file named `mcp-tokens.json` in the app's **userData** directory
   (Flatpak: `~/.var/app/rocks.shy.VacuumTube/config/VacuumTube/`):
   ```json
   { "tokens": ["token-for-agent-a", "token-for-agent-b"] }
   ```

**Adding a second agent later:** generate a random token
(`openssl rand -hex 24`), append it to the token list, restart the app. No
code changes. To revoke an agent, remove its token and restart.

## Tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `play_video` | `video`: video ID or YouTube URL | Navigates the window to that video in the Leanback UI and plays it |
| `get_state` | — | Current URL, page title, and video state (`paused`, `currentTime`, `duration`, `volume`, …) |
| `play` | — | Resumes playback |
| `pause` | — | Pauses playback |
| `seek` | `seconds`: number | Seeks to an absolute position |
| `set_volume` | `volume`: 0–100 | Sets playback volume |
| `navigate_home` | — | Back to the YouTube TV home screen |

## Client configuration (example)

Any MCP client that supports Streamable HTTP + bearer auth can use it, e.g.:

```json
{
  "mcpServers": {
    "vacuumtube": {
      "url": "http://127.0.0.1:8977/mcp",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}
```

## Quick smoke test

```sh
curl -s http://127.0.0.1:8977/mcp \
  -H "Authorization: Bearer <your-token>" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
