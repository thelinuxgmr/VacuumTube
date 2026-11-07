#!/usr/bin/env python3
"""VacuumTube MCP acceptance self-test (phase 2).

Runs the acceptance matrix against a LIVE MCP server and asserts the
RENDERED state at every step via get_screen — the same standard the
tools themselves now enforce. Intended to be run in a TV-free window
right after a deploy, so "fixed" is proven in one pass instead of
across a couch session.

Matrix:
  0. connect: initialize + tools/list (expects the v3.13 tool set)
  1. baseline: get_screen (aborts on the Who's Watching picker),
     navigate_home leaves the watch screen
  2. search "Asmongold"     -> verified results, IDs recorded
  3. search "Tectone"       -> verified results, distinct from step 2
  4. search "Taiwan travel" -> verified results, distinct from both
  5. open_channel "@AsmonTV" -> ok, then get_screen must show page
     'channel' with Asmongold's header and >= 1 video item
  6. latest_video "Asmongold" -> title + video ID + duration; then
     play_video on it and get_state/get_screen must show it playing
     on the watch screen
  7. play_video on the top Tectone search result
  8. back(1) -> the player must be back on the step-6 video
  9. navigate_home -> watch screen left

How to run (the server binds 127.0.0.1 ON THE TV LAPTOP only):
  On the TV:    python3 tools/selftest.py --token-file <file with token>
  From the VM:  ssh -L 8977:127.0.0.1:8977 tv@bazzite   (leave running)
                python3 tools/selftest.py --token-file ../.mcp-token-matt

Token sources, in order: --token, $VACUUMTUBE_MCP_TOKEN, --token-file,
$VACUUMTUBE_MCP_TOKEN_FILE, and <repo>/.mcp-token-matt if it exists.
URL: --url or $VACUUMTUBE_MCP_URL (default http://127.0.0.1:8977/mcp).

Exit code 0 = all steps passed (skips caused by an earlier failure
count as failures of the run: fix the root step first). Searches and
channel navigation type/click at human pace, so a full run takes a
few minutes. Nothing here is safe to run while someone is watching.
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Mcp:
    def __init__(self, url, token, timeout):
        self.url = url
        self.token = token
        self.timeout = timeout
        self._id = 0

    def rpc(self, method, params=None):
        self._id += 1
        body = {"jsonrpc": "2.0", "id": self._id, "method": method}
        if params is not None:
            body["params"] = params
        req = urllib.request.Request(
            self.url,
            data=json.dumps(body).encode(),
            headers={
                "Authorization": "Bearer " + self.token,
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            raw = resp.read().decode()
        # Streamable HTTP with JSON responses enabled returns plain
        # JSON; tolerate SSE framing anyway.
        for line in raw.splitlines():
            line = line.strip()
            if line.startswith("data:"):
                line = line[5:].strip()
            if line.startswith("{"):
                try:
                    return json.loads(line)
                except Exception:
                    pass
        raise RuntimeError("unparseable MCP response: " + raw[:200])

    def call_tool(self, name, arguments=None):
        """Returns the tool's parsed JSON payload. Raises on tool errors."""
        r = self.rpc("tools/call", {"name": name, "arguments": arguments or {}})
        result = r.get("result") or {}
        text = ""
        for part in result.get("content") or []:
            if part.get("type") == "text":
                text = part.get("text", "")
                break
        if result.get("isError"):
            raise RuntimeError(f"{name} errored: {text[:400]}")
        try:
            return json.loads(text)
        except Exception:
            raise RuntimeError(f"{name} returned non-JSON: {text[:200]}")


class StepFailure(AssertionError):
    pass


def check(cond, message):
    if not cond:
        raise StepFailure(message)


def main():
    ap = argparse.ArgumentParser(description="VacuumTube MCP acceptance self-test (see module docstring)")
    ap.add_argument("--url", default=os.environ.get("VACUUMTUBE_MCP_URL", "http://127.0.0.1:8977/mcp"))
    ap.add_argument("--token", default=os.environ.get("VACUUMTUBE_MCP_TOKEN"))
    ap.add_argument("--token-file", default=os.environ.get("VACUUMTUBE_MCP_TOKEN_FILE"))
    ap.add_argument("--timeout", type=int, default=180, help="per-request timeout seconds (default 180)")
    args = ap.parse_args()

    token = args.token
    token_file = args.token_file
    if not token and not token_file:
        candidate = os.path.join(REPO_ROOT, ".mcp-token-matt")
        if os.path.exists(candidate):
            token_file = candidate
    if not token and token_file:
        with open(token_file) as f:
            token = f.read().strip()
    if not token:
        print("FAIL: no token (use --token, --token-file, or set VACUUMTUBE_MCP_TOKEN)")
        return 2

    mcp = Mcp(args.url, token, args.timeout)
    state = {}
    results = []

    def run_step(name, fn, depends=None):
        if depends and not state.get(depends):
            results.append((name, "SKIP", f"dependency failed: {depends}"))
            print(f"SKIP {name} (dependency failed: {depends})")
            return
        try:
            detail = fn()
            state[name] = True
            results.append((name, "PASS", detail or ""))
            print(f"PASS {name}" + (f" — {detail}" if detail else ""))
        except Exception as e:
            state[name] = False
            results.append((name, "FAIL", str(e)))
            print(f"FAIL {name} — {e}")

    def step_connect():
        r = mcp.rpc("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                                   "clientInfo": {"name": "selftest", "version": "1"}})
        check("result" in r, f"initialize failed: {json.dumps(r)[:200]}")
        r = mcp.rpc("tools/list")
        names = [t["name"] for t in (r.get("result") or {}).get("tools", [])]
        for want in ("get_screen", "open_channel", "latest_video", "channel_uploads", "search", "play_video", "back"):
            check(want in names, f"tool missing from tools/list: {want} (got {names})")
        return f"{len(names)} tools"

    def step_baseline():
        s = mcp.call_tool("get_screen")
        check(s.get("page") != "account-picker",
              "TV is on the Who's Watching profile picker — pick a profile on the TV first")
        state["baseline_page"] = s.get("page")
        mcp.call_tool("navigate_home")
        s = mcp.call_tool("get_screen")
        check(s.get("page") != "watch", f"navigate_home left the watch screen up (page={s.get('page')})")
        return f"page={s.get('page')}"

    def make_search_step(key, query):
        def fn():
            out = mcp.call_tool("search", {"query": query})
            check(out.get("ok"), f"search not ok: {json.dumps(out)[:200]}")
            res = out.get("results") or []
            check(len(res) >= 1, "search returned zero results")
            ids = [r["id"] for r in res if r.get("id")]
            check(len(ids) >= 1, "search results carry no video IDs")
            check(out.get("resultsForQuery") is True, "resultsForQuery is not true")
            state[key] = {"ids": ids, "top_title": res[0].get("title")}
            return f"top: {res[0].get('title')!r} ({ids[0]}), {len(ids)} results"
        return fn

    def step_search_distinct():
        a, b, c = state["search_a"]["ids"], state["search_b"]["ids"], state["search_c"]["ids"]
        check(a[0] != b[0] and a[0] != c[0] and b[0] != c[0],
              f"top result IDs not distinct: A={a[0]} B={b[0]} C={c[0]}")
        check(set(a[:3]) != set(b[:3]) and set(a[:3]) != set(c[:3]),
              "result sets look recycled between queries (the v3.7 frozen-feed bug shape)")
        return "A/B/C distinct"

    def step_open_channel():
        out = mcp.call_tool("open_channel", {"channel": "@AsmonTV"})
        check(out.get("ok") and out.get("verified"), f"open_channel not verified: {json.dumps(out)[:200]}")
        s = mcp.call_tool("get_screen")
        check(s.get("page") == "channel", f"get_screen page is {s.get('page')!r}, not 'channel'")
        hdr = s.get("channelHeader") or {}
        identity = (hdr.get("handle") or "").lower() == "asmontv" or "asmongold" in (hdr.get("name") or "").lower()
        check(identity, f"channel header does not identify Asmongold TV: {json.dumps(hdr)[:200]}")
        vids = [i for i in (s.get("items") or []) if i.get("type") == "video"]
        check(len(vids) >= 1, "channel page shows no video items")
        return f"strategy={out.get('strategy')}, header={hdr.get('name')!r}, {len(vids)} videos on screen"

    def step_latest_and_play():
        out = mcp.call_tool("latest_video", {"channel": "Asmongold"})
        check(out.get("ok"), f"latest_video not ok: {json.dumps(out)[:200]}")
        vid = out.get("videoId")
        check(vid, "latest_video returned no videoId")
        check(out.get("durationSeconds"), f"latest_video returned no duration (got {out.get('durationText')!r})")
        state["latest"] = out
        mcp.call_tool("play_video", {"video": vid})
        st = mcp.call_tool("get_state")
        check(st.get("playerId") == vid or st.get("currentId") == vid,
              f"player is on {st.get('playerId') or st.get('currentId')}, expected {vid}")
        s = mcp.call_tool("get_screen")
        check(s.get("page") == "watch", f"screen page is {s.get('page')!r}, not 'watch'")
        return f"{out.get('title')!r} ({vid}, {out.get('durationText')}) playing"

    def step_play_second():
        vid_b = state["search_b"]["ids"][0]
        mcp.call_tool("play_video", {"video": vid_b})
        st = mcp.call_tool("get_state")
        check(st.get("playerId") == vid_b or st.get("currentId") == vid_b,
              f"player is on {st.get('playerId') or st.get('currentId')}, expected {vid_b}")
        return f"playing {vid_b}"

    def step_back():
        want = state["latest"]["videoId"]
        mcp.call_tool("back", {"steps": 1})
        st = mcp.call_tool("get_state")
        got = st.get("playerId") or st.get("currentId")
        check(got == want, f"back() landed on {got}, expected {want}")
        return f"back on {want}"

    def step_home():
        mcp.call_tool("navigate_home")
        s = mcp.call_tool("get_screen")
        check(s.get("page") != "watch", f"still on watch screen (page={s.get('page')})")
        return f"page={s.get('page')}"

    print(f"VacuumTube MCP self-test against {args.url}")
    run_step("connect", step_connect)
    run_step("baseline", step_baseline, depends="connect")
    run_step("search_a", make_search_step("search_a", "Asmongold"), depends="baseline")
    run_step("search_b", make_search_step("search_b", "Tectone"), depends="baseline")
    run_step("search_c", make_search_step("search_c", "Taiwan travel"), depends="baseline")
    run_step("search_distinct", step_search_distinct, depends="search_c")
    run_step("open_channel", step_open_channel, depends="baseline")
    run_step("latest_and_play", step_latest_and_play, depends="open_channel")
    run_step("play_second", step_play_second, depends="latest_and_play")
    run_step("back", step_back, depends="play_second")
    run_step("home", step_home, depends="connect")

    passed = sum(1 for _, s, _ in results if s == "PASS")
    failed = sum(1 for _, s, _ in results if s != "PASS")
    print(f"\n{passed} passed, {failed} failed/skipped, {len(results)} total")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
