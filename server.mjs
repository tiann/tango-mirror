#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, delimiter } from "node:path";
import { WebSocketServer } from "ws";
import { Adb, AdbServerClient } from "@yume-chan/adb";
import { AdbServerNodeTcpConnector } from "@yume-chan/adb-server-node-tcp";
import { AdbScrcpyClient, AdbScrcpyOptions3_1 } from "@yume-chan/adb-scrcpy";
import { ReadableStream } from "@yume-chan/stream-extra";
import { ScrcpyPointerId, ScrcpyInstanceId, AndroidMotionEventAction } from "@yume-chan/scrcpy";
import qrcode from "qrcode-terminal";
import { createRtcSession } from "./webrtc.mjs";

function argValue(...names) {
    for (const name of names) {
        const i = process.argv.indexOf(name);
        if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
    }
    return undefined;
}

const DEFAULT_PAGE = "https://weishu.me/tango-mirror/";
// tunwg's own default relay (l.tunwg.com) is unreachable, so default to a
// working one; --tunnel-api / TUNWG_API still win
const DEFAULT_TUNWG_RELAY = "relay.hapi.run";
const REPO_URL = "https://github.com/tiann/tango-mirror";

const HELP = `tango-mirror — view and control Android devices from a browser

Usage: tango-mirror [options]

Options:
  -p, --port <n>          HTTP/WebSocket listen port            (default 8010)
      --adb-host <host>   adb server host                  (default 127.0.0.1)
      --adb-port <n>      adb server port                       (default 5037)

      --shell             enable the device shell; requires a token, one is
                          generated if --token is absent (mirroring stays open)
      --token <value>     require this token for everything, viewing included
      --page <url>        frontend to redirect remote visitors to
                          (default ${DEFAULT_PAGE})
      --no-page           serve the bundled page instead of redirecting
      --no-qr             don't print the QR code for the public URL

      --tunnel [backend]  expose publicly; backend is cloudflared, tunwg,
                          or omitted to auto-detect (cloudflared preferred)
      --tunnel-api <host> tunwg relay server           (default ${DEFAULT_TUNWG_RELAY})
      --tunnel-auth <u:p> basic auth for the tunnel (tunwg only)

      --turn <target>     TURN relay for when direct P2P fails: "cloudflare"
                          (reads CF_TURN_KEY_ID + CF_TURN_API_TOKEN) or a
                          turn:/turns: URL used with --turn-auth
      --turn-auth <u:p>   credentials for a --turn turn:/turns: URL

  -h, --help              show this help
  -v, --version           show version

Environment:
  PORT, ADB_HOST, ADB_PORT, TANGO_TOKEN, TANGO_PAGE, TUNWG_API,
  TUNWG_BIN, CLOUDFLARED_PATH, TURN_URL, TURN_AUTH, CF_TURN_KEY_ID,
  CF_TURN_API_TOKEN

Examples:
  tango-mirror                                   # local only
  tango-mirror --tunnel                          # + public tunnel
  tango-mirror --shell --tunnel                  # + device shell (tokened)
  tango-mirror --tunnel --turn cloudflare        # fallback via Cloudflare TURN
  tango-mirror --shell --page https://me.github.io/tango-mirror/

The devices must already be visible to adb (adb connect <ip> / USB).
Docs: https://github.com/tiann/tango-mirror`;

if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(HELP);
    process.exit(0);
}
if (process.argv.includes("--version") || process.argv.includes("-v")) {
    const pkg = JSON.parse(
        await readFile(join(dirname(fileURLToPath(import.meta.url)), "package.json"), "utf8"),
    );
    console.log(pkg.version);
    process.exit(0);
}

// catch typo'd flags instead of silently ignoring them
const KNOWN_FLAGS = new Set([
    "--port", "-p", "--adb-host", "--adb-port", "--shell", "--token", "--page",
    "--tunnel", "--tunnel-api", "--tunnel-auth", "--turn", "--turn-auth",
    "--no-page", "--no-qr",
    "--help", "-h", "--version", "-v",
]);
for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("-") && !KNOWN_FLAGS.has(arg.split("=")[0])) {
        console.error(`unknown option: ${arg}\nrun with --help to see available options`);
        process.exit(1);
    }
}

const PORT = Number(argValue("--port", "-p") ?? process.env.PORT ?? 8010);
const ADB_HOST = argValue("--adb-host") ?? process.env.ADB_HOST ?? "127.0.0.1";
const ADB_PORT = Number(argValue("--adb-port") ?? process.env.ADB_PORT ?? 5037);
const VERSION = "3.1"; // must match the bundled server.bin
const SERVER_PATH = "/data/local/tmp/tango-scrcpy-server.jar";
const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(PKG_DIR, "public");

const SHELL_ENABLED = process.argv.includes("--shell");
const EXPLICIT_TOKEN = argValue("--token") ?? process.env.TANGO_TOKEN ?? "";
// an explicit token locks everything down; --shell alone only gates the
// shell, so mirroring stays as frictionless as before
const TOKEN = EXPLICIT_TOKEN || (SHELL_ENABLED ? randomBytes(16).toString("hex") : "");
const VIEW_NEEDS_TOKEN = Boolean(EXPLICIT_TOKEN);
// remote requests are redirected to DEFAULT_PAGE so the page assets come
// from a CDN instead of eating tunnel bandwidth
const PAGE_URL = process.argv.includes("--no-page")
    ? ""
    : argValue("--page") ?? process.env.TANGO_PAGE ?? DEFAULT_PAGE;

// Without TURN, a viewer that can't get a direct WebRTC path (symmetric
// NAT, CGNAT) falls back to video over the WebSocket — the whole stream
// rides the tunnel relay. With TURN the fallback stays on WebRTC, still
// DTLS-encrypted end to end; the relay forwards packets it cannot read.
const TURN_TARGET = argValue("--turn") ?? process.env.TURN_URL ?? "";
const TURN_AUTH = argValue("--turn-auth") ?? process.env.TURN_AUTH ?? "";
if (TURN_TARGET === "cloudflare") {
    if (!process.env.CF_TURN_KEY_ID || !process.env.CF_TURN_API_TOKEN) {
        console.error("--turn cloudflare needs CF_TURN_KEY_ID and CF_TURN_API_TOKEN in the environment");
        process.exit(1);
    }
} else if (/^turns?:/i.test(TURN_TARGET)) {
    if (!TURN_AUTH.includes(":")) {
        console.error("--turn with a turn:/turns: URL needs --turn-auth user:pass (or TURN_AUTH)");
        process.exit(1);
    }
} else if (TURN_TARGET) {
    console.error(`--turn: expected "cloudflare" or a turn:/turns: URL, got "${TURN_TARGET}"`);
    process.exit(1);
}
// static credentials resolve once; cloudflare mints on demand in turnServers()
const TURN_STATIC = /^turns?:/i.test(TURN_TARGET)
    ? [{
          urls: TURN_TARGET.split(",").map((u) => u.trim()),
          username: TURN_AUTH.slice(0, TURN_AUTH.indexOf(":")),
          credential: TURN_AUTH.slice(TURN_AUTH.indexOf(":") + 1),
      }]
    : null;

let turnCache = null;
async function turnServers() {
    if (!TURN_TARGET) return [];
    if (TURN_STATIC) return TURN_STATIC;
    if (turnCache && Date.now() < turnCache.expires) return turnCache.servers;
    const res = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
            method: "POST",
            headers: {
                authorization: `Bearer ${process.env.CF_TURN_API_TOKEN}`,
                "content-type": "application/json",
            },
            body: JSON.stringify({ ttl: 86400 }),
            signal: AbortSignal.timeout(5000),
        },
    );
    if (!res.ok) throw new Error(`cloudflare credentials: HTTP ${res.status}`);
    const raw = (await res.json()).iceServers ?? [];
    // keep only turn(s): urls — the page has STUN built in — and drop the
    // :53 variants, which browsers refuse to use
    const servers = (Array.isArray(raw) ? raw : [raw])
        .map((s) => ({
            ...s,
            urls: (Array.isArray(s.urls) ? s.urls : [s.urls])
                .filter((u) => /^turns?:/i.test(u) && !/:53(\D|$)/.test(u)),
        }))
        .filter((s) => s.urls.length);
    if (!servers.length) throw new Error("no turn(s): urls in cloudflare response");
    turnCache = { servers, expires: Date.now() + 12 * 3600 * 1000 }; // half the ttl
    return servers;
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

function isLocalRequest(req) {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    return LOCAL_HOST.test(host);
}

const TOKEN_PROTOCOL = "tango.token.";

function tokenValid(given) {
    if (!TOKEN) return true;
    if (typeof given !== "string") return false;
    const a = Buffer.from(given);
    const b = Buffer.from(TOKEN);
    return a.length === b.length && timingSafeEqual(a, b);
}

const adbClient = new AdbServerClient(
    new AdbServerNodeTcpConnector({ host: ADB_HOST, port: ADB_PORT }),
);

// prefer the server.bin bundled in this package; fall back to
// @yume-chan/fetch-scrcpy-server's download location (dev checkout)
async function loadServerBin() {
    const bundled = join(PKG_DIR, "server.bin");
    if (existsSync(bundled)) return new Uint8Array(await readFile(bundled));
    const { BIN } = await import("@yume-chan/fetch-scrcpy-server");
    const downloaded = fileURLToPath(BIN);
    if (existsSync(downloaded)) return new Uint8Array(await readFile(downloaded));
    console.error(`scrcpy server binary not found; run: npx fetch-scrcpy-server ${VERSION}`);
    process.exit(1);
}
const serverBin = await loadServerBin();

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function interstitial(target, zh) {
    const t = zh
        ? {
            title: "打开 tango-mirror",
            lead: "前端页面不通过隧道分发，以免占用隧道带宽（约 400 KB）。点击下面的链接从 CDN 打开，后端地址和 token 已经填好：",
            open: "打开控制台",
            selfHostTitle: "想用自己的前端？",
            selfHostIntro: "前端是两个静态文件（<code>public/index.html</code> 和 <code>public/app.js</code>），托管在任何静态服务上都行：",
            steps: [
                "Fork 或 clone 仓库：",
                "把 <code>public/</code> 部署到 GitHub Pages / Cloudflare Pages / Vercel 等（仓库里的 GitHub Actions 已经配好，push 即自动发布到 gh-pages 分支）",
                "启动时加 <code>--page https://你的地址/</code> 指向它",
            ],
            offline: "如果只在内网或离线使用，用 <code>--no-page</code> 让本服务直接提供页面，不依赖任何外部站点。",
        }
        : {
            title: "Open tango-mirror",
            lead: "The frontend isn't served through the tunnel, to keep ~400 KB of bundle off it. Open it from the CDN below — the backend address and token are already filled in:",
            open: "Open console",
            selfHostTitle: "Prefer your own frontend?",
            selfHostIntro: "The frontend is two static files (<code>public/index.html</code> and <code>public/app.js</code>), so any static host works:",
            steps: [
                "Fork or clone the repository:",
                "Deploy <code>public/</code> to GitHub Pages / Cloudflare Pages / Vercel (the repo ships a GitHub Action that publishes to the gh-pages branch on push)",
                "Start with <code>--page https://your-url/</code> pointing at it",
            ],
            offline: "For LAN-only or offline use, <code>--no-page</code> makes this server deliver the page itself, with no external site involved.",
        };
    return `<!DOCTYPE html><html lang="${zh ? "zh" : "en"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${t.title}</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100dvh;display:flex;align-items:center;
justify-content:center;padding:24px;background:#0f1115;color:#e6e8ec;font-family:system-ui,sans-serif}
main{max-width:34rem}h1{font-size:1.25rem;margin:0 0 .75rem}p{line-height:1.6;color:#aab2c0;margin:0 0 1rem}
a.btn{display:inline-block;padding:12px 20px;border-radius:10px;background:#2f6fed;color:#fff;
text-decoration:none;font-size:1rem}a.btn:hover{background:#4480f5}
.url{word-break:break-all;font-size:.8rem;color:#6b7383;margin-top:.75rem}
.self{margin-top:2rem;padding-top:1.25rem;border-top:1px solid #2a2f3a;font-size:.9rem}
.self strong{color:#e6e8ec}ol{margin:.5rem 0 1rem;padding-left:1.25rem;color:#aab2c0;line-height:1.7}
li{margin-bottom:.35rem}a{color:#7ea6f5}
code{background:#171b22;padding:2px 6px;border-radius:5px;font-size:.85em;color:#c3cad6}</style></head>
<body><main><h1>${t.title}</h1><p>${t.lead}</p>
<a class="btn" href="${escapeHtml(target)}">${t.open} →</a>
<p class="url">${escapeHtml(target)}</p>
<div class="self"><p><strong>${t.selfHostTitle}</strong><br>${t.selfHostIntro}</p>
<ol><li>${t.steps[0]} <a href="${REPO_URL}" target="_blank" rel="noopener noreferrer">${REPO_URL.replace("https://", "")}</a></li>
<li>${t.steps[1]}</li><li>${t.steps[2]}</li></ol>
<p>${t.offline}</p></div>
</main></body></html>`;
}

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
};

// the bundle is ~420 KB raw; compress once and keep it (the file set is
// fixed and tiny, so a plain cache is enough)
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".svg", ".json"]);
const compressCache = new Map();

function compressed(key, encoding, data) {
    const cacheKey = `${key}:${encoding}`;
    let out = compressCache.get(cacheKey);
    if (!out) {
        out = encoding === "br"
            ? brotliCompressSync(data, {
                params: { [constants.BROTLI_PARAM_QUALITY]: 9 },
            })
            : gzipSync(data, { level: 9 });
        compressCache.set(cacheKey, out);
    }
    return out;
}

const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) {
        // page may be served from static hosting (e.g. GitHub Pages)
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("access-control-allow-headers", "authorization");
        if (req.method === "OPTIONS") {
            res.writeHead(204);
            res.end();
            return;
        }
        const header = req.headers.authorization;
        const given = header?.startsWith("Bearer ")
            ? header.slice(7)
            : url.searchParams.get("token") ?? undefined;
        if (VIEW_NEEDS_TOKEN && !tokenValid(given)) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unauthorized" }));
            return;
        }
    }
    if (url.pathname === "/api/devices") {
        try {
            const devices = await adbClient.getDevices();
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(devices.map((d) => ({
                serial: d.serial,
                product: d.product,
                model: d.model,
            }))));
        } catch (e) {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: String(e) }));
        }
        return;
    }
    // don't ship the ~400 KB bundle through the tunnel. an interstitial
    // rather than a redirect: silently bouncing a visitor to another domain
    // looks like hijacking, and self-hosters need to know how to opt out
    if (PAGE_URL && !isLocalRequest(req)) {
        const target = new URL(PAGE_URL);
        target.searchParams.set("server", req.headers.host ?? "");
        const token = url.searchParams.get("token");
        if (token) target.searchParams.set("token", token);
        const zh = (req.headers["accept-language"] ?? "").toLowerCase().includes("zh");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(interstitial(target.toString(), zh));
        return;
    }
    const file = url.pathname === "/" ? "/index.html" : url.pathname;
    try {
        const data = await readFile(join(PUBLIC_DIR, file));
        const ext = file.slice(file.lastIndexOf("."));
        const headers = {
            "content-type": MIME[ext] ?? "application/octet-stream",
            vary: "accept-encoding",
        };
        const accepted = req.headers["accept-encoding"] ?? "";
        const encoding = COMPRESSIBLE.has(ext) && data.length > 1024
            ? (/\bbr\b/.test(accepted) ? "br" : /\bgzip\b/.test(accepted) ? "gzip" : null)
            : null;
        if (encoding) {
            const body = compressed(file, encoding, data);
            res.writeHead(200, { ...headers, "content-encoding": encoding });
            res.end(body);
            return;
        }
        res.writeHead(200, headers);
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end("not found");
    }
});

const wss = new WebSocketServer({
    server: httpServer,
    path: "/api/stream",
    // browsers can't set headers on WebSocket, so the token rides a
    // subprotocol (kept out of URLs and access logs); echo it back or the
    // browser fails the handshake
    handleProtocols: (protocols) => {
        for (const p of protocols) {
            if (p.startsWith(TOKEN_PROTOCOL)) return p;
        }
        return false;
    },
});

const ACTION_MAP = {
    down: AndroidMotionEventAction.Down,
    move: AndroidMotionEventAction.Move,
    up: AndroidMotionEventAction.Up,
};

const QUALITY_PRESETS = {
    low: { maxSize: 800, videoBitRate: 1_000_000 },
    medium: { maxSize: 1280, videoBitRate: 4_000_000 },
    high: { maxSize: 1920, videoBitRate: 8_000_000 },
};
const PRESET_ORDER = ["low", "medium", "high"];

wss.on("connection", async (ws, req) => {
    const reqUrl = new URL(req.url, "http://localhost");
    const serial = reqUrl.searchParams.get("serial");
    const log = (...a) => console.log(`[${serial}]`, ...a);

    const offered = (req.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((p) => p.trim())
        .find((p) => p.startsWith(TOKEN_PROTOCOL));
    const given = offered
        ? offered.slice(TOKEN_PROTOCOL.length)
        : reqUrl.searchParams.get("token") ?? undefined;
    const authed = tokenValid(given);
    if (VIEW_NEEDS_TOKEN && !authed) {
        log("rejected: bad token");
        ws.close(4001, "unauthorized");
        return;
    }
    let scrcpy;
    let rtc = null;
    let rtcGen = 0; // invalidates a pending TURN fetch when rtc-start reruns
    let controller = null;
    let video = null;
    let videoPath = "ws";
    let lastConfig = null;
    let preset = "medium";
    let autoQuality = true;
    let restartWanted = false;
    let clipSeq = 0n;
    let clipboardFromDevice = null; // loop guards for bidirectional sync
    let clipboardToDevice = null;
    let adb = null;
    let pty = null;
    let ptyWriter = null;

    const sendSignal = (obj) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };
    // shell traffic prefers its own DataChannel so an output burst
    // (logcat, cat) can't head-of-line block touch events
    const sendShell = (obj) => {
        if (!rtc?.sendShell(obj)) sendSignal(obj);
    };

    const closePty = () => {
        try {
            ptyWriter?.releaseLock();
        } catch {}
        ptyWriter = null;
        pty?.kill();
        pty = null;
    };

    const handleShell = async (msg) => {
        if (msg.t === "shell-start") {
            if (!SHELL_ENABLED) {
                sendShell({ t: "shell-error", message: "shell disabled (start server with --shell)" });
                return;
            }
            // the shell always needs the token, even when viewing doesn't
            if (!authed) {
                sendShell({ t: "shell-error", message: "unauthorized: open the page with ?token=…" });
                return;
            }
            closePty();
            const service = adb?.subprocess.shellProtocol;
            if (!service?.isSupported) {
                sendShell({ t: "shell-error", message: "device does not support the shell protocol" });
                return;
            }
            pty = await service.pty({ terminalType: "xterm-256color" });
            ptyWriter = pty.input.getWriter();
            const current = pty;
            log("shell started");
            sendShell({ t: "shell-ready" });
            if (msg.rows && msg.cols) await current.resize(msg.rows, msg.cols);
            (async () => {
                const reader = current.output.getReader();
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    sendShell({ t: "shell-out", d: Buffer.from(value).toString("base64") });
                }
                const code = await current.exited;
                log(`shell exited (${code})`);
                sendShell({ t: "shell-exit", code });
            })().catch((e) => log("shell output error:", e.message));
        } else if (msg.t === "shell-in") {
            await ptyWriter?.write(new TextEncoder().encode(msg.d));
        } else if (msg.t === "shell-resize") {
            await pty?.resize(msg.rows, msg.cols);
        } else if (msg.t === "shell-stop") {
            closePty();
        }
    };
    const requestKeyframe = () => {
        controller?.resetVideo().catch(() => {});
    };
    const requestRestart = () => {
        restartWanted = true;
        scrcpy?.close().catch(() => {}); // ends the video read loop
    };

    // REMB-driven auto downshift: sustained low bandwidth estimate drops
    // the encoder one preset (never below "low", 15s cooldown, auto mode only)
    let rembLowCount = 0;
    let rembCooldownUntil = 0;
    const onBitrateEstimate = (bps) => {
        if (!autoQuality || videoPath !== "rtc") return;
        const target = QUALITY_PRESETS[preset].videoBitRate;
        rembLowCount = bps < target * 0.6 ? rembLowCount + 1 : 0;
        const idx = PRESET_ORDER.indexOf(preset);
        if (rembLowCount >= 5 && idx > 0 && Date.now() > rembCooldownUntil) {
            preset = PRESET_ORDER[idx - 1];
            rembLowCount = 0;
            rembCooldownUntil = Date.now() + 15_000;
            log(`auto quality: estimate ${Math.round(bps / 1000)}kbps < ${preset} target, downshifting`);
            sendSignal({ type: "quality", preset, auto: true });
            requestRestart();
        }
    };

    const handleControl = (msg) => {
        if (!controller || !video) return;
        (async () => {
            if (msg.t === "touch") {
                await controller.injectTouch({
                    action: ACTION_MAP[msg.a],
                    pointerId: ScrcpyPointerId.Finger,
                    pointerX: msg.x * video.width,
                    pointerY: msg.y * video.height,
                    videoWidth: video.width,
                    videoHeight: video.height,
                    pressure: msg.a === "up" ? 0 : 1,
                    buttons: msg.a === "up" ? 0 : 1,
                });
            } else if (msg.t === "scroll") {
                await controller.injectScroll({
                    pointerX: msg.x * video.width,
                    pointerY: msg.y * video.height,
                    videoWidth: video.width,
                    videoHeight: video.height,
                    scrollX: msg.dx,
                    scrollY: msg.dy,
                    buttons: 0,
                });
            } else if (msg.t === "key") {
                await controller.injectKeyCode({
                    action: msg.a === "up" ? 1 : 0,
                    keyCode: msg.code,
                    repeat: 0,
                    metaState: 0,
                });
            } else if (msg.t === "text") {
                await controller.injectText(msg.text);
            } else if (msg.t === "clipboard") {
                if (msg.text && msg.text !== clipboardFromDevice) {
                    clipboardToDevice = msg.text;
                    clipSeq += 1n;
                    await controller.setClipboard({
                        sequence: clipSeq,
                        paste: false,
                        content: msg.text,
                    });
                }
            }
        })().catch((e) => log("control error:", e.message));
    };

    // registered before scrcpy startup so WebRTC negotiation runs in parallel
    ws.on("message", (data, isBinary) => {
        if (isBinary) return;
        let msg;
        try {
            msg = JSON.parse(data.toString());
        } catch {
            return;
        }
        if (msg.t?.startsWith("shell-")) {
            handleShell(msg).catch((e) => {
                log("shell error:", e.message);
                sendShell({ t: "shell-error", message: e.message });
            });
        } else if (msg.t === "rtc-start") {
            rtc?.close();
            rtc = null;
            const gen = ++rtcGen;
            (async () => {
                let turn = [];
                try {
                    turn = await turnServers();
                } catch (e) {
                    log("turn credentials unavailable, continuing with STUN only:", e.message);
                }
                if (gen !== rtcGen || ws.readyState !== ws.OPEN) return;
                rtc = createRtcSession({
                    sendSignal,
                    onControl: handleControl,
                    onShell: (m) => handleShell(m).catch((e) => log("shell error:", e.message)),
                    log,
                    iceServers: turn,
                });
                rtc.onKeyframeRequest = requestKeyframe;
                rtc.onBitrateEstimate = onBitrateEstimate;
                if (lastConfig) rtc.sendVideoPacket(lastConfig);
                rtc.start().catch((e) => log("webrtc offer error:", e.message));
            })();
        } else if (msg.t === "quality") {
            if (msg.preset === "auto") {
                autoQuality = true;
            } else if (QUALITY_PRESETS[msg.preset]) {
                autoQuality = false;
                if (msg.preset !== preset) {
                    preset = msg.preset;
                    log(`quality preset -> ${preset}`);
                    requestRestart();
                }
            }
        } else if (msg.t === "rtc-answer") {
            rtc?.handleAnswer(msg.sdp).catch((e) => log("webrtc answer error:", e.message));
        } else if (msg.t === "rtc-ice") {
            rtc?.handleIce(msg.candidate);
        } else if (msg.t === "video-path") {
            videoPath = msg.mode === "rtc" ? "rtc" : "ws";
            log(`video path: ${videoPath}`);
            if (videoPath === "rtc") requestKeyframe();
        } else {
            handleControl(msg);
        }
    });

    try {
        const transport = await adbClient.createTransport({ serial });
        adb = new Adb(transport);

        // the scrcpy server unlinks its own jar right after startup, so the
        // binary must be pushed again before every start
        const pushServer = () => AdbScrcpyClient.pushServer(
            adb,
            new ReadableStream({
                start(c) {
                    c.enqueue(serverBin);
                    c.close();
                },
            }),
            SERVER_PATH,
        );

        const HEADER = 10;
        // stream loop: each iteration is one scrcpy server run; quality
        // changes close the current run and start a new one in-session
        while (ws.readyState === ws.OPEN) {
            restartWanted = false;
            // random scid -> unique abstract socket name, so a restart can't
            // collide with the previous server instance still shutting down
            const makeOptions = () => new AdbScrcpyOptions3_1({
                scid: ScrcpyInstanceId.random(),
                audio: true,
                audioCodec: "opus",
                clipboardAutosync: true,
                ...QUALITY_PRESETS[preset],
            });
            scrcpy = null;
            for (let attempt = 0; ; attempt++) {
                try {
                    await pushServer();
                    scrcpy = await AdbScrcpyClient.start(adb, SERVER_PATH, makeOptions());
                    break;
                } catch (e) {
                    if (attempt >= 2) throw e;
                    log(`scrcpy start failed (${e.message}), retrying...`);
                    await new Promise((r) => setTimeout(r, 700));
                }
            }
            const current = scrcpy;
            current.output.pipeTo(new WritableStreamStd((line) => log("server:", line))).catch(() => {});

            video = await current.videoStream;
            controller = current.controller;
            log(`stream started codec=${video.metadata.codec} preset=${preset}`);
            sendSignal({
                type: "meta",
                codec: video.metadata.codec,
                width: video.width,
                height: video.height,
                serverVersion: VERSION,
                preset,
                auto: autoQuality,
                shell: SHELL_ENABLED && authed,
            });
            video.sizeChanged((size) => sendSignal({ type: "size", ...size }));

            // audio pump: opus packets go P2P only (native <video> plays them)
            (async () => {
                const meta = await current.audioStream;
                if (meta?.type !== "success") {
                    if (meta) log(`audio unavailable: ${meta.type}`);
                    return;
                }
                const audioReader = meta.stream.getReader();
                while (true) {
                    const { done, value: packet } = await audioReader.read();
                    if (done) break;
                    if (rtc?.connected) {
                        try {
                            rtc.sendAudioPacket(packet);
                        } catch {}
                    }
                }
            })().catch((e) => log("audio pump error:", e.message));

            // clipboard pump: device -> browser
            (async () => {
                if (!current.clipboard) return;
                const clipReader = current.clipboard.getReader();
                while (true) {
                    const { done, value: text } = await clipReader.read();
                    if (done) break;
                    if (text && text !== clipboardToDevice) {
                        clipboardFromDevice = text;
                        sendSignal({ type: "clipboard", text });
                    }
                }
            })().catch((e) => log("clipboard pump error:", e.message));

            const reader = video.stream.getReader();
            while (true) {
                const { done, value: packet } = await reader.read();
                if (done || ws.readyState !== ws.OPEN) break;
                if (packet.type === "configuration") lastConfig = packet;
                if (rtc) {
                    try {
                        if (packet.type === "configuration" || rtc.connected) {
                            rtc.sendVideoPacket(packet);
                        }
                    } catch (e) {
                        log("webrtc send error:", e.message);
                    }
                }
                if (videoPath === "rtc" && packet.type !== "configuration") continue;
                const buf = new Uint8Array(HEADER + packet.data.length);
                const dv = new DataView(buf.buffer);
                if (packet.type === "configuration") {
                    buf[0] = 0;
                } else {
                    buf[0] = 1;
                    buf[1] = packet.keyframe ? 1 : 0;
                    dv.setBigUint64(2, packet.pts ?? 0n);
                }
                buf.set(packet.data, HEADER);
                ws.send(buf);
            }
            reader.releaseLock();
            try {
                await current.close();
            } catch {}
            if (!restartWanted) break;
            log(`restarting stream (preset=${preset})`);
        }
    } catch (e) {
        log("session error:", e);
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "error", message: String(e) }));
        }
    } finally {
        ws.close();
        closePty();
        rtc?.close();
        try {
            await scrcpy?.close();
        } catch {}
        log("session closed");
    }
});

// tiny adapter: pipe a ReadableStream<string> to a line logger
import { WritableStream } from "@yume-chan/stream-extra";
function WritableStreamStd(fn) {
    return new WritableStream({ write: fn });
}

function findBinary(name, envVar) {
    if (envVar && process.env[envVar]) return process.env[envVar];
    const dirs = [
        ...(process.env.PATH ?? "").split(delimiter),
        join(homedir(), "bin"),
        join(homedir(), ".local/bin"),
        "/usr/local/bin",
        "/opt/homebrew/bin",
    ];
    for (const dir of dirs) {
        const p = join(dir, name);
        if (dir && existsSync(p)) return p;
    }
    return undefined;
}

// --tunnel [tunwg|cloudflared]; bare --tunnel picks the first backend found
function tunnelBackend() {
    const i = process.argv.findIndex((a) => a === "--tunnel" || a.startsWith("--tunnel="));
    if (i === -1) return undefined;
    const arg = process.argv[i];
    if (arg.includes("=")) return arg.split("=")[1];
    const next = process.argv[i + 1];
    if (next === "tunwg" || next === "cloudflared") return next;
    return "auto";
}

const tunwgRelay = () =>
    argValue("--tunnel-api") ?? process.env.TUNWG_API ?? DEFAULT_TUNWG_RELAY;

// some tunwg relays require an auth key from POST /issue; fetch once and cache
async function issueTunwgKey(api) {
    const cacheDir = join(homedir(), ".config", "tango-mirror");
    const cacheFile = join(cacheDir, `tunwg-auth-${api.replace(/[^A-Za-z0-9.-]/g, "_")}`);
    if (existsSync(cacheFile)) return (await readFile(cacheFile, "utf8")).trim();
    const res = await fetch(`https://${api}/issue`, { method: "POST" });
    if (res.status === 404) return undefined; // relay does not use issued keys
    if (!res.ok) throw new Error(`POST https://${api}/issue: HTTP ${res.status}`);
    const { key } = await res.json();
    await mkdir(cacheDir, { recursive: true });
    await writeFile(cacheFile, key, { mode: 0o600 });
    console.log(`tunwg: issued auth key from ${api}, cached in ${cacheFile}`);
    return key;
}

const TUNNEL_BACKENDS = {
    tunwg: {
        envVar: "TUNWG_BIN",
        install: "https://github.com/tiann/tunwg/releases",
        args: (port) => {
            const args = [`--forward=http://localhost:${port}`];
            const auth = argValue("--tunnel-auth"); // user:password, forwarded to tunwg basic auth
            if (auth) args.push("-limit", auth.replace(":", " "));
            return args;
        },
        urlPattern: /url=(https:\/\/\S+)/,
        env: async () => {
            const env = {};
            const api = tunwgRelay();
            if (api) env.TUNWG_API = api;
            if (api && !process.env.TUNWG_AUTH) {
                try {
                    const key = await issueTunwgKey(api);
                    if (key) env.TUNWG_AUTH = key;
                } catch (e) {
                    console.warn(`tunwg: auth key auto-issue failed (${e.message}), continuing without`);
                }
            }
            return env;
        },
    },
    cloudflared: {
        envVar: "CLOUDFLARED_PATH",
        install: "https://github.com/cloudflare/cloudflared/releases",
        args: (port) => ["tunnel", "--url", `http://localhost:${port}`],
        urlPattern: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/,
    },
};

async function startTunnel(backendName) {
    let name = backendName;
    let bin;
    if (name === "auto") {
        // cloudflared first: its quick tunnels cost nobody anything, while
        // tunwg routes everyone's fallback traffic through a relay someone
        // pays for — tunwg stays the explicit choice for stable URLs + e2e
        for (const candidate of ["cloudflared", "tunwg"]) {
            bin = findBinary(candidate, TUNNEL_BACKENDS[candidate].envVar);
            if (bin) {
                name = candidate;
                break;
            }
        }
        if (!bin) {
            console.error(
                "--tunnel: neither cloudflared nor tunwg found in PATH.\n" +
                `cloudflared (zero setup):            ${TUNNEL_BACKENDS.cloudflared.install}\n` +
                `tunwg (stable URL, e2e encrypted):   ${TUNNEL_BACKENDS.tunwg.install}`,
            );
            process.exit(1);
        }
    } else {
        const backend = TUNNEL_BACKENDS[name];
        if (!backend) {
            console.error(`--tunnel: unknown backend "${name}" (use tunwg or cloudflared)`);
            process.exit(1);
        }
        bin = findBinary(name, backend.envVar);
        if (!bin) {
            console.error(`--tunnel: ${name} not found in PATH; install from ${backend.install}`);
            process.exit(1);
        }
    }
    const backend = TUNNEL_BACKENDS[name];
    console.log(`starting ${name} tunnel...`);
    const child = spawn(bin, backend.args(PORT), {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ...((await backend.env?.()) ?? {}) },
    });
    let shuttingDown = false;
    let announced = false;
    const recent = [];
    const scan = (chunk) => {
        // keep the tail so a failed start can explain itself
        for (const line of String(chunk).split("\n")) {
            if (line.trim()) recent.push(line.trimEnd());
        }
        if (recent.length > 12) recent.splice(0, recent.length - 12);
        if (announced) return;
        const m = String(chunk).match(backend.urlPattern);
        if (m) {
            announced = true;
            const url = m[1] ?? m[0];
            printOpenUrls(url);
            if (name === "cloudflared" && !VIEW_NEEDS_TOKEN) {
                console.log("note: this URL is public and unauthenticated — share carefully");
            }
        }
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    // a missing or unrunnable binary must not take the whole server down
    child.on("error", (e) => {
        console.error(`\ncannot run ${name} (${bin}): ${e.message}`);
        console.error(`tango-mirror is still serving on http://localhost:${PORT}\n`);
    });
    child.on("exit", (code) => {
        if (shuttingDown) return;
        console.error(`\n${name} exited with code ${code}${announced ? "" : " before reporting a URL"}`);
        if (recent.length) {
            console.error(`--- ${name} output ---`);
            for (const line of recent) console.error(`  ${line}`);
            console.error("---");
        } else {
            console.error(`(${name} printed nothing; ${bin} may be an old or incompatible build)`);
        }
        if (name === "tunwg") {
            console.error(
                `relay in use: ${tunwgRelay()} — point --tunnel-api at another one\n` +
                "if it is unreachable, or run your own (see the tunwg README).",
            );
        }
        console.error(`tango-mirror is still serving on http://localhost:${PORT}\n`);
    });
    const cleanup = () => {
        shuttingDown = true;
        child.kill();
        process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
}

// print ready-to-click URLs: the token is already embedded, so opening one
// is all the setup there is (the page saves it and strips it from the bar)
// a QR beats copying a URL with a 32-char token out of a terminal, which is
// the usual way this gets opened on a phone
function printQr(url) {
    if (process.argv.includes("--no-qr")) return;
    const width = process.stdout.columns ?? 80;
    qrcode.generate(url, { small: true }, (art) => {
        const lines = art.split("\n");
        if ((lines[0]?.length ?? 0) > width) return; // wrapped QR is unscannable
        console.log(lines.map((l) => `  ${l}`).join("\n"));
    });
}

function printOpenUrls(publicUrl) {
    const q = TOKEN ? `?token=${TOKEN}` : "";
    let primary = null;
    if (publicUrl && PAGE_URL) {
        const target = new URL(PAGE_URL);
        target.searchParams.set("server", publicUrl.replace(/^https?:\/\//, ""));
        if (TOKEN) target.searchParams.set("token", TOKEN);
        primary = target.toString();
    } else if (publicUrl) {
        primary = `${publicUrl}/${q}`;
    }
    if (primary) console.log(`\n  open:  ${primary}`);
    console.log(`${primary ? "  local: " : "\n  open:  "}http://localhost:${PORT}/${q}\n`);
    if (primary) printQr(primary);
}

// ws re-emits http server errors on the WebSocketServer, so both need a
// listener or listen failures surface as an unhandled 'error' event
const handleListenError = (e) => {
    if (e.code === "EADDRINUSE") {
        console.error(
            `port ${PORT} is already in use — another tango-mirror may be running.\n` +
            `pick a different one with --port, e.g. tango-mirror --port ${PORT + 1}`,
        );
    } else if (e.code === "EACCES") {
        console.error(`not allowed to listen on port ${PORT}; try a port above 1024`);
    } else {
        console.error(`failed to listen on port ${PORT}: ${e.message}`);
    }
    process.exit(1);
};
httpServer.on("error", handleListenError);
wss.on("error", handleListenError);

httpServer.listen(PORT, () => {
    console.log(`tango-mirror listening on http://localhost:${PORT} (scrcpy server v${VERSION})`);
    if (SHELL_ENABLED) {
        console.log(`device shell: enabled${VIEW_NEEDS_TOKEN ? "" : " (viewing stays open; shell needs the token)"}`);
    }
    const backend = tunnelBackend();
    if (!backend) printOpenUrls();
    if (backend) {
        startTunnel(backend).catch((e) => console.error("tunnel failed:", e));
    }
});

process.on("unhandledRejection", (e) => {
    console.error("unhandled rejection:", e);
});
