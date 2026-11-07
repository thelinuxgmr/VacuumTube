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
| `play_video` | `video`: video ID or YouTube URL | Plays that video on the watch screen via the app's own player API. **Verifies** the switch before returning (see below) |
| `get_state` | — | The current video **from the player API** (the URL does not follow programmatic switches), video state, whether the watch screen is actually showing, the player-API volume, a short page hint, and the recent watch history |
| `play` | — | Resumes playback |
| `pause` | — | Pauses playback |
| `seek` | `seconds`: number | Seeks to an absolute position |
| `set_volume` | `volume`: 0–100 | Sets playback volume |
| `navigate_home` | — | Back to the YouTube TV home screen (real Escape key) |
| `search` | `query`: string | Opens the TV search screen, **clears any text already in the search box**, types the query on the on-screen keyboard, and returns the top 10 results (title + video ID) from the search response data |
| `back` | `steps`: optional, 1–10 | Returns to a previously watched video (see History) |

## How control works (learned live — read this before "fixing" navigation)

The Leanback SPA **does not route on URL/hash changes at all** — it only
*writes* the URL as a side effect of its own navigation, and even full
reloads strip watch URLs back to home. Hash/loadURL navigation (the v1/v2
approach) changed nothing on screen. What works is what the app itself
uses, verified against the running app via CDP:

1. **The player element's own API.** `#ytlr-player__player-container-player`
   exposes the classic player API: `loadVideoById`, `getVideoData`,
   `playVideo`, `pauseVideo`, `seekTo`, `setVolume`. `loadVideoById`
   switches media instantly, from any screen. The transport tools prefer
   these methods too.
2. **Trusted input for the view layer.** Loading a video while a browse
   screen is in front plays it *behind* the UI — the view follows only
   real input. So `play_video`, when the watch screen isn't showing,
   first clicks a browse tile with trusted `webContents.sendInputEvent`
   events to enter the watch screen (muted; the player is hijacked with
   the target immediately, so the tile's video is at most a buffering
   glimpse), then loads the target via the API. From the search screen
   there are no tiles, so it presses Escape to a browse screen first.
3. **`getVideoData().video_id` is the authoritative current video.** The
   URL keeps showing whatever the app last navigated to by hand, so the
   probe, the switch verification, and the history observer all prefer
   the player ID over the route ID.

`play_video` verifies before returning: it polls until the player reports
the target ID with a real duration and a loaded media source, and reports
`verified` + the `strategy` used (`player-api`, `tile-then-player-api`,
`already-playing`). Route/hash tricks remain only as a last-ditch
fallback. All page scripts run under a timeout
(`VACUUMTUBE_MCP_JS_TIMEOUT_MS`, default 5000 ms), and no tool awaits
media `play()` promises, so nothing can hang on a wedged page.

`search` has its own quirks, also verified live: the search screen has
**no text input element** and synthetic text (`insertText`, char events)
never reaches it — the query is typed by clicking the on-screen
keyboard's keys. Letters, SPACE, CLEAR and SEARCH live in the
`YTLR-SEARCH-KEYBOARD` subtree; digits hide behind the `&123` mode key.
The tool first reads the search box and CLEARs any pre-existing text
(reported as `clearedExistingQuery`), so a user's half-typed query is
replaced, never appended to. Results are read from
`YTLR-SEARCH-RESPONSE-RENDERER.data`, whose video IDs and titles appear
in matching order, and are only accepted once the page's
"Search results for <query>" header matches what was typed
(`resultsForQuery`) — the previous query's data otherwise lingers and
would be returned stale.

`get_state` probes **all** `<video>` elements and reports the active one
(largest/loaded/playing), plus the watch-screen rect (`watchView.active`
= the video is actually on screen), the player state/error fields, and a
compact page hint: the first ~200 characters of visible page text and
any visible dialog's text — enough to spot interstitials (profile
pickers, sign-in prompts) from the tool output. One known wrinkle:
`videoTitle` reflects the app's routed video, so right after an
API-driven switch it can lag one video behind; IDs and timestamps in
the history are always exact.

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
