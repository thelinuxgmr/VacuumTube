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
// v3.14: the search keyboard typer reaches digits AND symbols via the
// &123 keyboard page — previously any non-letter/non-space character
// (incl. '@') was silently skipped, so handle searches lost the '@'.
//
// v3.15 (Matt's rule, 2026-11-06 21:01–21:04): open_channel navigates
// DIRECTLY to the channel's saved URL — the search-then-click strategy
// is deleted and search is never used to reach a channel. On landing
// the handler pauses any autoplay and presses DOWN 2 immediately,
// ending parked on the Videos row with the newest upload focused.
//
// v3.16: live testing proved v3.15's premise false — this SPA does
// not route channels by URL at all (@handle, /user/, /channel/UC…;
// hash and full reload all fall back to the home feed — the header
// comment above said so all along). open_channel's primary route is
// now the app's own path: resolve the channel's newest upload from
// its RSS feed, load it with playVideoCore, and click the watch
// page's byline element (its data carries the channel's browseId).
// The URL strategies are demoted to last resort, AFTER the byline
// and endpoint strategies they used to sabotage by destroying the
// watch page. Creator browseIds are baked into CREATORS.
//
// v3.17: the RSS feed endpoint is dead (404 from two networks,
// even for channels whose own pages link the feed URL) --
// newest-upload resolution now reads the channel's /videos page
// markup, whose initial data lists uploads newest-first
// (validated live 2026-11-06 against the home feed's newest
// Asmongold TV upload).
//
// Phase 2 foundation (v3.13): a structured screen readout (SCREEN_JS,
// exposed as get_screen) captures what is ACTUALLY rendered — page
// type, focused element, and visible items with their targets — and
// navigation/search verification asserts against that rendered state.
// Route strings and internal flags are never accepted as success
// evidence: open_channel v1 set location.hash itself and then
// "verified" against that same hash while the screen never changed
// (live, 2026-11-06, three times).
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
const https = require('https')
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

// Parse an open_channel argument into what we know how to navigate to:
// a browseId (UC…) when the caller gave one (directly or via a
// /channel/UC… URL), a handle (@AsmonTV, bare or via a /@handle URL),
// or a plain channel/display name (resolved through search).
function channelTargetFrom(input) {
    if (!input) return null
    let str = String(input).trim()
    if (!str) return null

    if (/^UC[\w-]{22}$/.test(str)) return { browseId: str, handle: null, name: null }

    try {
        let url = new URL(str)
        let chan = url.pathname.match(/\/channel\/(UC[\w-]{22})/)
        if (chan) return { browseId: chan[1], handle: null, name: null, url: str }
        let handle = url.pathname.match(/\/@([\w.-]+)/)
        if (handle) return { browseId: null, handle: handle[1], name: null, url: str }
        let named = url.pathname.match(/\/(?:user|c)\/([\w.-]+)/)
        if (named) return { browseId: null, handle: null, name: named[1], url: str }
    } catch (err) {
        // not a URL — fall through
    }

    if (str.startsWith('@')) {
        let handle = str.slice(1).trim()
        if (/^[\w.-]+$/.test(handle)) return { browseId: null, handle, name: null }
    }
    if (/\s/.test(str)) return { browseId: null, handle: null, name: str }
    if (/^[\w.-]+$/.test(str)) return { browseId: null, handle: str, name: null }
    return { browseId: null, handle: null, name: str }
}

// Parse a rendered duration label ("12:34", "1:59:58") into seconds.
function parseDurationText(text) {
    if (!text) return null
    let m = String(text).trim().match(/^(\d{1,3}):(\d{2})(?::(\d{2}))?$/)
    if (!m) return null
    if (m[3] !== undefined) return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10)
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10)
}

// The creator table from CREATORS.md, baked in so name → channel
// resolution is instant and unambiguous (2026-11-06: the "Asmongold"
// Matt asks for is Asmongold TV, @AsmonTV — the channel actually named
// "Asmongold" is dormant and @AsmongoldTV does not exist). CREATORS.md
// stays the human source of truth; update both together. browseId is
// null where the UC… id has not been recorded yet — resolution then
// goes by handle/name, which open_channel handles.
const CREATORS = [
    { name: 'Asmongold TV', handle: 'AsmonTV', url: 'https://www.youtube.com/@AsmonTV', browseId: 'UCQeRaTukNYft1_6AZPACnog', aliases: ['asmongold', 'asmon', 'asmongold tv', 'admin gold', 'as gold', 'aspen gold'] },
    { name: 'Linus Tech Tips', handle: 'LinusTechTips', url: 'https://www.youtube.com/user/LinusTechTips', browseId: 'UCXuqSBlHAE6Xw-yeJA0Tunw', aliases: ['linus tech tips', 'linus', 'ltt', 'minus tech tips'] },
    { name: 'Tectone', handle: 'Tectone', url: 'https://www.youtube.com/@Tectone', browseId: 'UCPnSoX7NkOBcOX0Gfw_yjAw', aliases: ['tectone'] },
    { name: 'decoy', handle: 'decoy', url: 'https://www.youtube.com/@decoy', browseId: 'UCqN2iOW580CFSohYzruos2A', aliases: ['decoy', 'decoy voice', 'decoyvoice'] }
]

// Resolve any channel reference (creator name, dictation alias,
// handle, channel URL, UC… id) to a navigation target, preferring the
// creator table above.
function resolveChannelTarget(input) {
    let raw = String(input || '').trim()
    let key = raw.toLowerCase().replace(/^@/, '')
    for (let c of CREATORS) {
        if (c.handle.toLowerCase() === key || c.name.toLowerCase() === key || c.aliases.includes(key)) {
            return { browseId: c.browseId, handle: c.handle, name: c.name, creator: c.name, url: c.url }
        }
    }
    let t = channelTargetFrom(raw)
    if (t && t.handle) {
        for (let c of CREATORS) {
            if (c.handle.toLowerCase() === t.handle.toLowerCase()) {
                return { browseId: t.browseId || c.browseId, handle: c.handle, name: c.name, creator: c.name, url: t.url || c.url }
            }
        }
    }
    if (t && t.name) {
        let nk = t.name.toLowerCase()
        for (let c of CREATORS) {
            if (c.name.toLowerCase() === nk || c.handle.toLowerCase() === nk || c.aliases.includes(nk)) {
                return { browseId: c.browseId, handle: c.handle, name: c.name, creator: c.name, url: t.url || c.url }
            }
        }
    }
    return t
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

// ---------------------------------------------------------------------------
// Screen readout ("eyes") — the phase 2 foundation.
//
// A structured snapshot of what is ACTUALLY rendered right now: the
// page type, the channel header's identity when on a channel page,
// the focused element, the current search-box text, and the visible
// actionable items WITH their targets (each item's video/browse ID is
// dug from that item's OWN data subtree, so IDs cannot scramble
// across items the way whole-blob scraping did). Tools verify against
// this — never against route strings or internal flags.
// ---------------------------------------------------------------------------
const SCREEN_JS = `(() => {
    const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim()
    const timeRe = /^\\d{1,2}:\\d{2}(:\\d{2})?$/
    const ageRe = /(\\d+\\s*(?:second|minute|hour|day|week|month|year)s?\\s*ago|streamed\\s+\\d+\\s*\\w+\\s*ago|premiered|live now)/i
    const handleRe = /@([\\w.-]+)/
    const isVisible = (el) => {
        try {
            const r = el.getBoundingClientRect()
            return r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
        } catch (e) { return false }
    }
    const centerOf = (el) => {
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    }
    // Dig the targets an element points at out of its own data subtree
    // (the element itself first, then a few descendants, then one
    // parent hop — in that order, first hit wins per field).
    const digTargets = (el) => {
        const out = { isShort: false }
        const nodes = [el]
        try {
            const inner = el.querySelectorAll('*')
            for (let i = 0; i < inner.length && nodes.length < 14; i++) nodes.push(inner[i])
        } catch (e) {}
        if (el.parentElement) nodes.push(el.parentElement)
        for (const node of nodes) {
            if (out.videoId && out.browseId) break
            try {
                const d = node.data || node.__data
                if (!d) continue
                const s = JSON.stringify(d).slice(0, 24000)
                if (!out.videoId) {
                    const m = s.match(/"videoId":\\s*"([\\w-]{11})"/)
                    if (m) out.videoId = m[1]
                }
                if (!out.browseId) {
                    const m = s.match(/"(?:browseId|channelId)":\\s*"(UC[\\w-]{22})"/)
                    if (m) out.browseId = m[1]
                }
                if (!out.isShort && /reelWatch/.test(s)) out.isShort = true
            } catch (e) {}
        }
        return out
    }
    const describeEl = (el, source) => {
        const t = digTargets(el)
        const c = centerOf(el)
        return {
            tag: (el.tagName || '').toLowerCase(),
            label: clean(el.innerText || el.getAttribute('aria-label') || '').slice(0, 140) || null,
            videoId: t.videoId || null,
            browseId: t.browseId || null,
            x: c.x, y: c.y,
            source
        }
    }

    const bodyText = clean(document.body ? document.body.innerText : '')
    const lower = bodyText.toLowerCase()

    // -- channel header: the rendered identity of a channel page.
    // Several nested elements can carry 'channel' tags (up to the page
    // root, whose text is the whole page) — prefer the SMALLEST
    // element that carries a handle or a subscriber count.
    let channelHeader = null
    try {
        const cands = []
        for (const el of document.querySelectorAll('*')) {
            const tag = (el.tagName || '').toLowerCase()
            if (!tag.includes('channel')) continue
            if (!isVisible(el)) continue
            const text = clean(el.innerText || '')
            if (text.length < 2) continue
            cands.push({ el, text })
        }
        const matching = cands.filter(c => handleRe.test(c.text) || /subscribers/i.test(c.text))
        matching.sort((a, b) => a.text.length - b.text.length)
        cands.sort((a, b) => a.text.length - b.text.length)
        const pick = matching[0] || cands[0]
        if (pick) {
            const lines = (pick.el.innerText || '').split('\\n').map(clean).filter(Boolean)
            const hm = pick.text.match(handleRe)
            const sm = pick.text.match(/([\\d.,]+\\s*[KM]?)\\s*subscribers/i)
            const t = digTargets(pick.el)
            channelHeader = {
                name: lines[0] || null,
                handle: hm ? hm[1] : null,
                subscribers: sm ? sm[1] : null,
                browseId: t.browseId || null,
                text: pick.text.slice(0, 300)
            }
        }
    } catch (e) {}

    // -- visible actionable items, each with its own target
    const items = []
    try {
        const els = document.querySelectorAll('YTLR-TILE-RENDERER, YTLR-AVATAR-LOCKUP, YTLR-GRID-TILE-RENDERER')
        for (const el of els) {
            if (items.length >= 24) break
            if (!isVisible(el)) continue
            const raw = el.innerText || ''
            const lines = raw.split('\\n').map(clean).filter(Boolean)
            if (lines.length === 0) continue
            const t = digTargets(el)
            const flat = clean(raw)
            let durationText = null
            for (const ln of lines) { if (timeRe.test(ln)) { durationText = ln; break } }
            if (!durationText) {
                const m = flat.match(/\\b\\d{1,2}:\\d{2}(:\\d{2})?\\b/)
                if (m) durationText = m[0]
            }
            const am = flat.match(ageRe)
            const hm = flat.match(handleRe)
            let type = 'item'
            if (t.videoId) type = 'video'
            else if (t.browseId || hm) type = 'channel'
            const c = centerOf(el)
            items.push({
                type,
                title: lines[0].slice(0, 200),
                videoId: t.videoId || null,
                browseId: t.browseId || null,
                handle: hm ? hm[1] : null,
                durationText,
                ageText: am ? am[0] : null,
                isShort: !!t.isShort,
                focused: !!(el.classList && (el.classList.contains('focused') || el.querySelector('.focused') !== null)),
                x: c.x, y: c.y,
                text: flat.slice(0, 300)
            })
        }
    } catch (e) {}

    // -- focused element (best effort: real focus first, then the
    // framework's focus marker class)
    let focused = null
    try {
        const ae = document.activeElement
        if (ae && ae !== document.body && ae !== document.documentElement && isVisible(ae)) {
            focused = describeEl(ae, 'activeElement')
        }
    } catch (e) {}
    if (!focused) {
        try {
            for (const el of document.querySelectorAll('.focused, [data-focused="true"]')) {
                if (isVisible(el)) { focused = describeEl(el, 'focus-class'); break }
            }
        } catch (e) {}
    }

    // -- search box text ('' when the box shows its placeholder)
    let searchBoxText = null
    try {
        const box = document.querySelector('YTLR-SEARCH-TEXT-BOX, YTLR-TEXT-BOX')
        if (box) {
            const t = clean(box.innerText || '')
            searchBoxText = (t === 'Search') ? '' : t
        }
    } catch (e) {}

    // -- page classification, from rendered evidence only
    let watchActive = false
    try {
        const wp = document.querySelector('YTLR-WATCH-PAGE')
        if (wp) {
            const r = wp.getBoundingClientRect()
            watchActive = r.width > 100 && r.height > 100
        }
    } catch (e) {}
    const hasSearchUi = !!document.querySelector('YTLR-SEARCH-KEYBOARD, YTLR-SEARCH-TEXT-BOX, YTLR-SEARCH-RESULTS, YTLR-SEARCH-RESPONSE-RENDERER')
    let page = 'unknown'
    if (lower.includes('watch as guest') || lower.includes("who's watching") || lower.includes('who is watching') || lower.includes('add account')) page = 'account-picker'
    else if (watchActive) page = 'watch'
    else if (hasSearchUi) page = 'search'
    else if (channelHeader) page = 'channel'
    else if (items.length > 0) page = 'browse'

    let dialog = null
    try {
        for (const el of document.querySelectorAll('[role="dialog"], [role="alertdialog"]')) {
            if (isVisible(el)) { dialog = clean(el.innerText || el.textContent || '').slice(0, 160) || true; break }
        }
    } catch (e) {}

    return {
        page,
        href: location.href,
        hash: location.hash || '',
        focused,
        channelHeader,
        searchBoxText,
        items,
        dialog,
        pageText: bodyText.slice(0, 300)
    }
})()`

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

async function screenSnapshot(webContents) {
    return await evalJS(webContents, SCREEN_JS)
}

// Assert-rendered-state check for channel pages: the RENDERED page
// must be a channel page whose header identifies the target channel
// AND which shows that channel's videos. Route strings are never
// accepted as evidence (open_channel v1 set location.hash itself and
// then "verified" against that same hash — the screen never changed).
// A route pointing at a DIFFERENT channel vetoes an otherwise
// matching header (a stale route from an earlier navigation).
function channelScreenMatches(screen, target) {
    if (!screen || screen.page !== 'channel' || !screen.channelHeader) return false
    let h = screen.channelHeader
    let identity = false
    if (target.browseId && h.browseId && h.browseId === target.browseId) identity = true
    if (!identity && target.handle && h.handle && h.handle.toLowerCase() === target.handle.toLowerCase()) identity = true
    if (!identity && target.name && h.name && h.name.toLowerCase() === target.name.toLowerCase()) identity = true
    if (!identity && target.name && h.name && h.name.toLowerCase().includes(target.name.toLowerCase())) identity = true
    if (!identity) return false
    let hash = (screen.hash || '').toLowerCase()
    let hm = hash.match(/@([\w.-]+)/)
    if (hm && target.handle && hm[1] !== target.handle.toLowerCase()) return false
    let cm = hash.match(/channel\/(uc[\w-]{22})/)
    if (cm && target.browseId && cm[1] !== target.browseId.toLowerCase()) return false
    let vids = (screen.items || []).filter(i => i.type === 'video' && i.title)
    return vids.length >= 1
}

// Compact form of a screen snapshot for tool outputs / diagnostics.
function screenDigest(screen) {
    if (!screen) return null
    return {
        page: screen.page,
        focused: screen.focused ? (screen.focused.label || screen.focused.tag) : null,
        channelHeader: screen.channelHeader ? {
            name: screen.channelHeader.name,
            handle: screen.channelHeader.handle,
            browseId: screen.channelHeader.browseId
        } : null,
        itemCount: (screen.items || []).length,
        firstItems: (screen.items || []).slice(0, 5).map(i => ({
            type: i.type, title: i.title, videoId: i.videoId, durationText: i.durationText
        }))
    }
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
            if (!entered) {
                // The search screen (and other overlays) have no browse
                // tiles to click — Escape back to a browse screen first,
                // then retry. This is the search → play-result flow.
                tapKey(webContents, 'Escape')
                await sleep(900)
                entered = await enterWatchView(webContents, before)
                attempts.push({ strategy: 'enter-watch-view-after-escape', matched: entered })
            }
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
        'Report what VacuumTube is currently doing: the current video (from the player API — the URL does not follow programmatic switches), video state (paused, position, duration, volume), whether the watch screen is showing, a short page hint for diagnosing problems, the rendered page type (screenPage) and focused element from the screen readout, and the recent watch history (id, title, when it started) used by back(). For the full rendered snapshot — visible items with their targets — use get_screen.',
        {},
        async () => {
            let webContents = getWebContents()
            let p = await probe(webContents)
            let out = stateFromProbe(webContents, p)
            let screen = await screenSnapshot(webContents).catch(() => null)
            if (screen) {
                out.screenPage = screen.page
                out.focused = screen.focused ? (screen.focused.label || screen.focused.tag || null) : null
                if (screen.channelHeader) out.channelHeader = screen.channelHeader
            }
            out.history = context.history.list().slice(-10)
            return textResult(out)
        })

    register('get_screen',
        'Read the TV screen as structured data — the "eyes": the page type (browse / search / watch / channel / account-picker / unknown) classified from what is rendered, the channel header identity when on a channel page, the focused element (label + target + position), the current search-box text, and the visible items WITH their actionable targets (video IDs, channel handles/browse IDs, durations, positions for trusted clicks). This rendered state is the ground truth the other tools verify against.',
        {},
        async () => {
            let webContents = getWebContents()
            let screen = await screenSnapshot(webContents)
            return textResult({ ok: true, url: webContents.getURL(), ...screen })
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
        'Open the YouTube TV search screen, type the query, and return the top results (title + video ID). Results are verified to belong to this query — the search response must provably refresh after typing — and the tool errors rather than returning stale results.',
        {
            query: z.string().describe('Search query'),
            openChannel: z.boolean().optional().describe('After returning verified results, also open the channel entry (@handle) shown in the results — the creator-search flow: the channel page\'s first tile is its newest video. The resulting page state is reported in openedChannel.')
        },
        async ({ query, openChannel }) => {
            let q = String(query || '').trim()
            if (!q) return errorResult('search query is empty')
            let webContents = getWebContents()

            // If the TV is sitting on the Who's Watching profile
            // picker, searching is meaningless: there is no search
            // pill, typing goes into the void, and any "results" would
            // be whatever list the page store happens to hold (all
            // observed live after an app relaunch). Fail clearly.
            let pickerVisible = (p) => {
                if (!p) return false
                const t = ((p.pageText || '') + ' ' + (p.dialog || '')).toLowerCase()
                return t.includes('watch as guest') || t.includes('add account') ||
                    t.includes("who's watching") || t.includes('who is watching')
            }

            // The search pill only exists on browse screens. If a video
            // is in front, leave the watch screen first (Escape), or the
            // click below finds nothing and the search silently no-ops.
            let startProbe = await probe(webContents).catch(() => null)
            if (pickerVisible(startProbe)) {
                return errorResult('search unavailable: the TV is on the "Who\'s Watching" profile picker — select a profile on the TV first, then retry the search')
            }
            if (startProbe && startProbe.watchView && startProbe.watchView.active) {
                tapKey(webContents, 'Escape')
                let escDeadline = Date.now() + 6000
                while (Date.now() < escDeadline) {
                    await sleep(300)
                    let p = await probe(webContents).catch(() => null)
                    if (p && (!p.watchView || !p.watchView.active)) break
                }
            }
            // Repeat-search reset: if the app is ALREADY on the search
            // screen showing a previous query's results, typing into
            // that layered view proved unreliable live (v3.9/v3.10
            // acceptance: follow-up searches typed and "submitted" but
            // the response never refreshed — the renderer and header
            // stayed on the previous query). Escape back to a browse
            // screen and re-enter search fresh, every call.
            if (startProbe && (startProbe.hash || '').startsWith('#/search')) {
                for (let i = 0; i < 2; i++) {
                    tapKey(webContents, 'Escape')
                    await sleep(800)
                    let p = await probe(webContents).catch(() => null)
                    if (!p || !(p.hash || '').startsWith('#/search')) break
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
            // Full search-page scan: every search-response renderer's
            // data fingerprint + structurally parsed results, the
            // results actually visible on screen, and the page header.
            // Used for the pre-typing snapshot and for the post-typing
            // verification below (v3.8) — a single scan shape for both,
            // so "what changed" is directly comparable.
            let scanSearch = async () => await evalJS(webContents, `(() => {
                const fnv = (s) => {
                    let h = 0x811c9dc5
                    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
                    return (h >>> 0).toString(16) + ':' + s.length
                }
                const titleText = (t) => {
                    if (!t) return null
                    if (typeof t.simpleText === 'string') return t.simpleText
                    if (Array.isArray(t.runs)) return t.runs.map(r => r.text || '').join('')
                    // LockupViewModel titles are { content: "..." } —
                    // no simpleText/runs. Missing this made pairing
                    // return zero on the real response (live diag:
                    // contentType LOCKUP_CONTENT_TYPE_VIDEO).
                    if (typeof t.content === 'string' && t.content) return t.content
                    return null
                }
                const idRe = /^[\\w-]{11}$/
                // Find a title within an item's own subtree. Leanback
                // items are tileRenderers: the ID is contentId on the
                // item, but the title lives deeper, at
                // metadata.tileMetadata.title — NOT on the item object
                // itself (v3.8 looked only at direct props and paired
                // nothing on the real response; found in live
                // acceptance). Depth-capped so a nested item's title
                // is not borrowed.
                const findTitle = (node, depth) => {
                    if (!node || typeof node !== 'object' || depth > 4) return null
                    if (Array.isArray(node)) {
                        for (const c of node) { const t = findTitle(c, depth + 1); if (t) return t }
                        return null
                    }
                    const direct = titleText(node.title) || titleText(node.headline)
                    if (direct) return direct
                    for (const k of Object.keys(node)) {
                        if (k === 'title' || k === 'headline') continue
                        const t = findTitle(node[k], depth + 1)
                        if (t) return t
                    }
                    return null
                }
                // Pair each video ID with the title from the SAME item
                // object. (The v3.3 approach regex-zipped every videoId
                // and every title in the whole stringified response;
                // extra shelves in that blob scramble the pairings.)
                const extractPairs = (data) => {
                    const pairs = []
                    const seen = new Set()
                    let nodes = 0
                    const walk = (node, depth) => {
                        if (!node || typeof node !== 'object' || pairs.length >= 10 || depth > 14 || ++nodes > 60000) return
                        if (Array.isArray(node)) {
                            for (const c of node) { walk(c, depth + 1); if (pairs.length >= 10) return }
                            return
                        }
                        let id = null
                        for (const k of ['videoId', 'contentId']) {
                            if (typeof node[k] === 'string' && idRe.test(node[k])) { id = node[k]; break }
                        }
                        if (id) {
                            const t = findTitle(node, 0)
                            if (t) {
                                if (!seen.has(id)) { seen.add(id); pairs.push({ id, title: t }) }
                                return // an item object: do not descend into it
                            }
                        }
                        for (const k of Object.keys(node)) { walk(node[k], depth + 1); if (pairs.length >= 10) return }
                    }
                    walk(data, 0)
                    return pairs
                }
                // Channel entries in the same response (creator
                // searches surface the channel itself, e.g. 'Tectone
                // @Tectone'): an object carrying a channel/browse ID
                // (UC…) and a title, with no video ID of its own.
                const chanRe = /^UC[\\w-]{22}$/
                const extractChannels = (data) => {
                    const chans = []
                    const seen = new Set()
                    let nodes = 0
                    const walk = (node, depth) => {
                        if (!node || typeof node !== 'object' || chans.length >= 5 || depth > 14 || ++nodes > 30000) return
                        if (Array.isArray(node)) {
                            for (const c of node) { walk(c, depth + 1); if (chans.length >= 5) return }
                            return
                        }
                        let id = null
                        for (const k of ['channelId', 'browseId']) {
                            if (typeof node[k] === 'string' && chanRe.test(node[k])) { id = node[k]; break }
                        }
                        // Lockup channel entries carry the UC id as
                        // contentId with a CHANNEL contentType instead.
                        if (!id && typeof node.contentId === 'string' && chanRe.test(node.contentId) &&
                            typeof node.contentType === 'string' && node.contentType.includes('CHANNEL')) {
                            id = node.contentId
                        }
                        if (id && !node.videoId) {
                            const t = findTitle(node, 0)
                            if (t) {
                                if (!seen.has(id)) { seen.add(id); chans.push({ id, title: t }) }
                                return
                            }
                        }
                        for (const k of Object.keys(node)) { walk(node[k], depth + 1); if (chans.length >= 5) return }
                    }
                    walk(data, 0)
                    return chans
                }
                const renderers = []
                for (const el of document.querySelectorAll('YTLR-SEARCH-RESPONSE-RENDERER')) {
                    if (!el.data) { renderers.push({ fp: null, pairs: [], channels: [] }); continue }
                    let s = ''
                    try { s = JSON.stringify(el.data) } catch (e) {}
                    renderers.push({
                        fp: s ? fnv(s) : null,
                        pairs: s ? extractPairs(el.data) : [],
                        channels: s ? extractChannels(el.data) : []
                    })
                }
                // What is actually on screen (the v3.2 rendered scrape):
                // visible result titles, plus per-item IDs dug from each
                // rendered item's own data subtree (local to the item,
                // so they cannot scramble across items).
                const visibleTitles = []
                const lockupPairs = []
                const digId = (el) => {
                    let node = el
                    for (let i = 0; i < 3 && node; i++) {
                        try {
                            const d = node.data || node.__data
                            if (d) {
                                const m = JSON.stringify(d).slice(0, 12000).match(/"videoId":\\s*"([\\w-]{11})"/)
                                if (m) return m[1]
                            }
                        } catch (e) {}
                        node = node.parentElement
                    }
                    return null
                }
                let items = []
                for (const c of document.querySelectorAll('YTLR-SEARCH-RESULTS')) {
                    items.push(...c.querySelectorAll('YTLR-AVATAR-LOCKUP, YTLR-TILE-RENDERER'))
                }
                if (items.length === 0) items = Array.from(document.querySelectorAll('YTLR-TILE-RENDERER'))
                const seenL = new Set()
                const visibleChannels = []
                for (const el of items) {
                    const r = el.getBoundingClientRect()
                    if (r.width < 40 || r.height < 20) continue
                    const text = (el.innerText || '').replace(/\\s+/g, ' ').trim()
                    if (!text) continue
                    const title = (text.split(/(?=\\d+:\\d{2})|(?=LIVE)/)[0] || text).slice(0, 160)
                    // Containers masquerading as items leak the page
                    // header ("Search results for …") and huge text
                    // blobs into the visible list, which then vetoed
                    // good candidates. Real tiles are short and never
                    // start with the header text.
                    if (visibleTitles.length < 5 && text.length <= 400 &&
                        !title.toLowerCase().startsWith('search results for')) {
                        visibleTitles.push(title)
                    }
                    const id = digId(el)
                    if (id && !seenL.has(id) && lockupPairs.length < 10) {
                        seenL.add(id)
                        lockupPairs.push({ id, title })
                    }
                    // A rendered entry with an @handle and no video ID
                    // is a channel entry in the results list.
                    if (!id && /@[\\w.]+/.test(text) && visibleChannels.length < 5) {
                        visibleChannels.push({ title })
                    }
                }
                const bt = (document.body.innerText || '').replace(/\\s+/g, ' ')
                const hi = bt.toLowerCase().indexOf('search results for ')
                const header = hi < 0 ? null : bt.slice(hi + 19, hi + 80).trim().toLowerCase()
                let shape = null
                try {
                    const el0 = document.querySelector('YTLR-SEARCH-RESPONSE-RENDERER')
                    if (el0 && el0.data) {
                        const s0 = JSON.stringify(el0.data)
                        const iV = s0.indexOf('videoId')
                        const iC = s0.indexOf('contentId')
                        shape = {
                            len: s0.length, videoIdAt: iV, contentIdAt: iC,
                            videoCtx: iV >= 0 ? s0.slice(Math.max(0, iV - 120), iV + 160) : null,
                            contentCtx: iC >= 0 ? s0.slice(Math.max(0, iC - 120), iC + 220) : null,
                            keys: Object.keys(el0.data).slice(0, 20)
                        }
                    }
                } catch (e) {}
                return { renderers, visibleTitles, lockupPairs, visibleChannels, header, shape }
            })()`).catch(() => null)
            let searchSnapshot = null

            // After a SUBMITTED search the results view replaces the
            // on-screen keyboard — a follow-up search then finds no
            // clickable keys at all (live acceptance, v3.9: every
            // search after the first failed with "could not be
            // typed"). Clicking the search text box reopens the
            // keyboard; ensure it is present before clearing/typing.
            let ensureKeyboard = async () => {
                let hasKeys = async () => await evalJS(webContents, `(() => {
                    const kb = document.querySelector('YTLR-SEARCH-KEYBOARD')
                    if (!kb) return false
                    for (const el of kb.querySelectorAll('*')) {
                        if (el.children.length === 0 && el.textContent && el.textContent.trim() === 'A') {
                            const r = el.getBoundingClientRect()
                            if (r.width > 5 && r.height > 5) return true
                        }
                    }
                    return false
                })()`).catch(() => false)
                if (await hasKeys()) return true
                let box = await evalJS(webContents, `(() => {
                    for (const el of document.querySelectorAll('YTLR-SEARCH-TEXT-BOX, YTLR-TEXT-BOX')) {
                        const r = el.getBoundingClientRect()
                        if (r.width > 50 && r.height > 10) return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
                    }
                    return null
                })()`).catch(() => null)
                if (box) clickPoint(webContents, box.x, box.y)
                let kDeadline = Date.now() + 5000
                while (Date.now() < kDeadline) {
                    await sleep(300)
                    if (await hasKeys()) return true
                }
                return false
            }
            if (onSearch) await ensureKeyboard()

            // Own the search box: if the user (or an earlier search)
            // left text in it, clear it with the keyboard's CLEAR key
            // and verify the box is empty before typing — otherwise the
            // new query would append to and mix with the old text.
            // (There is no text input element to set programmatically;
            // CLEAR is the app's own deterministic clear.)
            let existingQuery = null
            if (onSearch) {
                let readBox = async () => await evalJS(webContents, `(() => {
                    const box = document.querySelector('YTLR-SEARCH-TEXT-BOX, YTLR-TEXT-BOX')
                    if (!box) return ''
                    const t = (box.innerText || '').replace(/\\s+/g, ' ').trim()
                    return (t === 'Search') ? '' : t // 'Search' is the empty-box placeholder
                })()`).catch(() => '')
                existingQuery = await readBox()
                var foundQuery = existingQuery
                for (let attempt = 0; attempt < 3; attempt++) {
                    if (!existingQuery) break
                    await typeLabel('CLEAR')
                    await sleep(500)
                    existingQuery = await readBox()
                }
                // Snapshot the cleared search page BEFORE typing. The
                // acceptance logic below requires the results to
                // provably change against this snapshot in response to
                // this query — that binding is what the pre-v3.8 logic
                // lacked (it trusted the header alone).
                searchSnapshot = await scanSearch()
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
                    } else {
                        // Digits and symbols (incl. '@') live behind the
                        // &123 keyboard mode. (v3.14: this branch used to
                        // cover digits only and every other character —
                        // '@' included — was silently skipped, so a handle
                        // search like '@LinusTechTips' reached the box as
                        // 'linustechtips' and landed on wrong results.)
                        if (await typeLabel('&123')) {
                            await sleep(300)
                            if (await typeLabel(ch)) typed += ch
                            else skipped += ch
                            await typeLabel('ABC')
                        } else {
                            skipped += ch
                        }
                    }
                    await sleep(280)
                }
            }

            // Submit the search with the keyboard's SEARCH key.
            // Typing alone only fills the box and lists suggestions —
            // per Matt's live report the search must actually be
            // executed. Submitting also issues the definitive search
            // response for exactly this query, which the verification
            // below binds the returned results to.
            let submitted = false
            if (onSearch && typed) {
                submitted = await typeLabel('SEARCH')
                if (submitted) await sleep(900)
            }

            // Wait for the results — and VERIFY they belong to this
            // query (v3.8). The pre-v3.8 logic accepted the first
            // non-empty scrape once the "Search results for <query>"
            // header matched, but the header follows the search box,
            // not the response — and the scrape read the first
            // response renderer in the document and regex-zipped its
            // whole data blob. Live use returned a frozen list of
            // home-feed items, byte-identical across different
            // queries, with resultsForQuery=true. Acceptance now
            // requires ALL of:
            //   - the page header matches what was typed;
            //   - a candidate that is PROVABLY fresh for this call:
            //     a response renderer's data fingerprint changed vs
            //     the pre-typing snapshot; or the on-screen results
            //     changed and agree with the candidate's titles; or
            //     the rendered result items themselves (IDs and
            //     titles read per item, on screen);
            //   - the candidate is stable across two consecutive
            //     polls (typing/submitting produces intermediate
            //     states; the submitted response is the last one).
            // If nothing verifies before the deadline, the tool
            // errors honestly instead of returning wrong results.
            const normTitle = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase()
            const titleMatch = (a, b) => {
                a = normTitle(a); b = normTitle(b)
                if (!a || !b) return false
                return a.startsWith(b.slice(0, 24)) || b.startsWith(a.slice(0, 24))
            }
            // null = on-screen list unreadable (gate skipped).
            // Otherwise the first visible title must match and at
            // least half of the compared positions must agree.
            const agreeWithVisible = (pairs, visible) => {
                if (!visible || visible.length === 0) return null
                let n = Math.min(3, pairs.length, visible.length)
                if (n === 0) return false
                if (!titleMatch(pairs[0].title, visible[0])) return false
                let ok = 0
                for (let i = 0; i < n; i++) if (titleMatch(pairs[i].title, visible[i])) ok++
                return ok >= Math.ceil(n / 2)
            }

            let p = await probe(webContents).catch(() => null)
            if (!onSearch) {
                if (pickerVisible(p)) {
                    return errorResult('search unavailable: the TV is on the "Who\'s Watching" profile picker — select a profile on the TV first, then retry the search')
                }
                return errorResult('the search screen did not open, so the query was not typed. Page state: ' + JSON.stringify(p ? stateFromProbe(webContents, p) : {}))
            }
            if (!typed) {
                return errorResult('the query "' + q + '" could not be typed — no on-screen keyboard keys were clickable, so no search was executed')
            }

            let results = []
            let channels = []
            let resultsForQuery = false
            let resultsFresh = null
            let lastScan = null
            let lastKey = null
            let stablePolls = 0
            let rDeadline = Date.now() + 15000
            let want = typed.trim().toLowerCase()
            let nudged = false
            while (Date.now() < rDeadline) {
                let scan = await scanSearch()
                if (scan) {
                    lastScan = scan
                    let candidate = null
                    if (scan.header && scan.header.startsWith(want.slice(0, 24))) {
                        let snapFps = searchSnapshot ? searchSnapshot.renderers.map(r => r.fp) : []
                        let snapVisible = searchSnapshot ? JSON.stringify(searchSnapshot.visibleTitles) : null
                        let visibleChanged = scan.visibleTitles.length > 0 &&
                            JSON.stringify(scan.visibleTitles) !== snapVisible
                        for (let i = 0; i < scan.renderers.length; i++) {
                            let r = scan.renderers[i]
                            if (!r.pairs.length) continue
                            let agree = agreeWithVisible(r.pairs, scan.visibleTitles)
                            if (agree === false) continue
                            let fresh = i >= snapFps.length || snapFps[i] !== r.fp
                            if (fresh) {
                                candidate = { pairs: r.pairs, channels: r.channels || [], via: true, key: 'R' + i + ':' + r.fp }
                                break
                            }
                            if (!candidate && visibleChanged && agree === true) {
                                candidate = { pairs: r.pairs, channels: r.channels || [], via: 'visible-verified', key: 'V' + i + ':' + r.fp }
                            }
                        }
                        if (!candidate && visibleChanged && scan.lockupPairs.length > 0) {
                            candidate = {
                                pairs: scan.lockupPairs, channels: [], via: 'rendered',
                                key: 'L:' + scan.lockupPairs.map(x => x.id).join(',')
                            }
                        }
                    }
                    // Rendered-state binding (phase 2): when the
                    // on-screen items' IDs are readable, a data-store
                    // candidate that shares NO id with what is actually
                    // rendered is not this query's results, whatever
                    // its fingerprint did. (The 'rendered' candidate
                    // IS the on-screen items, so it is exempt; title
                    // agreement already gates 'visible-verified'.)
                    if (candidate && candidate.via === true && scan.lockupPairs.length > 0) {
                        const renderedIds = new Set(scan.lockupPairs.map(x => x.id))
                        if (!candidate.pairs.some(x => renderedIds.has(x.id))) {
                            candidate = null
                        }
                    }
                    if (candidate) {
                        if (candidate.key === lastKey) stablePolls++
                        else { lastKey = candidate.key; stablePolls = 1 }
                        if (stablePolls >= 2) {
                            results = candidate.pairs
                            channels = candidate.channels
                            if (channels.length === 0 && lastScan.visibleChannels && lastScan.visibleChannels.length > 0) {
                                channels = lastScan.visibleChannels
                            }
                            resultsForQuery = true
                            resultsFresh = candidate.via
                            break
                        }
                    } else {
                        lastKey = null
                        stablePolls = 0
                    }
                }
                if (!nudged && Date.now() > rDeadline - 6000) {
                    // ~9s in with nothing verified: the submit may not
                    // have executed in a reopened-keyboard view (live
                    // v3.10 finding). Re-submit once via the SEARCH key
                    // only — idempotent for the same query. NEVER an
                    // Enter key here: in this UI Enter ACTIVATES the
                    // focused result (v3.11 acceptance: the nudge's
                    // Enter opened the Tectone channel entry, then a
                    // Taiwan video, derailing both searches).
                    nudged = true
                    await typeLabel('SEARCH')
                    await sleep(900)
                }
                await sleep(700)
            }

            p = await probe(webContents).catch(() => null)
            if (!resultsForQuery) {
                let diag = {
                    query: q,
                    typedQuery: typed,
                    submitted,
                    headerSeen: lastScan ? lastScan.header : null,
                    shape: lastScan ? lastScan.shape : null,
                    renderersSeen: lastScan ? lastScan.renderers.length : 0,
                    rendererPairs: lastScan ? lastScan.renderers.map(r => r.pairs.length) : [],
                    visibleTitles: lastScan ? lastScan.visibleTitles : [],
                    ...(p ? stateFromProbe(webContents, p) : {})
                }
                return errorResult('search could not verify that the on-page results belong to "' + q + '" — the search response did not provably refresh for this query, so no results are returned rather than possibly-stale ones. Diagnostics: ' + JSON.stringify(diag))
            }

            let finalScreen = await screenSnapshot(webContents).catch(() => null)
            let out = {
                ok: true,
                query: q,
                typedQuery: typed,
                submitted,
                clearedExistingQuery: (typeof foundQuery !== 'undefined' && foundQuery) ? foundQuery : null,
                boxEmptyBeforeTyping: existingQuery === '',
                onSearchScreen: onSearch,
                screenPage: finalScreen ? finalScreen.page : null,
                resultsForQuery,
                resultsFresh,
                results,
                channels,
                ...(p ? stateFromProbe(webContents, p) : {})
            }
            if (skipped) out.skippedCharacters = skipped

            // Optional: open the channel entry from the results
            // (Matt's creator-search flow: select the channel, land
            // on its page — the newest video is its first tile). One
            // trusted click on the rendered channel lockup, the same
            // primitive as the search-pill click; the resulting page
            // state is reported back for the caller to act on.
            if (openChannel) {
                let pt = await evalJS(webContents, `(() => {
                    let items = []
                    for (const c of document.querySelectorAll('YTLR-SEARCH-RESULTS')) {
                        items.push(...c.querySelectorAll('YTLR-AVATAR-LOCKUP, YTLR-TILE-RENDERER'))
                    }
                    for (const el of items) {
                        const r = el.getBoundingClientRect()
                        if (r.width < 40 || r.height < 20) continue
                        const text = (el.innerText || '').replace(/\\s+/g, ' ')
                        if (/@[\\w.]+/.test(text)) {
                            return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), text: text.slice(0, 120) }
                        }
                    }
                    return null
                })()`).catch(() => null)
                if (pt) {
                    clickPoint(webContents, pt.x, pt.y)
                    await sleep(2500)
                    let p2 = await probe(webContents).catch(() => null)
                    out.openedChannel = { clicked: pt.text, ...(p2 ? stateFromProbe(webContents, p2) : {}) }
                } else {
                    out.openedChannel = { clicked: null, note: 'no channel entry (@handle) was visible in the rendered results' }
                }
            }
            return textResult(out)
        })

    // -- channel navigation core ------------------------------------------
    // Navigate the app to a channel page and PROVE it from the rendered
    // screen (channelScreenMatches: page type 'channel' + header
    // identity match + that channel's videos on screen). Hash-route
    // writes are GONE: the SPA ignores them, and v1 "verified" against
    // the hash it had just written itself while the view never moved
    // (live failure, 2026-11-06, three times). What remains are the
    // app's own mechanisms — elements carrying the channel's browse
    // endpoint, activated with trusted clicks (the primitive that
    // play_video's tile clicks and the search flow already prove),
    // the app's navigation event, and search + a trusted click on the
    // rendered channel entry. Throws with diagnostics on failure.
    // Fetch a URL as text (server-side; used for channel videos
    // pages and for resolving a handle to its UC... browseId from
    // the channel page's own markup).
    function fetchText(url, timeoutMs = 9000) {
        return new Promise((resolve, reject) => {
            let req = https.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9'
                }
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume()
                    resolve(fetchText(res.headers.location, timeoutMs))
                    return
                }
                if (res.statusCode !== 200) {
                    res.resume()
                    reject(new Error('HTTP ' + res.statusCode + ' for ' + url))
                    return
                }
                let chunks = []
                res.on('data', (c) => chunks.push(c))
                res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
                res.on('error', reject)
            })
            req.setTimeout(timeoutMs, () => req.destroy(new Error('fetch timed out: ' + url)))
            req.on('error', reject)
        })
    }

    // The channel's newest upload IDs, read from its own videos
    // page markup -- deterministic and search-free. (The RSS feed
    // endpoint 404s now -- verified 2026-11-06 from two networks,
    // even for channels whose own pages link it.) The page's
    // initial data lists uploads newest-first.
    async function latestChannelVideoIds(target, max = 3) {
        let url = null
        if (target.handle) url = `https://www.youtube.com/@${target.handle}/videos`
        else if (target.browseId) url = `https://www.youtube.com/channel/${target.browseId}/videos`
        else if (target.name) url = `https://www.youtube.com/user/${encodeURIComponent(target.name.replace(/\s+/g, ''))}/videos`
        if (!url) return []
        let html = await fetchText(url)
        let ids = []
        for (let m of html.matchAll(/"videoId":"([\w-]{11})"/g)) {
            if (!ids.includes(m[1])) ids.push(m[1])
            if (ids.length >= max) break
        }
        return ids
    }

    // Fill in a target's browseId when only a handle/name is known:
    // the channel page's markup carries its own channelId.
    async function resolveBrowseIdForTarget(target) {
        try {
            if (target.handle) {
                let html = await fetchText(`https://www.youtube.com/@${target.handle}`)
                let m = html.match(/"channelId":"(UC[\w-]{22})"/) || html.match(/\/channel\/(UC[\w-]{22})/)
                if (m) return m[1]
            }
            if (target.name) {
                let html = await fetchText(`https://www.youtube.com/user/${encodeURIComponent(target.name.replace(/\s+/g, ''))}`)
                let m = html.match(/"channelId":"(UC[\w-]{22})"/) || html.match(/\/channel\/(UC[\w-]{22})/)
                if (m) return m[1]
            }
        } catch (e) { /* best-effort; the strategies below still apply */ }
        return null
    }

    async function openChannelCore(target, rawLabel) {
        let webContents = getWebContents()
        let attempts = []

        let first = await screenSnapshot(webContents).catch(() => null)
        if (first && first.page === 'account-picker') {
            throw new Error('open_channel unavailable: the TV is on the "Who\'s Watching" profile picker — select a profile on the TV first, then retry')
        }
        if (first && channelScreenMatches(first, target)) {
            return { ok: true, verified: true, strategy: 'already-on-channel', attempts, screen: first }
        }

        let waitForChannelScreen = async (timeoutMs) => {
            let deadline = Date.now() + timeoutMs
            let last = await screenSnapshot(webContents).catch(() => null)
            while (!channelScreenMatches(last, target) && Date.now() < deadline) {
                await sleep(400)
                last = await screenSnapshot(webContents).catch(() => last)
            }
            return { matched: channelScreenMatches(last, target), screen: last }
        }

        // Pause anything playing in the page (a channel page's
        // featured video autoplays within seconds and takes the
        // screen over -- Matt's rule is to kill it immediately).
        let pauseAnyMedia = async () => await evalJS(webContents, `(() => {
            let n = 0
            for (const v of document.querySelectorAll('video')) {
                try { if (!v.paused) { v.pause(); n++ } } catch (e) {}
            }
            return n
        })()`).catch(() => 0)

        // Smallest visible element whose own data references the
        // channel (optionally scoped to a subtree). Subscribe buttons
        // also carry the channel ID in their data — never click those.
        let findEndpointPoint = async (scopeSelector) => await evalJS(webContents, `(() => {
            const want = ${JSON.stringify(target.browseId)}
            const scopeSel = ${JSON.stringify(scopeSelector || '')}
            const scope = scopeSel ? (document.querySelector(scopeSel) || document) : document
            let best = null, bestArea = Infinity
            for (const el of scope.querySelectorAll('*')) {
                if (((el.innerText || '')).toLowerCase().includes('subscribe')) continue
                let hit = false
                try {
                    const d = el.data || el.__data
                    if (d && JSON.stringify(d).slice(0, 20000).includes(want)) hit = true
                } catch (e) {}
                if (!hit) {
                    const href = el.getAttribute && (el.getAttribute('href') || '')
                    if (href && href.includes(want)) hit = true
                }
                if (!hit) continue
                const r = el.getBoundingClientRect()
                if (r.width > 30 && r.height > 12 && r.bottom > 0 && r.top < innerHeight && r.left < innerWidth) {
                    const area = r.width * r.height
                    if (area < bestArea) { bestArea = area; best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }
                }
            }
            return best
        })()`).catch(() => null)

        // -- Strategy A (v3.16, PRIMARY): the video-byline hop.
        // The app's own path to a channel is through one of its
        // videos: load the channel's newest upload (its videos
        // page -- deterministic, no search), pause it, and click the watch
        // page's byline element, whose data carries the channel's
        // browseId (proven live 2026-11-06: the focused byline
        // element on Asmongold TV's video carried UCQeRaTuk...).
        // Runs FIRST: every other navigation attempt destroys the
        // watch page this strategy depends on.
        {
            let hopBrowseId = target.browseId || await resolveBrowseIdForTarget(target)
            attempts.push({ strategy: 'video-byline', browseId: hopBrowseId || null })
            if (hopBrowseId) {
                if (!target.browseId) target = { ...target, browseId: hopBrowseId }
                let hopIds = await latestChannelVideoIds(target).catch(() => [])
                attempts.push({ strategy: 'video-byline', videoIds: hopIds })
                let findBylinePoint = async () => await evalJS(webContents, `(() => {
                    const want = ${JSON.stringify(hopBrowseId)}
                    let best = null, bestArea = Infinity
                    for (const el of document.querySelectorAll('YTLR-WATCH-PAGE *')) {
                        let hit = false
                        try {
                            const d = el.data || el.__data
                            if (d) {
                                const js = JSON.stringify(d)
                                if (js && js.length < 300000 && js.includes(want)) hit = true
                            }
                        } catch (e) {}
                        if (!hit) {
                            const href = el.getAttribute && (el.getAttribute('href') || '')
                            if (href && href.includes(want)) hit = true
                        }
                        if (!hit) continue
                        const ownText = (el.textContent || '').trim()
                        if (ownText === 'Subscribe' || ownText === 'Subscribed') continue
                        const r = el.getBoundingClientRect()
                        if (r.width > 10 && r.height > 8 && r.bottom > 0 && r.top < innerHeight && r.left < innerWidth) {
                            const area = r.width * r.height
                            if (area < bestArea) { bestArea = area; best = { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) } }
                        }
                    }
                    return best
                })()`).catch(() => null)
                for (let hopId of hopIds.slice(0, 2)) {
                    let pr = await playVideoCore(hopId, { record: false }).catch(() => null)
                    attempts.push({ strategy: 'video-byline', playedVideoId: hopId, played: !!(pr && pr.ok) })
                    if (!pr || !pr.ok) continue
                    await pauseAnyMedia()
                    let pt = await findBylinePoint()
                    if (!pt) pt = await findEndpointPoint('YTLR-WATCH-PAGE')
                    attempts.push({ strategy: 'video-byline', bylinePoint: !!pt })
                    if (!pt) continue
                    clickPoint(webContents, pt.x, pt.y)
                    let r = await waitForChannelScreen(7000)
                    if (r.matched) return { ok: true, verified: true, strategy: 'video-byline', attempts, screen: r.screen }
                }
            }
        }

        // -- Strategy 1 (watch screens, browseId known): the watch
        // page's channel byline carries the browse endpoint — clicking
        // it is the app's own path from a video to its channel.
        if (target.browseId && first && first.page === 'watch') {
            let pt = await findEndpointPoint('YTLR-WATCH-PAGE')
            attempts.push({ strategy: 'watch-byline-click', found: !!pt })
            if (pt) {
                clickPoint(webContents, pt.x, pt.y)
                let r = await waitForChannelScreen(6000)
                if (r.matched) return { ok: true, verified: true, strategy: 'watch-byline-click', attempts, screen: r.screen }
            }
        }

        // -- Strategy 2 (browseId known): trusted click on the
        // smallest in-page element referencing this channel (e.g. a
        // channel tile/avatar on the current browse screen).
        if (target.browseId) {
            let pt = await findEndpointPoint(null)
            attempts.push({ strategy: 'endpoint-element-click', found: !!pt })
            if (pt) {
                clickPoint(webContents, pt.x, pt.y)
                let r = await waitForChannelScreen(5000)
                if (r.matched) return { ok: true, verified: true, strategy: 'endpoint-element-click', attempts, screen: r.screen }
            }

            // -- Strategy 3: dispatch the app's navigation event with
            // a browse endpoint. Speculative — the framework may not
            // listen for it — but now harmless: only the rendered
            // assertion can call it a success.
            let fired = await evalJS(webContents, `(() => {
                const endpoint = { browseEndpoint: { browseId: ${JSON.stringify(target.browseId)} } }
                const detail = { endpoint, browseEndpoint: endpoint.browseEndpoint }
                const fired = []
                const fire = (node, label) => {
                    try { node.dispatchEvent(new CustomEvent('yt-navigate', { bubbles: true, composed: true, detail })); fired.push(label) } catch (e) {}
                    try { node.dispatchEvent(new CustomEvent('yt-navigate-start', { bubbles: true, composed: true, detail })); } catch (e) {}
                }
                fire(document, 'document')
                fire(window, 'window')
                const app = document.querySelector('ytlr-app, ytlr-tv')
                if (app) fire(app, 'app')
                return fired
            })()`).catch(() => [])
            attempts.push({ strategy: 'navigate-event', fired })
            let r = await waitForChannelScreen(4000)
            if (r.matched) return { ok: true, verified: true, strategy: 'navigate-event', attempts, screen: r.screen }
        }

        // -- Strategy 4 (LAST RESORT -- demoted in v3.16: this SPA
        // does not route channels by URL; kept only as a harmless
        // final attempt. In v3.15 this ran first and sabotaged the
        // byline strategy by destroying the watch page.)
        // Originally Strategy 0 (Matt's rule, 2026-11-06): navigate DIRECTLY
        // to the channel's saved URL. Search is never used to reach
        // a channel -- result layouts differ per channel and bury
        // entries (LTT's members shelf pushes his entry 3 rows
        // down). The app routes by hash, so the channel path is
        // applied as the app's route: hash first (cheap), then a
        // full load of the app on that route (the same fallback
        // pair play_video uses). Only the rendered-state assertion
        // can call either a success.
        let directUrl = target.url ||
            (target.browseId ? `https://www.youtube.com/channel/${target.browseId}` :
             target.handle ? `https://www.youtube.com/@${target.handle}` :
             target.name ? `https://www.youtube.com/user/${encodeURIComponent(target.name.replace(/\s+/g, ''))}` : null)
        if (directUrl) {
            let directPath = ''
            try { directPath = new URL(directUrl).pathname } catch (e) {}
            if (directPath) {
                if (first && first.page === 'watch') {
                    tapKey(webContents, 'Escape')
                    await sleep(900)
                }
                let chanHash = '#' + directPath
                await pauseAnyMedia()
                await evalJS(webContents, `location.hash = ${JSON.stringify(chanHash)}; true`).catch(() => {})
                let r = await waitForChannelScreen(6000)
                attempts.push({ strategy: 'direct-url-hash', url: directUrl, matched: r.matched })
                if (r.matched) return { ok: true, verified: true, strategy: 'direct-url-hash', attempts, screen: r.screen }
                await webContents.loadURL(`${youtubeUrl}${chanHash}`, { userAgent: youtubeClientUserAgent }).catch(() => {})
                r = await waitForChannelScreen(9000)
                attempts.push({ strategy: 'direct-url-load', url: directUrl, matched: r.matched })
                if (r.matched) return { ok: true, verified: true, strategy: 'direct-url-load', attempts, screen: r.screen }
            }
        }

        // No search fallback: Matt's rule (2026-11-06) -- channels
        // are reached by direct URL only. If the direct route and
        // the browseId strategies above all fail, error honestly
        // below instead of falling back to search.

        let last = await screenSnapshot(webContents).catch(() => null)
        throw new Error('open_channel could not land on the channel page for "' + rawLabel + '" — no strategy passed the rendered-state assertion (page type channel + header identity + that channel\'s videos on screen). Diagnostics: ' + JSON.stringify({
            target, attempts, screen: screenDigest(last), pageText: last ? last.pageText : null
        }))
    }

    register('open_channel',
        'Navigate VacuumTube to a channel page and verify the landing against the RENDERED screen (channel header identity + that channel\'s videos on screen) — route strings are never accepted as proof, and the tool errors with a screen digest if nothing lands. Accepts a creator name or dictation alias ("Asmongold", "minus tech tips"), a handle (@AsmonTV), a channel ID (UC…), or a channel URL. Navigation uses the app\'s own path: the channel\'s newest upload (resolved from its videos page) is loaded and its byline clicked through to the channel page, with the browse-endpoint mechanisms and the saved-URL route as backups. Search is never used to reach a channel. On landing it pauses any autoplay and moves down 2 rows, ending parked on the Videos row with the newest upload focused.',
        { channel: z.string().describe('Creator name/alias, channel handle (@AsmonTV), channel ID (UC…), or channel URL') },
        async ({ channel }) => {
            let target = resolveChannelTarget(channel)
            if (!target) return errorResult(`Could not parse a channel from: ${channel}`)
            let r = await openChannelCore(target, String(channel))
            let webContents = getWebContents()
            // Matt's landing rule (2026-11-06): the moment the
            // channel page lands, pause any autoplay and move DOWN
            // 2 rows -- fast, before the featured video takes
            // over -- ending parked on the Videos row, newest
            // upload focused. Skipped when already on the channel
            // (focus could be anywhere; don't move it blindly).
            let parked = false
            if (r.strategy !== 'already-on-channel') {
                await evalJS(webContents, `(() => { for (const v of document.querySelectorAll('video')) { try { v.pause() } catch (e) {} } return true })()`).catch(() => {})
                tapKey(webContents, 'Down')
                await sleep(150)
                tapKey(webContents, 'Down')
                await sleep(700)
                let parkedScreen = await screenSnapshot(webContents).catch(() => null)
                if (parkedScreen && channelScreenMatches(parkedScreen, target)) {
                    r.screen = parkedScreen
                    parked = true
                }
            }
            return textResult({
                ok: true, verified: true, strategy: r.strategy, parked,
                channel: String(channel),
                ...(target.browseId ? { browseId: target.browseId } : {}),
                ...(target.handle ? { handle: target.handle } : {}),
                ...(target.name ? { name: target.name } : {}),
                attempts: r.attempts,
                channelHeader: r.screen ? r.screen.channelHeader : null,
                videos: r.screen ? r.screen.items.filter(i => i.type === 'video').slice(0, 10).map(i => ({ title: i.title, videoId: i.videoId, durationText: i.durationText })) : [],
                screen: screenDigest(r.screen),
                url: webContents.getURL()
            })
        })

    // Click a channel-page tab ("Videos", "Shorts", …) by its exact
    // rendered label — a trusted click, like every view-layer action
    // here. Only leaf elements with exactly the tab's text and only
    // the upper part of the screen qualify, so a video title can
    // never be mistaken for the tab.
    async function activateChannelTab(webContents, label) {
        let pt = await evalJS(webContents, `(() => {
            const want = ${JSON.stringify('__TAB__')}
            for (const el of document.querySelectorAll('*')) {
                if (el.children.length !== 0) continue
                if (!el.textContent || el.textContent.trim() !== want) continue
                let node = el
                for (let i = 0; i < 4 && node; i++) {
                    const r = node.getBoundingClientRect()
                    if (r.width > 40 && r.height > 14 && r.top >= 0 && r.top < innerHeight * 0.55) {
                        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
                    }
                    node = node.parentElement
                }
            }
            return null
        })()`.replace('__TAB__', label)).catch(() => null)
        if (!pt) return false
        clickPoint(webContents, pt.x, pt.y)
        await sleep(2000)
        return true
    }

    // Land on a channel page (asserted), switch to its Videos tab
    // when one is rendered, and read the uploads off the screen
    // readout — in on-screen order, which on the Videos tab is
    // newest first. This is the collection half of the "play what
    // <creator> posted today" feature (CREATORS.md feature 3).
    async function channelUploadsCore(channelArg, limit = 10) {
        let target = resolveChannelTarget(channelArg)
        if (!target) throw new Error(`Could not parse a channel from: ${channelArg}`)
        let webContents = getWebContents()
        let landedRes = await openChannelCore(target, String(channelArg))
        let tabUsed = 'channel-home'
        if (await activateChannelTab(webContents, 'Videos')) {
            tabUsed = 'videos-tab'
        }
        let screen = await screenSnapshot(webContents).catch(() => null)
        if (!screen || screen.page !== 'channel') {
            throw new Error('channel_uploads lost the channel page after landing (screen: ' +
                JSON.stringify(screenDigest(screen)) + ')')
        }
        let uploads = screen.items
            .filter(i => i.type === 'video' && i.videoId)
            .slice(0, Math.max(1, Math.min(30, limit)))
            .map(i => ({
                title: i.title,
                videoId: i.videoId,
                durationText: i.durationText,
                durationSeconds: parseDurationText(i.durationText),
                ageText: i.ageText,
                isShort: i.isShort
            }))
        return {
            ok: true,
            channel: {
                ...(target.name ? { name: target.name } : {}),
                ...(target.handle ? { handle: target.handle } : {}),
                ...(target.browseId ? { browseId: target.browseId } : {}),
                headerName: screen.channelHeader ? screen.channelHeader.name : null,
                headerHandle: screen.channelHeader ? screen.channelHeader.handle : null
            },
            navStrategy: landedRes.strategy,
            tabUsed,
            uploads,
            screen: screenDigest(screen)
        }
    }

    register('channel_uploads',
        'List a channel\'s uploads as rendered on its channel page (Videos tab when one is shown): title, video ID, duration, and age text for each, newest first. The channel-page landing is verified against the rendered screen first. Accepts a creator name/alias, a handle, a channel ID, or a URL.',
        {
            channel: z.string().describe('Creator name/alias, channel handle (@AsmonTV), channel ID (UC…), or channel URL'),
            limit: z.number().int().min(1).max(30).optional().describe('Max uploads to return (default 10)')
        },
        async ({ channel, limit }) => {
            let r = await channelUploadsCore(channel, limit || 10)
            return textResult(r)
        })

    register('latest_video',
        'Resolve a channel\'s newest regular upload — title, video ID, and duration — in one call, read from the channel\'s own page inside the app (no web lookup). Skips Shorts. With play: true it also plays the video (verified the same way play_video verifies). Accepts a creator name/alias ("Asmongold", "minus tech tips"), a handle, a channel ID, or a URL.',
        {
            channel: z.string().describe('Creator name/alias, channel handle (@AsmonTV), channel ID (UC…), or channel URL'),
            play: z.boolean().optional().describe('Also play the video after resolving it (default false)')
        },
        async ({ channel, play }) => {
            let r = await channelUploadsCore(channel, 12)
            let first = r.uploads.find(u => !u.isShort) || r.uploads[0] || null
            if (!first) {
                return errorResult('latest_video found no uploads on the channel page for "' + String(channel) + '". Screen: ' + JSON.stringify(r.screen))
            }
            let out = {
                ok: true,
                channel: r.channel,
                title: first.title,
                videoId: first.videoId,
                durationText: first.durationText,
                durationSeconds: first.durationSeconds,
                ageText: first.ageText,
                source: 'channel-page',
                tabUsed: r.tabUsed
            }
            if (play) {
                let pr = await playVideoCore(first.videoId, { record: true })
                out.played = !!pr.ok
                out.playResult = pr
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
