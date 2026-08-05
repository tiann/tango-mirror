#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
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
import { ScrcpyPointerId, AndroidMotionEventAction } from "@yume-chan/scrcpy";

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

const wss = new WebSocketServer({ server: httpServer, path: "/api/stream" });

const ACTION_MAP = {
    down: AndroidMotionEventAction.Down,
    move: AndroidMotionEventAction.Move,
    up: AndroidMotionEventAction.Up,
};

wss.on("connection", async (ws, req) => {
    const serial = new URL(req.url, "http://localhost").searchParams.get("serial");
    const log = (...a) => console.log(`[${serial}]`, ...a);
    let scrcpy;
    try {
        const transport = await adbClient.createTransport({ serial });
        const adb = new Adb(transport);

        await AdbScrcpyClient.pushServer(
            adb,
            new ReadableStream({
                start(c) {
                    c.enqueue(serverBin);
                    c.close();
                },
            }),
            SERVER_PATH,
        );

        const options = new AdbScrcpyOptions3_1({
            audio: false,
            maxSize: 1280,
            videoBitRate: 4_000_000,
            clipboardAutosync: false,
        });
        scrcpy = await AdbScrcpyClient.start(adb, SERVER_PATH, options);
        scrcpy.output.pipeTo(new WritableStreamStd((line) => log("server:", line))).catch(() => {});

        const video = await scrcpy.videoStream;
        log(`stream started codec=${video.metadata.codec} ${video.width}x${video.height}`);
        ws.send(JSON.stringify({
            type: "meta",
            codec: video.metadata.codec,
            width: video.width,
            height: video.height,
            serverVersion: VERSION,
        }));
        video.sizeChanged((size) => {
            if (ws.readyState === ws.OPEN) {
                ws.send(JSON.stringify({ type: "size", ...size }));
            }
        });

        const controller = scrcpy.controller;

        ws.on("message", (data, isBinary) => {
            if (isBinary) return;
            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                return;
            }
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
                }
            })().catch((e) => log("control error:", e.message));
        });

        const reader = video.stream.getReader();
        const HEADER = 10;
        while (true) {
            const { done, value: packet } = await reader.read();
            if (done || ws.readyState !== ws.OPEN) break;
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
    } catch (e) {
        log("session error:", e);
        if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "error", message: String(e) }));
        }
    } finally {
        ws.close();
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
    const backend = tunnelBackend();
    if (backend) {
        startTunnel(backend).catch((e) => console.error("tunnel failed:", e));
    }
});

process.on("unhandledRejection", (e) => {
    console.error("unhandled rejection:", e);
});
