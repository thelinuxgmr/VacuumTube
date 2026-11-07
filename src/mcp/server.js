// VacuumTube MCP control server
//
// An optional, token-gated MCP (Model Context Protocol) server that runs in
// the Electron main process and exposes a small set of high-level tools so an
// AI agent can control playback directly ("play this video", "what's
// playing?", "pause", "go back to what I was watching") instead of
// simulating remote-control button presses.
//
// - Transport: MCP Streamable HTTP, stateless, JSON responses.
// - Binds to 127.0.0.1 ONLY. It is meant to be reached locally, or through a
//   trusted tunnel/bridge on the same machine — never exposed to a LAN/WAN
//   interface directly.
// - Auth: `Authorization: Bearer <token>`. Multiple tokens are supported
//   (one per client/agent) so each agent can be issued — and revoked — its
//   own token. Tokens come from, in order:
//     1. the VACUUMTUBE_MCP_TOKENS env var (comma-separated), or
//     2. a `mcp-tokens.json` file in the app's userData directory:
//          { "tokens": ["token-for-agent-a", "token-for-agent-b"] }
//   If no tokens are configured, the server does not start at all and the
//   app behaves exactly like upstream VacuumTube.
// - Port: VACUUMTUBE_MCP_PORT env var, default 8977. Path: /mcp.
// - Page scripts run with a timeout (VACUUMTUBE_MCP_JS_TIMEOUT_MS env var,
//   default 5000) so a wedged page can never hang a tool call.
//
// How control works (learned the hard way — see README-MCP.md):
// the Leanback SPA does not route on URL/hash changes at all; it only
// *writes* the URL as a side effect of its own navigation. The reliable
// channels are the ones the app itself uses:
//   1. the HTML5 player's own API on #ytlr-player__player-container-player
//      (loadVideoById / getVideoData / playVideo / pauseVideo / seekTo /
//      setVolume) — switches media instantly, from any screen; and
//   2. trusted input events (webContents.sendInputEvent) for the view
//      layer — e.g. clicking a tile is what makes the app *show* the
//      watch screen when a video was loaded from a browse screen.
// play_video combines both and verifies the result against the page
// (player video id + real duration + media source) before returning.
//
// - Watch history is kept in `mcp-history.json` in userData: the videos
//   that were played (id, title when the page exposes it, and when
//   playback started), newest last. It powers the back() tool and is
//   included in get_state so an agent can resolve "the video I was
//   watching 20 minutes ago". Videos started by hand are recorded too
//   (a light poller watches for video changes).
//
// See README-MCP.md (repo root) for setup and client configuration.

const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const path = require('path')

const package = require('../../package.json')

const DEFAULT_PORT = 8977
const youtubeUrl = 'https://www.youtube.com/tv'
// Same Leanback client user agent the app itself uses for the first load
// (see the long note in src/index.js). The session webRequest hooks rewrite
// the User-Agent header for youtube.com requests anyway; this keeps direct
// navigations consistent.
const youtubeClientUserAgent = `Mozilla/5.0 (PS4; Leanback Shell) Cobalt/19.lts.0-qa; compatible; VacuumTube/${package.version}`

const PLAYER_SELECTOR = '#ytlr-player__player-container-player'

const JS_TIMEOUT_MS = (() => {
    let n = parseInt(process.env.VACUUMTUBE_MCP_JS_TIMEOUT_MS, 10)
    return (isFinite(n) && n > 0) ? n : 5000
})()

const HISTORY_LIMIT = 50

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function loadTokens(userData) {
    let tokens = []

    if (process.env.VACUUMTUBE_MCP_TOKENS) {
        tokens = process.env.VACUUMTUBE_MCP_TOKENS.split(',').map(t => t.trim()).filter(Boolean)
    }

    if (tokens.length === 0 && userData) {
        try {
            let tokenFile = path.join(userData, 'mcp-tokens.json')
            if (fs.existsSync(tokenFile)) {
                let parsed = JSON.parse(fs.readFileSync(tokenFile, 'utf-8'))
                let list = Array.isArray(parsed) ? parsed : parsed.tokens
                if (Array.isArray(list)) {
                    tokens = list.map(t => String(t).trim()).filter(Boolean)
                }
            }
        } catch (err) {
            console.error('[mcp] failed to read mcp-tokens.json', err)
        }
    }

    return tokens
}

function tokenMatches(provided, tokens) {
    if (!provided) return false
    let providedBuf = Buffer.from(provided)
    for (let token of tokens) {
        let tokenBuf = Buffer.from(token)
        if (tokenBuf.length === providedBuf.length && crypto.timingSafeEqual(tokenBuf, providedBuf)) {
            return true
        }
    }
    return false
}

function videoIdFrom(input) {
    if (!input) return null
    let str = String(input).trim()

    if (/^[\w-]{11}$/.test(str)) return str

    try {
        let url = new URL(str)
        let v = url.searchParams.get('v')
        if (v && /^[\w-]{11}$/.test(v)) return v

        let pathMatch = url.pathname.match(/\/(?:shorts|embed|live)\/([\w-]{11})/)
        if (pathMatch) return pathMatch[1]

        if (url.hostname === 'youtu.be') {
            let id = url.pathname.replace(/^\//, '').slice(0, 11)
            if (/^[\w-]{11}$/.test(id)) return id
        }
    } catch (err) {
        // not a URL — fall through
    }

    return null
}

function textResult(obj) {
    return { content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] }
}

function errorResult(message) {
    return { content: [{ type: 'text', text: String(message) }], isError: true }
}

// ---------------------------------------------------------------------------
// Page access helpers
// ---------------------------------------------------------------------------

// Run a script in the page, but never wait longer than timeoutMs for it.
// (The script itself may still complete in the page afterwards; the tool
// just stops waiting. Media play() promises in particular can pend forever
// on an unloaded element, which hung a v1 tool call for 30s.)
function evalJS(webContents, code, timeoutMs = JS_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
        let done = false
        let timer = setTimeout(() => {
            if (!done) {
                done = true
                reject(new Error(`page script timed out after ${timeoutMs}ms`))
            }
        }, timeoutMs)
        Promise.resolve()
            .then(() => webContents.executeJavaScript(code))
            .then(value => {
                if (!done) { done = true; clearTimeout(timer); resolve(value) }
            })
            .catch(err => {
                if (!done) { done = true; clearTimeout(timer); reject(err) }
            })
    })
}

// One probe of the page: every <video> element, the best guess at the
// active one, the player API's view of the current video (authoritative —
// the URL does not follow API-driven switches), whether the watch screen
// is actually being shown, a best-effort video title, and a compact page
// hint (first visible text + any visible dialog) so failures like an
// interstitial screen are diagnosable from the tool output alone.
const PROBE_JS = `(() => {
    const idFromHash = () => {
        const m = (location.hash || '').match(/[?&]v=([\\w-]{11})/)
        return m ? m[1] : null
    }
    const describe = (v, i) => {
        let width = 0, height = 0
        try {
            const r = v.getBoundingClientRect()
            width = Math.round(r.width); height = Math.round(r.height)
        } catch (e) {}
        return {
            index: i,
            paused: v.paused,
            ended: v.ended,
            currentTime: v.currentTime,
            duration: (typeof v.duration === 'number' && isFinite(v.duration)) ? v.duration : null,
            readyState: v.readyState,
            volume: v.volume,
            muted: v.muted,
            currentSrc: v.currentSrc || null,
            width, height
        }
    }
    const vids = Array.from(document.querySelectorAll('video')).map(describe)
    const score = x => (x.currentSrc ? 8 : 0) + x.readyState * 2 +
        Math.min(4, (x.width * x.height) / 200000) + (x.duration ? 2 : 0) + (!x.paused ? 1 : 0)
    let active = null, bestScore = -1
    for (const x of vids) {
        const s = score(x)
        if (s > bestScore) { bestScore = s; active = x }
    }

    let player = null
    try {
        const p = document.querySelector(${JSON.stringify(PLAYER_SELECTOR)})
        if (p && typeof p.getVideoData === 'function') {
            const d = p.getVideoData() || {}
            player = {
                id: d.video_id || null,
                isPlayable: d.isPlayable !== false,
                errorCode: (d.errorCode === undefined ? null : d.errorCode),
                isLive: !!d.isLive
            }
            try { player.state = p.getPlayerState() } catch (e) {}
            try { if (typeof p.getVolume === 'function') player.volume = p.getVolume() } catch (e) {}
        }
    } catch (e) {}

    let watchView = { width: 0, height: 0, active: false }
    try {
        const wp = document.querySelector('YTLR-WATCH-PAGE')
        if (wp) {
            const r = wp.getBoundingClientRect()
            watchView = {
                width: Math.round(r.width),
                height: Math.round(r.height),
                active: r.width > 100 && r.height > 100
            }
        }
    } catch (e) {}

    let videoTitle = null
    try {
        const md = navigator.mediaSession && navigator.mediaSession.metadata
        if (md && md.title) videoTitle = String(md.title)
    } catch (e) {}
    if (!videoTitle) {
        const sels = ['.ytlr-watch-metadata__title', '[class*="watch-metadata"] [class*="title"]', 'h1']
        for (const s of sels) {
            try {
                const el = document.querySelector(s)
                if (el && el.textContent && el.textContent.trim()) { videoTitle = el.textContent.trim().slice(0, 200); break }
            } catch (e) {}
        }
    }
    if (!videoTitle) {
        try {
            const wp = document.querySelector('YTLR-WATCH-PAGE')
            if (wp && wp.data) {
                const s = JSON.stringify(wp.data).slice(0, 20000)
                const m = s.match(/"(?:title|videoTitle)":\\s*"([^"]{3,200})"/)
                if (m) videoTitle = m[1]
            }
        } catch (e) {}
    }

    let pageText = ''
    try { pageText = (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 200) } catch (e) {}

    let dialog = null
    try {
        const els = document.querySelectorAll('[role="dialog"], [role="alertdialog"]')
        for (const el of els) {
            const r = el.getBoundingClientRect()
            if (r.width > 0 && r.height > 0) {
                dialog = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 120) || true
                break
            }
        }
    } catch (e) {}

    const watchId = idFromHash()
    return {
        href: location.href,
        hash: location.hash,
        watchId: watchId,
        playerId: player ? player.id : null,
        currentId: (player && player.id) || watchId,
        player: player,
        watchView: watchView,
        title: document.title,
        videoTitle: videoTitle,
        videoCount: vids.length,
        videos: vids,
        video: active,
        pageText: pageText,
        dialog: dialog
    }
})()`

// Picks the same "active" video element the probe reports, for the
// transport tools (play/pause/seek/volume) to act on as a fallback when
// the player API is unavailable.
const PICK_VIDEO_JS = `(() => {
    const vids = Array.from(document.querySelectorAll('video'))
    const score = v => {
        let area = 0
        try { const r = v.getBoundingClientRect(); area = r.width * r.height } catch (e) {}
        return (v.currentSrc ? 8 : 0) + v.readyState * 2 + Math.min(4, area / 200000) +
            ((typeof v.duration === 'number' && isFinite(v.duration)) ? 2 : 0) + (!v.paused ? 1 : 0)
    }
    let best = null, bestScore = -1
    for (const v of vids) {
        const s = score(v)
        if (s > bestScore) { bestScore = s; best = v }
    }
    return best
})()`

const PLAYER_JS = `document.querySelector(${JSON.stringify(PLAYER_SELECTOR)})`

async function probe(webContents) {
    return await evalJS(webContents, PROBE_JS)
}

function stateFromProbe(webContents, p) {
    let out = {
        ok: true,
        url: webContents.getURL(),
        href: p.href,
        title: p.title,
        video: p.video || null
    }
    if (p.currentId) out.currentId = p.currentId
    if (p.playerId) out.playerId = p.playerId
    if (p.watchId) out.watchId = p.watchId
    if (p.player) out.player = p.player
    if (p.watchView) out.watchView = p.watchView
    if (p.videoTitle) out.videoTitle = p.videoTitle
    if (p.videoCount > 1) out.videos = p.videos
    if (p.pageText) out.pageText = p.pageText
    if (p.dialog) out.dialog = p.dialog
    return out
}

// Does this probe show the target video actually loaded as media?
// A matching route alone is not enough: the SPA can update the URL while
// the old media keeps playing, or create an element that never loads.
// The player API's video id is the strongest signal; the route id plus a
// real duration and a *changed* media source is the fallback.
function probeMatchesTarget(p, id, oldBlob) {
    if (!p || !p.video) return false
    let v = p.video
    if (v.duration == null || !v.currentSrc) return false
    if (p.playerId) return p.playerId === id
    if (p.watchId !== id) return false
    if (oldBlob && v.currentSrc === oldBlob) return false
    return true
}

async function waitForVideo(webContents, id, { timeoutMs = 10000, oldBlob = null } = {}) {
    let deadline = Date.now() + timeoutMs
    let last = null
    for (;;) {
        try {
            last = await probe(webContents)
        } catch (err) {
            last = null
        }
        if (last && probeMatchesTarget(last, id, oldBlob)) {
            return { matched: true, probe: last }
        }
        if (Date.now() >= deadline) break
        await sleep(Math.min(400, Math.max(40, deadline - Date.now())))
    }
    if (!last) {
        try { last = await probe(webContents) } catch (err) { /* keep null */ }
    }
    return { matched: false, probe: last }
}

// ---------------------------------------------------------------------------
// Watch history (powers back(); persisted in userData)
// ---------------------------------------------------------------------------

function createHistory(userData) {
    let file = userData ? path.join(userData, 'mcp-history.json') : null
    let entries = []

    if (file) {
        try {
            if (fs.existsSync(file)) {
                let parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
                let list = Array.isArray(parsed) ? parsed : parsed.entries
                if (Array.isArray(list)) {
                    entries = list
                        .filter(e => e && /^[\w-]{11}$/.test(e.id || ''))
                        .map(e => ({
                            id: e.id,
                            title: e.title || undefined,
                            startedAt: typeof e.startedAt === 'number' ? e.startedAt : undefined
                        }))
                        .slice(-HISTORY_LIMIT)
                }
            }
        } catch (err) {
            console.error('[mcp] failed to read history file', err)
            entries = []
        }
    }

    function save() {
        if (!file) return
        try {
            fs.writeFileSync(file, JSON.stringify({ entries }, null, 2))
        } catch (err) {
            console.error('[mcp] failed to write history file', err)
        }
    }

    return {
        list() {
            return entries.slice()
        },
        // Record that a video was left behind (it started at startedAt).
        // Consecutive duplicates are merged so the MCP tools and the
        // observation poller don't double-record the same transition.
        push(entry) {
            if (!entry || !/^[\w-]{11}$/.test(entry.id || '')) return
            let last = entries[entries.length - 1]
            if (last && last.id === entry.id) {
                if (!last.title && entry.title) last.title = entry.title
                if (!last.startedAt && entry.startedAt) last.startedAt = entry.startedAt
                save()
                return
            }
            entries.push({
                id: entry.id,
                title: entry.title || undefined,
                startedAt: entry.startedAt || Date.now()
            })
            if (entries.length > HISTORY_LIMIT) entries = entries.slice(-HISTORY_LIMIT)
            save()
        },
        // Remove and return the entry `steps` back from the top of the
        // stack, skipping (and dropping) entries for the video that is
        // currently on screen.
        popBack(currentId, steps = 1) {
            let seen = 0
            for (let i = entries.length - 1; i >= 0; i--) {
                if (currentId && entries[i].id === currentId) {
                    entries.splice(i, 1)
                    continue
                }
                seen++
                if (seen === steps) {
                    let [entry] = entries.splice(i, 1)
                    save()
                    return entry
                }
            }
            save()
            return null
        }
    }
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

function createMcpServer({ getWindow, context }) {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
    const { z } = require('zod')

    const server = new McpServer({
        name: 'vacuumtube',
        version: package.version
    })

    function getWindowSafe() {
        let win = typeof getWindow === 'function' ? getWindow() : null
        if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
            throw new Error('VacuumTube window is not available')
        }
        return win
    }

    function getWebContents() {
        return getWindowSafe().webContents
    }

    // registerTool is the current SDK API; fall back to tool() on older SDKs.
    function register(name, description, inputSchema, handler) {
        let wrapped = async (args) => {
            try {
                return await handler(args || {})
            } catch (err) {
                return errorResult(err && err.message ? err.message : String(err))
            }
        }
        if (typeof server.registerTool === 'function') {
            server.registerTool(name, { description, inputSchema }, wrapped)
        } else {
            server.tool(name, description, inputSchema, wrapped)
        }
    }

    // -- trusted input ------------------------------------------------------
    // The view layer only responds to real input. Electron's
    // sendInputEvent injects trusted events through the same pipeline as
    // hardware input, which is what the experiments validated.

    function focusWindow() {
        try {
            let win = getWindowSafe()
            if (win.focus) win.focus()
            if (win.webContents && win.webContents.focus) win.webContents.focus()
        } catch (err) { /* best effort */ }
    }

    function clickPoint(webContents, x, y) {
        focusWindow()
        let opts = { x: Math.round(x), y: Math.round(y) }
        webContents.sendInputEvent({ ...opts, type: 'mouseMove' })
        webContents.sendInputEvent({ ...opts, type: 'mouseDown', button: 'left', clickCount: 1 })
        webContents.sendInputEvent({ ...opts, type: 'mouseUp', button: 'left', clickCount: 1 })
    }

    function tapKey(webContents, keyCode) {
        focusWindow()
        webContents.sendInputEvent({ type: 'keyDown', keyCode })
        webContents.sendInputEvent({ type: 'keyUp', keyCode })
    }

    // Center point of the first visible browse tile, or null.
    async function findTilePoint(webContents) {
        return await evalJS(webContents, `(() => {
            for (const el of document.querySelectorAll('YTLR-TILE-RENDERER')) {
                const r = el.getBoundingClientRect()
                if (r.width > 80 && r.height > 50 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) {
                    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
                }
            }
            return null
        })()`).catch(() => null)
    }

    // If the app is not showing the watch screen, click a browse tile —
    // the one action that reliably makes the app enter it. The tile's own
    // video starts loading into the player, and playVideoCore immediately
    // hijacks the player with the real target, so at most a buffering
    // glimpse of the tile's video is ever shown. Returns true when the
    // watch view became active.
    async function enterWatchView(webContents, before) {
        let point = await findTilePoint(webContents)
        if (!point) return false
        // Mute first so the tile's video can't blare while we hijack it;
        // the caller restores the previous mute/volume afterwards.
        await evalJS(webContents, `(() => {
            const v = ${PICK_VIDEO_JS}
            if (v) v.muted = true
            return true
        })()`).catch(() => {})
        clickPoint(webContents, point.x, point.y)
        let deadline = Date.now() + 7000
        while (Date.now() < deadline) {
            await sleep(150)
            let p = await probe(webContents).catch(() => null)
            if (p && p.watchView && p.watchView.active) return true
        }
        return false
    }

    async function restoreAudio(webContents, before) {
        if (!before || !before.video) return
        let muted = before.video.muted ? 'true' : 'false'
        let volume = JSON.stringify(before.video.volume)
        await evalJS(webContents, `(() => {
            const v = ${PICK_VIDEO_JS}
            if (v) { v.muted = ${muted}; v.volume = ${volume} }
            return true
        })()`).catch(() => {})
    }

    // Core navigation used by play_video and back(). Primary channel: the
    // player element's own loadVideoById(), which switches media from any
    // screen. If the app isn't showing the watch screen, a trusted tile
    // click enters it first (the player load alone would otherwise play
    // in the background behind the browse UI). Every path verifies
    // against the page before claiming success; the URL/hash tricks from
    // v1/v2 are kept only as a last-ditch fallback.
    async function playVideoCore(id, { record = true } = {}) {
        let webContents = getWebContents()

        let before = null
        try { before = await probe(webContents) } catch (err) { /* page may be mid-load */ }
        let fromId = before ? (before.currentId || null) : null
        let fromTitle = before ? before.videoTitle : null
        let oldBlob = (before && before.video) ? before.video.currentSrc : null

        if (fromId && fromId !== id && record) {
            let observed = context.observed
            context.history.push({
                id: fromId,
                title: fromTitle || (observed && observed.id === fromId ? observed.title : undefined),
                startedAt: (observed && observed.id === fromId) ? observed.startedAt : undefined
            })
        }
        context.lastMcpNavAt = Date.now()
        context.lastMcpNavTarget = id

        if (fromId === id && before && before.video && before.video.duration != null) {
            await evalJS(webContents, `(() => {
                const p = ${PLAYER_JS}
                if (p && typeof p.playVideo === 'function') { try { p.playVideo() } catch (e) {} return true }
                const v = ${PICK_VIDEO_JS}
                if (v && v.paused) { const pr = v.play(); if (pr && pr.catch) pr.catch(() => {}) }
                return true
            })()`).catch(() => {})
            await sleep(300)
            let now = await probe(webContents).catch(() => before)
            return { ok: true, verified: true, strategy: 'already-playing', videoId: id, ...stateFromProbe(webContents, now) }
        }

        let attempts = []
        let finish = (r, strategy) => ({
            ok: true, verified: true, strategy, videoId: id,
            ...stateFromProbe(webContents, r.probe)
        })

        let loadViaApi = async () => {
            return await evalJS(webContents, `(() => {
                const p = ${PLAYER_JS}
                if (!p || typeof p.loadVideoById !== 'function') return false
                p.loadVideoById(${JSON.stringify(id)})
                return true
            })()`).catch(() => false)
        }

        let onWatchView = !!(before && before.watchView && before.watchView.active)

        if (!onWatchView) {
            let entered = await enterWatchView(webContents, before)
            attempts.push({ strategy: 'enter-watch-view', matched: entered })
            if (entered) onWatchView = true
        }

        if (await loadViaApi()) {
            let r = await waitForVideo(webContents, id, { timeoutMs: 10000, oldBlob })
            attempts.push({ strategy: 'player-api', matched: r.matched })
            if (r.matched) {
                await restoreAudio(webContents, before)
                let strategy = attempts.some(a => a.strategy === 'enter-watch-view' && a.matched)
                    ? 'tile-then-player-api' : 'player-api'
                let out = finish(r, strategy)
                if (!out.watchView || !out.watchView.active) out.viewWarning = 'media switched, but the watch screen is not in front (browse UI may still be showing)'
                return out
            }
        } else {
            attempts.push({ strategy: 'player-api', matched: false, note: 'player element/API not found' })
        }

        // Last-ditch fallback: the v1/v2 route tricks. The SPA ignored
        // them in testing, but they cost little and a future YouTube
        // update might honor them again.
        let watchHash = `#/watch?v=${id}`
        if (webContents.getURL().startsWith(youtubeUrl)) {
            await evalJS(webContents, `location.hash = ${JSON.stringify(watchHash)}; true`).catch(() => {})
            let r = await waitForVideo(webContents, id, { timeoutMs: 5000, oldBlob })
            attempts.push({ strategy: 'hash', matched: r.matched })
            if (r.matched) return finish(r, 'hash')
        } else {
            await webContents.loadURL(`${youtubeUrl}${watchHash}`, { userAgent: youtubeClientUserAgent }).catch(() => {})
            let r = await waitForVideo(webContents, id, { timeoutMs: 8000, oldBlob })
            attempts.push({ strategy: 'loadurl', matched: r.matched })
            if (r.matched) return finish(r, 'loadurl')
        }

        await restoreAudio(webContents, before)
        let last = null
        try { last = await probe(webContents) } catch (err) { /* ignore */ }
        return {
            ok: false,
            verified: false,
            videoId: id,
            attempts,
            error: 'the video did not start playing — see the returned page state',
            ...(last ? stateFromProbe(webContents, last) : {})
        }
    }

    register('play_video',
        'Navigate VacuumTube to a YouTube video and start playing it (shown on the watch screen). Accepts a video ID or any YouTube watch/share URL. Verifies the switch actually happened before returning.',
        { video: z.string().describe('YouTube video ID or URL') },
        async ({ video }) => {
            let id = videoIdFrom(video)
            if (!id) return errorResult(`Could not extract a YouTube video ID from: ${video}`)
            let result = await playVideoCore(id, { record: true })
            return textResult(result)
        })

    register('get_state',
        'Report what VacuumTube is currently doing: the current video (from the player API — the URL does not follow programmatic switches), video state (paused, position, duration, volume), whether the watch screen is showing, a short page hint for diagnosing problems, and the recent watch history (id, title, when it started) used by back().',
        {},
        async () => {
            let webContents = getWebContents()
            let p = await probe(webContents)
            let out = stateFromProbe(webContents, p)
            out.history = context.history.list().slice(-10)
            return textResult(out)
        })

    register('play',
        'Resume playback of the current video.',
        {},
        async () => {
            let webContents = getWebContents()
            await evalJS(webContents, `(() => {
                const p = ${PLAYER_JS}
                if (p && typeof p.playVideo === 'function') { try { p.playVideo(); return true } catch (e) {} }
                const v = ${PICK_VIDEO_JS}
                if (!v) return false
                const pr = v.play()
                if (pr && pr.catch) pr.catch(() => {})
                return true
            })()`)
            await sleep(300)
            let p = await probe(webContents)
            return textResult(stateFromProbe(webContents, p))
        })

    register('pause',
        'Pause the current video.',
        {},
        async () => {
            let webContents = getWebContents()
            await evalJS(webContents, `(() => {
                const p = ${PLAYER_JS}
                if (p && typeof p.pauseVideo === 'function') { try { p.pauseVideo(); return true } catch (e) {} }
                const v = ${PICK_VIDEO_JS}
                if (v) v.pause()
                return !!v
            })()`)
            let p = await probe(webContents)
            return textResult(stateFromProbe(webContents, p))
        })

    register('seek',
        'Seek the current video to an absolute position, in seconds.',
        { seconds: z.number().describe('Absolute position in seconds') },
        async ({ seconds }) => {
            let target = Number(seconds)
            if (!isFinite(target) || target < 0) return errorResult(`Invalid seek position: ${seconds}`)
            let webContents = getWebContents()
            await evalJS(webContents, `(() => {
                const p = ${PLAYER_JS}
                if (p && typeof p.seekTo === 'function') { try { p.seekTo(${JSON.stringify(target)}, true); return true } catch (e) {} }
                const v = ${PICK_VIDEO_JS}
                if (v) v.currentTime = ${JSON.stringify(target)}
                return !!v
            })()`)
            await sleep(250)
            let p = await probe(webContents)
            return textResult(stateFromProbe(webContents, p))
        })

    register('set_volume',
        'Set playback volume from 0 (muted) to 100 (full).',
        { volume: z.number().min(0).max(100).describe('Volume 0-100') },
        async ({ volume }) => {
            let level = Math.max(0, Math.min(100, Number(volume)))
            let webContents = getWebContents()
            await evalJS(webContents, `(() => {
                const p = ${PLAYER_JS}
                if (p && typeof p.setVolume === 'function') {
                    try {
                        if (typeof p.unMute === 'function' && ${JSON.stringify(level)} > 0) p.unMute()
                        p.setVolume(${JSON.stringify(level)})
                        return true
                    } catch (e) {}
                }
                const v = ${PICK_VIDEO_JS}
                if (v) {
                    v.volume = ${JSON.stringify(level / 100)}
                    if (${JSON.stringify(level)} > 0) v.muted = false
                }
                return !!v
            })()`)
            let p = await probe(webContents)
            return textResult(stateFromProbe(webContents, p))
        })

    register('navigate_home',
        'Navigate VacuumTube back to the YouTube TV home screen.',
        {},
        async () => {
            let webContents = getWebContents()
            // The app exits the watch screen on Escape (a real key event);
            // hash changes do nothing in this SPA.
            tapKey(webContents, 'Escape')
            await sleep(800)
            let p = await probe(webContents).catch(() => null)
            if (p && p.watchView && p.watchView.active) {
                tapKey(webContents, 'Escape')
                await sleep(800)
                p = await probe(webContents).catch(() => p)
            }
            if (p && p.watchView && p.watchView.active) {
                await evalJS(webContents, `location.hash = '#/'; true`).catch(() => {})
                await sleep(600)
                p = await probe(webContents).catch(() => p)
            }
            return textResult(p ? stateFromProbe(webContents, p) : { ok: true, url: youtubeUrl })
        })

    register('search',
        'Open the YouTube TV search screen, type the query, and return the top results found on the page (title + video ID when the page exposes them).',
        { query: z.string().describe('Search query') },
        async ({ query }) => {
            let q = String(query || '').trim()
            if (!q) return errorResult('search query is empty')
            let webContents = getWebContents()

            // The search pill only exists on browse screens. If a video
            // is in front, leave the watch screen first (Escape), or the
            // click below finds nothing and the search silently no-ops.
            let startProbe = await probe(webContents).catch(() => null)
            if (startProbe && startProbe.watchView && startProbe.watchView.active) {
                tapKey(webContents, 'Escape')
                let escDeadline = Date.now() + 6000
                while (Date.now() < escDeadline) {
                    await sleep(300)
                    let p = await probe(webContents).catch(() => null)
                    if (p && (!p.watchView || !p.watchView.active)) break
                }
            }

            // Open the search screen by clicking the search pill/bar — a
            // real input event; the SPA ignores route changes.
            let pill = await evalJS(webContents, `(() => {
                const candidates = []
                for (const el of document.querySelectorAll('*')) {
                    if (el.children.length === 0 && el.textContent && el.textContent.trim() === 'Search') {
                        candidates.push(el)
                    }
                }
                let best = null
                for (let el of candidates) {
                    let node = el
                    for (let i = 0; i < 4 && node; i++) {
                        const r = node.getBoundingClientRect()
                        if (r.width > 100 && r.height > 20) { best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; break }
                        node = node.parentElement
                    }
                    if (best) break
                }
                return best
            })()`).catch(() => null)
            if (pill) clickPoint(webContents, pill.x, pill.y)

            // Wait for the search screen.
            let onSearch = false
            let deadline = Date.now() + 6000
            while (Date.now() < deadline) {
                let p = await probe(webContents).catch(() => null)
                if (p && (p.hash || '').startsWith('#/search')) { onSearch = true; break }
                await sleep(300)
            }

            // Type the query on the on-screen keyboard: the search screen
            // has no text input at all (verified live) — synthetic text
            // insertion (insertText, char events) never reaches it. What
            // works is clicking the keyboard's letter keys with trusted
            // clicks; results then render live as the query grows.
            let typeLabel = async (label) => {
                let pt = await evalJS(webContents, `(() => {
                    const kb = document.querySelector('YTLR-SEARCH-KEYBOARD') || document
                    for (const el of kb.querySelectorAll('*')) {
                        if (el.children.length === 0 && el.textContent && el.textContent.trim() === ${JSON.stringify('__LABEL__')}) {
                            const r = el.getBoundingClientRect()
                            if (r.width > 5 && r.height > 5) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
                        }
                    }
                    return null
                })()`.replace('__LABEL__', label)).catch(() => null)
                if (pt) {
                    clickPoint(webContents, pt.x, pt.y)
                    return true
                }
                return false
            }
            let typed = ''
            let skipped = ''
            if (onSearch) {
                for (let ch of q) {
                    if (/[a-z]/i.test(ch)) {
                        if (await typeLabel(ch.toUpperCase())) typed += ch
                        else skipped += ch
                    } else if (ch === ' ') {
                        if (await typeLabel('SPACE')) typed += ' '
                        else skipped += ch
                    } else if (/[0-9]/.test(ch)) {
                        // Digits live behind the &123 keyboard mode.
                        if (await typeLabel('&123')) {
                            await sleep(300)
                            if (await typeLabel(ch)) typed += ch
                            else skipped += ch
                            await typeLabel('ABC')
                        } else {
                            skipped += ch
                        }
                    } else {
                        skipped += ch
                    }
                    await sleep(280)
                }
            }

            // Wait for and scrape the results. The rendered items are
            // virtualized rows without usable per-item data, but the
            // search response renderer's data object carries the full
            // result set: video IDs and titles appear in result order
            // (verified live — first ID matches first title). Zip them.
            let scrape = async () => await evalJS(webContents, `(() => {
                const el = document.querySelector('YTLR-SEARCH-RESPONSE-RENDERER')
                if (!el || !el.data) return []
                const s = JSON.stringify(el.data)
                const ids = []
                const seen = new Set()
                for (const m of s.matchAll(/"videoId":\\s*"([\\w-]{11})"/g)) {
                    if (!seen.has(m[1])) { seen.add(m[1]); ids.push(m[1]) }
                }
                const titles = []
                for (const m of s.matchAll(/"title":\\{"simpleText":"((?:[^"\\\\]|\\\\.)*)"/g)) {
                    try { titles.push(JSON.parse('"' + m[1] + '"')) } catch (e) { titles.push(m[1]) }
                }
                const out = []
                for (let i = 0; i < Math.min(10, ids.length); i++) {
                    out.push({ id: ids[i], title: titles[i] || null })
                }
                return out
            })()`).catch(() => [])

            let results = []
            let rDeadline = Date.now() + 10000
            for (;;) {
                results = await scrape()
                if (results.length > 0 || Date.now() >= rDeadline) break
                await sleep(700)
            }

            let p = await probe(webContents).catch(() => null)
            let out = {
                ok: true,
                query: q,
                typedQuery: typed,
                onSearchScreen: onSearch,
                results,
                ...(p ? stateFromProbe(webContents, p) : {})
            }
            if (skipped) out.skippedCharacters = skipped
            if (results.length === 0) {
                out.note = 'no results could be scraped from the search page (see pageText for what the TV is showing)'
            }
            return textResult(out)
        })

    register('back',
        'Go back to a previously watched video. With no arguments, returns to the most recent earlier video; pass steps to go further back. History includes videos started by hand, each with when it started playing.',
        { steps: z.number().int().min(1).max(10).optional().describe('How many videos back to go (default 1)') },
        async ({ steps }) => {
            let webContents = getWebContents()
            let current = null
            try { current = await probe(webContents) } catch (err) { /* ignore */ }
            let entry = context.history.popBack(current ? current.currentId : null, steps || 1)
            if (!entry) return errorResult('no earlier video in the watch history')
            let result = await playVideoCore(entry.id, { record: false })
            return textResult({
                ...result,
                backTo: { id: entry.id, title: entry.title || null, startedAt: entry.startedAt || null }
            })
        })

    return server
}

// Watch for videos started by hand (remote control, autoplay chains) so
// back() covers them too. MCP-initiated switches are recorded by
// playVideoCore itself; the poller skips transitions it caused. The
// current video is tracked by the player API's id first (the URL does
// not follow programmatic switches), falling back to the route id.
function startObserver({ getWindow, context }) {
    let tick = async () => {
        try {
            let win = typeof getWindow === 'function' ? getWindow() : null
            if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return
            let p = await probe(win.webContents)
            let currentId = p.currentId || null
            let obs = context.observed

            if (!obs) {
                context.observed = currentId
                    ? { id: currentId, title: p.videoTitle || undefined, startedAt: Date.now() }
                    : null
                return
            }

            if (currentId === obs.id) {
                if (!obs.title && p.videoTitle) obs.title = p.videoTitle
                return
            }

            // The on-screen video changed (or playback left to a menu).
            let mcpCaused = Date.now() - context.lastMcpNavAt < 10000 &&
                currentId === context.lastMcpNavTarget
            if (!mcpCaused) {
                context.history.push({ id: obs.id, title: obs.title, startedAt: obs.startedAt })
            }
            context.observed = currentId
                ? { id: currentId, title: p.videoTitle || undefined, startedAt: Date.now() }
                : null
        } catch (err) {
            // Page mid-navigation or window busy — try again next tick.
        }
    }
    let timer = setInterval(tick, 4000)
    if (typeof timer.unref === 'function') timer.unref()
    return timer
}

function start({ getWindow, userData } = {}) {
    let tokens = loadTokens(userData)
    if (tokens.length === 0) {
        console.log('[mcp] no tokens configured (set VACUUMTUBE_MCP_TOKENS or create mcp-tokens.json in userData); MCP server disabled')
        return null
    }

    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')

    let context = {
        history: createHistory(userData),
        observed: null,
        lastMcpNavAt: 0,
        lastMcpNavTarget: null
    }

    let port = parseInt(process.env.VACUUMTUBE_MCP_PORT, 10)
    if (!isFinite(port) || port <= 0) port = DEFAULT_PORT

    let httpServer = http.createServer(async (req, res) => {
        try {
            let url = new URL(req.url, 'http://127.0.0.1')
            if (url.pathname !== '/mcp') {
                res.writeHead(404, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'not found' }))
                return
            }

            let auth = req.headers['authorization'] || ''
            let provided = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null
            if (!tokenMatches(provided, tokens)) {
                res.writeHead(401, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'unauthorized' }))
                return
            }

            let body = undefined
            if (req.method === 'POST') {
                let raw = ''
                for await (let chunk of req) {
                    raw += chunk
                    if (raw.length > 1024 * 1024) throw new Error('request body too large')
                }
                if (raw) body = JSON.parse(raw)
            }

            // Stateless mode: a fresh server+transport per request keeps this
            // simple and robust for agent-style calls (initialize, tools/list,
            // tools/call each work as one-shot requests). Shared state
            // (history, observer) lives in `context`, created once above.
            let mcpServer = createMcpServer({ getWindow, context })
            let transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
                enableJsonResponse: true
            })

            res.on('close', () => {
                transport.close().catch(() => {})
                mcpServer.close().catch(() => {})
            })

            await mcpServer.connect(transport)
            await transport.handleRequest(req, res, body)
        } catch (err) {
            console.error('[mcp] request failed', err)
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'application/json' })
                res.end(JSON.stringify({ error: 'internal error' }))
            } else if (!res.writableEnded) {
                res.end()
            }
        }
    })

    httpServer.on('error', (err) => {
        console.error('[mcp] HTTP server error', err)
    })

    httpServer.listen(port, '127.0.0.1', () => {
        console.log(`[mcp] VacuumTube MCP server listening on http://127.0.0.1:${port}/mcp (${tokens.length} token(s) configured)`)
    })

    startObserver({ getWindow, context })

    return httpServer
}

module.exports = { start }
