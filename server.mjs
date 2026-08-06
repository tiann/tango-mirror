#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
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
import { createRtcSession } from "./webrtc.mjs";

function argValue(...names) {
    for (const name of names) {
        const i = process.argv.indexOf(name);
        if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
    }
    return undefined;
}

const PORT = Number(argValue("--port", "-p") ?? process.env.PORT ?? 8010);
const ADB_HOST = argValue("--adb-host") ?? process.env.ADB_HOST ?? "127.0.0.1";
const ADB_PORT = Number(argValue("--adb-port") ?? process.env.ADB_PORT ?? 5037);
const VERSION = "3.1"; // must match the bundled server.bin
const SERVER_PATH = "/data/local/tmp/tango-scrcpy-server.jar";
const PKG_DIR = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(PKG_DIR, "public");

const SHELL_ENABLED = process.argv.includes("--shell");
let TOKEN = argValue("--token") ?? process.env.TANGO_TOKEN ?? "";
if (SHELL_ENABLED && !TOKEN) {
    // never expose a shell without auth — generate one rather than fail open
    TOKEN = randomBytes(16).toString("hex");
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

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
};

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
        if (!tokenValid(given)) {
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
    const file = url.pathname === "/" ? "/index.html" : url.pathname;
    try {
        const data = await readFile(join(PUBLIC_DIR, file));
        const ext = file.slice(file.lastIndexOf("."));
        res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
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
    if (!tokenValid(given)) {
        log("rejected: bad token");
        ws.close(4001, "unauthorized");
        return;
    }
    let scrcpy;
    let rtc = null;
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
            rtc = createRtcSession({
                sendSignal,
                onControl: handleControl,
                onShell: (m) => handleShell(m).catch((e) => log("shell error:", e.message)),
                log,
            });
            rtc.onKeyframeRequest = requestKeyframe;
            rtc.onBitrateEstimate = onBitrateEstimate;
            if (lastConfig) rtc.sendVideoPacket(lastConfig);
            rtc.start().catch((e) => log("webrtc offer error:", e.message));
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
            const api = argValue("--tunnel-api") ?? process.env.TUNWG_API;
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
        for (const candidate of ["tunwg", "cloudflared"]) {
            bin = findBinary(candidate, TUNNEL_BACKENDS[candidate].envVar);
            if (bin) {
                name = candidate;
                break;
            }
        }
        if (!bin) {
            console.error(
                "--tunnel: neither tunwg nor cloudflared found in PATH.\n" +
                `tunwg (end-to-end encrypted):  ${TUNNEL_BACKENDS.tunwg.install}\n` +
                `cloudflared:                   ${TUNNEL_BACKENDS.cloudflared.install}`,
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
    const scan = (chunk) => {
        if (announced) return;
        const m = String(chunk).match(backend.urlPattern);
        if (m) {
            announced = true;
            console.log(`public URL: ${m[1] ?? m[0]}`);
            if (name === "cloudflared") {
                console.log("note: this URL is public and unauthenticated — share carefully");
            }
        }
    };
    child.stdout.on("data", scan);
    child.stderr.on("data", scan);
    child.on("exit", (code) => {
        if (!shuttingDown) {
            console.error(`${name} exited with code ${code}`);
        }
    });
    const cleanup = () => {
        shuttingDown = true;
        child.kill();
        process.exit(0);
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
}

httpServer.listen(PORT, () => {
    console.log(`tango-mirror listening on http://localhost:${PORT} (scrcpy server v${VERSION})`);
    if (SHELL_ENABLED) console.log("device shell: enabled");
    if (TOKEN) {
        console.log(`auth token: ${TOKEN}`);
        console.log(`append to the page URL: ?token=${TOKEN}`);
    }
    const backend = tunnelBackend();
    if (backend) {
        startTunnel(backend).catch((e) => console.error("tunnel failed:", e));
    }
});

process.on("unhandledRejection", (e) => {
    console.error("unhandled rejection:", e);
});
