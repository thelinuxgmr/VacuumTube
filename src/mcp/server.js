// VacuumTube MCP control server
//
// An optional, token-gated MCP (Model Context Protocol) server that runs in
// the Electron main process and exposes a small set of high-level tools so an
// AI agent can control playback directly ("play this video", "what's
// playing?", "pause") instead of simulating remote-control button presses.
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

function createMcpServer({ getWindow }) {
    const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
    const { z } = require('zod')

    const server = new McpServer({
        name: 'vacuumtube',
        version: package.version
    })

    function getWebContents() {
        let win = typeof getWindow === 'function' ? getWindow() : null
        if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) {
            throw new Error('VacuumTube window is not available')
        }
        return win.webContents
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

    register('play_video',
        'Navigate VacuumTube to a YouTube video and start playing it. Accepts a video ID or any YouTube watch/share URL.',
        { video: z.string().describe('YouTube video ID or URL') },
        async ({ video }) => {
            let id = videoIdFrom(video)
            if (!id) return errorResult(`Could not extract a YouTube video ID from: ${video}`)

            let webContents = getWebContents()
            let watchHash = `#/watch?v=${id}`

            if (webContents.getURL().startsWith(youtubeUrl)) {
                await webContents.executeJavaScript(`location.hash = ${JSON.stringify(watchHash)}; true`)
            } else {
                await webContents.loadURL(`${youtubeUrl}${watchHash}`, { userAgent: youtubeClientUserAgent })
            }

            return textResult({ ok: true, videoId: id, url: `${youtubeUrl}${watchHash}` })
        })

    register('get_state',
        'Report what VacuumTube is currently doing: current URL, page title, and the video element state (paused, position, duration, volume) if a video is loaded.',
        {},
        async () => {
            let webContents = getWebContents()
            let state = await webContents.executeJavaScript(`(() => {
                const v = document.querySelector('video')
                return {
                    href: location.href,
                    title: document.title,
                    video: v ? {
                        paused: v.paused,
                        ended: v.ended,
                        currentTime: v.currentTime,
                        duration: (typeof v.duration === 'number' && isFinite(v.duration)) ? v.duration : null,
                        readyState: v.readyState,
                        volume: v.volume,
                        muted: v.muted,
                        currentSrc: v.currentSrc || null
                    } : null
                }
            })()`)
            return textResult({ ok: true, url: webContents.getURL(), ...state })
        })

    register('play',
        'Resume playback of the current video.',
        {},
        async () => {
            let webContents = getWebContents()
            let result = await webContents.executeJavaScript(`(async () => {
                const v = document.querySelector('video')
                if (!v) return { ok: false, error: 'no video element on the page' }
                try {
                    await v.play()
                    return { ok: true, paused: v.paused }
                } catch (e) {
                    return { ok: false, error: String((e && e.message) || e) }
                }
            })()`)
            return result && result.ok ? textResult(result) : errorResult(result ? result.error : 'play failed')
        })

    register('pause',
        'Pause the current video.',
        {},
        async () => {
            let webContents = getWebContents()
            let result = await webContents.executeJavaScript(`(() => {
                const v = document.querySelector('video')
                if (!v) return { ok: false, error: 'no video element on the page' }
                v.pause()
                return { ok: true, paused: v.paused }
            })()`)
            return result && result.ok ? textResult(result) : errorResult(result ? result.error : 'pause failed')
        })

    register('seek',
        'Seek the current video to an absolute position, in seconds.',
        { seconds: z.number().describe('Absolute position in seconds') },
        async ({ seconds }) => {
            let webContents = getWebContents()
            let target = Number(seconds)
            if (!isFinite(target) || target < 0) return errorResult(`Invalid seek position: ${seconds}`)
            let result = await webContents.executeJavaScript(`(() => {
                const v = document.querySelector('video')
                if (!v) return { ok: false, error: 'no video element on the page' }
                v.currentTime = ${JSON.stringify(target)}
                return { ok: true, currentTime: v.currentTime }
            })()`)
            return result && result.ok ? textResult(result) : errorResult(result ? result.error : 'seek failed')
        })

    register('set_volume',
        'Set playback volume from 0 (muted) to 100 (full).',
        { volume: z.number().min(0).max(100).describe('Volume 0-100') },
        async ({ volume }) => {
            let webContents = getWebContents()
            let level = Math.max(0, Math.min(100, Number(volume))) / 100
            let result = await webContents.executeJavaScript(`(() => {
                const v = document.querySelector('video')
                if (!v) return { ok: false, error: 'no video element on the page' }
                v.volume = ${JSON.stringify(level)}
                if (${JSON.stringify(level)} > 0) v.muted = false
                return { ok: true, volume: v.volume, muted: v.muted }
            })()`)
            return result && result.ok ? textResult(result) : errorResult(result ? result.error : 'set_volume failed')
        })

    register('navigate_home',
        'Navigate VacuumTube back to the YouTube TV home screen.',
        {},
        async () => {
            let webContents = getWebContents()
            if (webContents.getURL().startsWith(youtubeUrl)) {
                await webContents.executeJavaScript(`location.hash = '#/'; true`)
            } else {
                await webContents.loadURL(youtubeUrl, { userAgent: youtubeClientUserAgent })
            }
            return textResult({ ok: true, url: youtubeUrl })
        })

    return server
}

function start({ getWindow, userData } = {}) {
    let tokens = loadTokens(userData)
    if (tokens.length === 0) {
        console.log('[mcp] no tokens configured (set VACUUMTUBE_MCP_TOKENS or create mcp-tokens.json in userData); MCP server disabled')
        return null
    }

    const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js')

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
            // tools/call each work as one-shot requests).
            let mcpServer = createMcpServer({ getWindow })
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

    return httpServer
}

module.exports = { start }
