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
| `play_video` | `video`: video ID or YouTube URL | Navigates the window to that video in the Leanback UI and plays it. **Verifies** the switch before returning (see below) |
| `get_state` | — | Current URL, video state (`paused`, `currentTime`, `duration`, `volume`, …), a short page hint, and the recent watch history |
| `play` | — | Resumes playback |
| `pause` | — | Pauses playback |
| `seek` | `seconds`: number | Seeks to an absolute position |
| `set_volume` | `volume`: 0–100 | Sets playback volume |
| `navigate_home` | — | Back to the YouTube TV home screen |
| `search` | `query`: string | Opens the TV search screen for the query; returns the top results (title + video ID) scraped from the page when possible |
| `back` | `steps`: optional, 1–10 | Returns to a previously watched video (see History) |

## Navigation & verification (why play_video can be trusted)

Changing the Leanback route is not the same as changing the video — the SPA
can update the URL while the old media keeps playing, or create a fresh
player element that never loads. So `play_video` escalates through several
navigation strategies (in-page hash change → pushState + events → home,
settle, then hash → full reload at the watch route) and, after each one,
polls the page until the media element actually shows the target video
(route id matches, real duration present, and — when switching — a
different media source than the video being left). The result reports
`verified: true` and which `strategy` worked, or `verified: false` with the
page state attached so the failure is diagnosable. All page scripts run
under a timeout (`VACUUMTUBE_MCP_JS_TIMEOUT_MS`, default 5000 ms), and the
transport tools never await media `play()` promises, so no tool can hang
on a wedged page.

`get_state` probes **all** `<video>` elements and reports the active one
(largest/loaded/playing), plus a compact page hint: the first ~200
characters of visible page text and any visible dialog's text — enough to
spot interstitials (profile pickers, sign-in prompts) from the tool output.

## History & back()

The server records the videos that were watched — id, title (when the page
exposes one), and when playback started — in `mcp-history.json` in the
app's userData directory (newest last, capped at 50). It covers videos
started via `play_video` **and** videos started by hand with the remote or
by autoplay (a light poller watches for changes). `get_state` includes the
last 10 entries, so "the Asmongold video from 20 minutes ago" can be
resolved by timestamp. `back()` pops the most recent earlier video and
plays it; `back(steps: 2)` goes two videos back, and so on.

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
