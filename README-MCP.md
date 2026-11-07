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
| `get_state` | — | The current video **from the player API** (the URL does not follow programmatic switches), video state, whether the watch screen is actually showing, the player-API volume, a short page hint, the rendered page type (`screenPage`), and the recent watch history |
| `get_screen` | — | The "eyes": a structured snapshot of what is **actually rendered** — page type (browse / search / watch / channel / account-picker) classified from rendered evidence, the channel header identity on channel pages, the focused element, the search-box text, and the visible items **with their actionable targets** (video IDs, channel handles/browse IDs, durations, click positions). The ground truth other tools verify against |
| `play` | — | Resumes playback |
| `pause` | — | Pauses playback |
| `seek` | `seconds`: number | Seeks to an absolute position |
| `set_volume` | `volume`: 0–100 | Sets playback volume |
| `navigate_home` | — | Back to the YouTube TV home screen (real Escape key) |
| `search` | `query`: string, `openChannel`: optional boolean | Opens the TV search screen, **clears any text already in the search box**, types the query on the on-screen keyboard, **submits it with the SEARCH key**, and returns the top 10 results (title + video ID) — but only once they are verified to belong to this query (see below). Channel entries in the results are returned separately in `channels`; with `openChannel: true` the tool also clicks the rendered channel entry and reports the page state it lands on |
| `open_channel` | `channel`: creator name/alias, handle (@AsmonTV), channel ID (UC…), or channel URL | Navigates the app to that channel page and verifies the landing **against the rendered screen** (page type + channel header identity + that channel's videos on screen) before returning — route strings are never accepted as proof. Strategy (v3.16): the app has **no channel URL route** (proven live 2026-11-06 — @handle, /user/, and /channel/UC… URLs, as hash routes and as full reloads, all fall back to the home feed), so the tool takes the app's own path: resolve the channel's newest upload from its RSS feed, load it, and click the watch page's byline element (whose data carries the channel's browseId). Backups, in order: the same byline/endpoint clicks from an already-open watch page, the app's navigation event, and the saved-URL route as last resort. Search is never used to reach a channel. On landing it pauses any autoplay and moves down 2 rows, ending parked on the Videos row. Errors with a screen digest if nothing lands |
| `channel_uploads` | `channel`, optional `limit` (1–30, default 10) | A channel's uploads as rendered on its channel page (Videos tab when one is shown), newest first: title, video ID, duration, age text, Shorts flag. The collection half of "play what <creator> posted today" |
| `latest_video` | `channel`, optional `play` (boolean) | That channel's newest regular upload (title, video ID, duration) resolved **inside the app in one call** — no web lookup. Skips Shorts. With `play: true`, also plays it (verified like `play_video`) |
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
replaced, never appended to. After typing it presses the SEARCH key —
typing alone only lists suggestions; the search must actually be
executed. If the TV is on the Who's Watching profile picker, the tool
errors immediately (there is nothing to type into).

**Result verification (v3.8 — read this before "simplifying" it).** An
earlier version read the first `YTLR-SEARCH-RESPONSE-RENDERER` in the
document, regex-zipped every `videoId` and every title in its whole
data blob, and accepted the result once the "Search results for
<query>" header matched. In live use that returned a **frozen list of
home-feed items, byte-identical across different queries**, with
`resultsForQuery: true`: the header follows the search *box*, not the
response, the first renderer in the document is not necessarily the
live one, and whole-blob zipping pairs IDs with titles from other
shelves. The tool now snapshots every response renderer's data
fingerprint before typing, and accepts results only when **all** of
these hold: the header matches the typed query; a candidate is
provably fresh for this call (a renderer's fingerprint changed vs the
snapshot — or the on-screen results changed and their titles agree
with the candidate's — or the results are read from the rendered
items themselves, per item); and the candidate is stable across two
polls. IDs and titles are extracted by walking the response object
and pairing each ID with the title of the *same* item object. If
nothing verifies in time, the tool returns an error with diagnostics
instead of plausible-looking wrong results. `resultsFresh` in the
output says which path verified (`true`, `"visible-verified"`, or
`"rendered"`). v3.13 adds the rendered-state binding described above
and reports the final rendered page type as `screenPage`.

`get_state` probes **all** `<video>` elements and reports the active one
(largest/loaded/playing), plus the watch-screen rect (`watchView.active`
= the video is actually on screen), the player state/error fields, and a
compact page hint: the first ~200 characters of visible page text and
any visible dialog's text — enough to spot interstitials (profile
pickers, sign-in prompts) from the tool output. One known wrinkle:
`videoTitle` reflects the app's routed video, so right after an
API-driven switch it can lag one video behind; IDs and timestamps in
the history are always exact.

## Screen readout & rendered-state verification (v3.13)

Phase 2's foundation is `get_screen`: a structured snapshot of the
rendered page — its type, the channel header's identity when on a
channel page, the focused element, the search-box text, and the
visible items, each with the target dug out of **that item's own data
subtree** (video ID / channel browse ID / handle, plus duration, age
text, and click position). Tools no longer trust intentions:

- `open_channel` returns success only when the rendered page **is**
  the target's channel page: page type `channel`, a header whose
  name/handle/browse ID matches the target, and that channel's videos
  on screen. A route pointing at a *different* channel vetoes the
  match (stale routes from earlier navigations are real). The v3.9
  version checked the URL hash — which its own hash-route strategy
  had just written — and reported `verified` while the TV kept
  showing a stale search screen (live, three times, 2026-11-06).
  Hash-route strategies are deleted, not just distrusted.
- `search` keeps its fingerprint verification (below) and adds a
  **rendered-state binding**: when the on-screen items' IDs are
  readable, a data-store candidate sharing no ID with the rendered
  items is rejected outright.
- Navigation uses the app's own mechanisms only: trusted clicks on
  elements carrying the channel's browse endpoint (the watch page's
  channel byline; channel tiles on browse screens — subscribe buttons
  are explicitly excluded, their data carries the ID too), the app's
  navigation event, and — for handles/names — search followed by a
  trusted click on the rendered channel entry. Creator names and
  Matt's dictation aliases resolve through a baked-in creator table
  (`CREATORS` in `src/mcp/server.js`, mirrored from `CREATORS.md`):
  "Asmongold" / "Aspen Gold" → Asmongold TV (@AsmonTV), "minus tech
  tips" → Linus Tech Tips, and so on.

## Latest video, channel uploads, and the play queue

`latest_video` and `channel_uploads` resolve uploads from the
channel's own page inside the app: land via the verified
`open_channel` path, activate the **Videos** tab when one is rendered
(its list is newest-first; the channel home leads with featured
content), and read the uploads off the screen readout. Durations are
parsed from the rendered labels; items whose data carries a Shorts
(reel) endpoint are flagged `isShort`, and `latest_video` skips them.

`play_queue` ("play everything <creator> posted today", CREATORS.md
feature 3) is **designed, not built** — the collection half exists
(`channel_uploads` returns title/ID/duration/age text; "today" =
items whose age text is in minutes/hours, played oldest → newest).
The playback half needs state the current tools deliberately don't
have yet: a queue in the server context `{channel, videoIds, index}`,
an advance hook in the existing 4-second observer (when the player
reports `ended` or the current video leaves the queue head, load the
next ID via `playVideoCore`), and clear-on-manual-navigation
semantics (any `play_video`/`back`/manual switch outside the queue
clears it, mirroring how the observer already distinguishes
MCP-caused switches). It should ship only after `latest_video` has
passed live acceptance, since it builds on the same readout.

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

## Acceptance self-test (after a deploy)

`tools/selftest.py` runs the full acceptance matrix — search two
creators + a topic ("Taiwan travel"), open_channel, latest_video +
play_video, a second play, back, navigate_home — asserting the
**rendered** state via `get_screen` at each step. Run it in a
TV-free window right after deploying; a full run takes a few minutes
(the tools type/click at human pace). The server binds localhost on
the TV, so run it on the TV itself or through an SSH tunnel
(`ssh -L 8977:127.0.0.1:8977 tv@bazzite`). Token via `--token`,
`--token-file`, or `$VACUUMTUBE_MCP_TOKEN`; see the script's
docstring.
