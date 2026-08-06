import {
    WebCodecsVideoDecoder,
    WebGLVideoFrameRenderer,
    BitmapVideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs";
import { SignalRoom, b64u } from "../signal.mjs";
// xterm is ~300 KB of the bundle and only matters once the shell is opened,
// so it loads on demand
let Terminal = null;
let FitAddon = null;

async function loadXterm() {
    if (Terminal) return;
    const [xterm, fit, css] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
        import("@xterm/xterm/css/xterm.css"),
    ]);
    Terminal = xterm.Terminal;
    FitAddon = fit.FitAddon;
    document.head.appendChild(document.createElement("style")).textContent =
        css.default ?? css;
}

// STUN only — TURN servers, when the backend has them (--turn), arrive
// with the WebRTC offer
const ICE_SERVERS = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
];

const STRINGS = {
    zh: {
        refresh: "刷新设备列表",
        fullscreen: "全屏",
        settings: "后端地址",
        quality: "画质",
        sound: "声音",
        power: "电源",
        back: "返回",
        home: "主页",
        recents: "最近任务",
        keyboard: "键盘",
        qAuto: "自动",
        qLow: "流畅",
        qMedium: "平衡",
        qHigh: "高清",
        kbdPlaceholder: "输入文字，回车发送到设备",
        send: "发送",
        emptyStage: "选择设备开始镜像",
        loadingDevices: "加载设备中…",
        noBackend: "未配置后端地址",
        noBackendHint: "请点右上角 ⚙ 设置后端地址",
        backendDown: "后端连接失败",
        backendDownHint: (b) => `连不上 ${b} — 检查服务是否在线，或点 ⚙ 修改地址`,
        noDevices: "无设备 — 请先 adb connect",
        noDevicesHint: "后端正常，但没有已连接的设备",
        selectDevice: "选择设备…",
        device: "设备",
        connecting: "连接中…",
        error: (m) => `出错：${m}`,
        decodeError: (m) => `解码出错：${m}`,
        disconnected: "连接已断开",
        downshift: (p) => `网络受限，已降为${p}`,
        backendPrompt: "后端地址（tango-mirror 服务的域名，如 xxx.relay.hapi.run）：",
        shell: "设备 Shell",
        close: "关闭",
        shellExited: (c) => `会话结束，退出码 ${c}`,
        unauthorized: "认证失败",
        unauthorizedHint: "token 无效或缺失 — 用启动日志里的 ?token=… 链接打开",
        signalDown: "联系不到主机",
        signalDownHint: "确认主机正以 --signal 运行且在线，然后刷新",
        p2pFailed: "P2P 连接失败 — 在主机侧加 --turn 可解决",
    },
    en: {
        refresh: "Refresh devices",
        fullscreen: "Fullscreen",
        settings: "Backend address",
        quality: "Quality",
        sound: "Sound",
        power: "Power",
        back: "Back",
        home: "Home",
        recents: "Recents",
        keyboard: "Keyboard",
        qAuto: "Auto",
        qLow: "Smooth",
        qMedium: "Balanced",
        qHigh: "HD",
        kbdPlaceholder: "Type text, press Enter to send",
        send: "Send",
        emptyStage: "Select a device to start mirroring",
        loadingDevices: "Loading devices…",
        noBackend: "Backend not configured",
        noBackendHint: "Tap ⚙ in the top bar to set the backend address",
        backendDown: "Backend unreachable",
        backendDownHint: (b) => `Cannot reach ${b} — check the service, or tap ⚙ to change it`,
        noDevices: "No devices — run adb connect first",
        noDevicesHint: "Backend is up, but no devices are connected",
        selectDevice: "Select device…",
        device: "Device",
        connecting: "Connecting…",
        error: (m) => `Error: ${m}`,
        decodeError: (m) => `Decode error: ${m}`,
        disconnected: "Disconnected",
        downshift: (p) => `Network limited, switched to ${p}`,
        backendPrompt: "Backend address (your tango-mirror server's domain, e.g. xxx.relay.hapi.run):",
        shell: "Device shell",
        close: "Close",
        shellExited: (c) => `session ended, exit code ${c}`,
        unauthorized: "Unauthorized",
        unauthorizedHint: "Missing or invalid token — open the ?token=… link from the server log",
        signalDown: "Can't reach the host",
        signalDownHint: "Make sure the host is running with --signal, then refresh",
        p2pFailed: "P2P failed — add --turn on the host to fix this",
    },
};

// language: ?lang= param (persisted) > saved choice > browser language
const langParam = new URLSearchParams(location.search).get("lang");
if (langParam) localStorage.setItem("tango-lang", langParam);
const LANG = (localStorage.getItem("tango-lang") || navigator.language || "en")
    .toLowerCase()
    .startsWith("zh") ? "zh" : "en";
const t = STRINGS[LANG];

// backend resolution: ?server= param > saved value > same-origin.
// lets the static page live on GitHub Pages while the backend sits
// behind a tunnel; the ⚙ button changes it at runtime.
const backendParam = new URLSearchParams(location.search).get("server");
if (backendParam !== null) {
    localStorage.setItem("tango-backend", backendParam.replace(/^[a-z]+:\/\//, "").replace(/\/$/, ""));
}
// serverless signaling (#k=… from a --signal host): the key stays in the
// fragment — it never reaches any server, and the page needs it on reload
const frag = new URLSearchParams(location.hash.slice(1));
const SIGNAL_KEY = frag.get("k") || "";
const SIGNAL = Boolean(SIGNAL_KEY);

// token arrives via ?token= (or #…&t= in signal links), then is scrubbed
// from the URL so it doesn't linger in history or get shared along
const tokenParam = new URLSearchParams(location.search).get("token") ?? frag.get("t");
if (tokenParam !== null) {
    localStorage.setItem("tango-token", tokenParam);
    const clean = new URL(location.href);
    clean.searchParams.delete("token");
    frag.delete("t");
    clean.hash = frag.toString();
    history.replaceState(null, "", clean);
}
const TOKEN = localStorage.getItem("tango-token") || "";

const BACKEND = localStorage.getItem("tango-backend") || "";
const HTTP_BASE = BACKEND ? `https://${BACKEND}` : "";
const WS_BASE = BACKEND
    ? `wss://${BACKEND}`
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

function promptBackend() {
    const input = prompt(t.backendPrompt, BACKEND);
    if (input === null) return;
    localStorage.setItem("tango-backend", input.trim().replace(/^[a-z]+:\/\//, "").replace(/\/$/, ""));
    location.reload();
}

const $ = (id) => document.getElementById(id);
const deviceSelect = $("device-select");
const qualitySelect = $("quality-select");
const stageEl = $("stage");
const badgeEl = $("status-badge");
const kbdBar = $("kbdbar");
const kbdInput = $("kbd-input");
const shellPanel = $("shell-panel");

const PRESET_NAMES = { low: t.qLow, medium: t.qMedium, high: t.qHigh };

// apply translations to the static page
document.documentElement.lang = LANG;
for (const [id, key] of [
    ["refresh", "refresh"], ["btn-fullscreen", "fullscreen"], ["btn-settings", "settings"],
    ["quality-select", "quality"], ["btn-mute", "sound"], ["btn-power", "power"],
    ["btn-back", "back"], ["btn-home", "home"], ["btn-recents", "recents"], ["btn-kbd", "keyboard"],
    ["btn-shell", "shell"], ["shell-close", "close"],
]) $(id).title = t[key];
for (const opt of qualitySelect.options) {
    opt.textContent = { auto: t.qAuto, low: t.qLow, medium: t.qMedium, high: t.qHigh }[opt.value];
}
kbdInput.placeholder = t.kbdPlaceholder;
$("kbd-send").textContent = t.send;
stageEl.dataset.emptyHint = t.emptyStage;

let ws = null;
let decoder = null;
let writer = null;
let canvas = null;
let currentSerial = null;

let pc = null;
let dc = null;
let shellDc = null;
let videoEl = null;
let path = "ws"; // "ws" | "rtc"
let statsTimer = null;
let lastSize = "";
let muted = true;
let lastClipFromDevice = null;
let lastClipToDevice = null;

function setBadge(text, cls = "") {
    badgeEl.hidden = !text;
    badgeEl.textContent = text;
    badgeEl.className = cls;
}

async function loadDevices() {
    const placeholder = (text) => {
        deviceSelect.innerHTML = "";
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = text;
        deviceSelect.appendChild(opt);
    };
    placeholder(t.loadingDevices);
    let devices = [];
    if (SIGNAL) {
        try {
            devices = await signalDevices();
        } catch (e) {
            if (e.message === "unauthorized") {
                placeholder(t.unauthorized);
                setBadge(t.unauthorizedHint, "error");
            } else {
                placeholder(t.signalDown);
                setBadge(t.signalDownHint, "error");
            }
            return;
        }
    } else try {
        const res = await fetch(`${HTTP_BASE}/api/devices`, {
            headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
        });
        if (res.status === 401) {
            placeholder(t.unauthorized);
            setBadge(t.unauthorizedHint, "error");
            return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        devices = await res.json();
    } catch {
        // guide the user instead of a dead "retry": either the backend was
        // never configured (static hosting), or the configured one is down
        if (!BACKEND) {
            placeholder(t.noBackend);
            setBadge(t.noBackendHint, "error");
            promptBackend();
        } else {
            placeholder(t.backendDown);
            setBadge(t.backendDownHint(BACKEND), "error");
        }
        return;
    }
    if (devices.length === 0) {
        placeholder(t.noDevices);
        setBadge(t.noDevicesHint, "error");
        return;
    }
    setBadge("");
    placeholder(t.selectDevice);
    for (const d of devices) {
        const opt = document.createElement("option");
        opt.value = d.serial;
        opt.textContent = `${d.model?.replaceAll("_", " ") ?? d.product ?? t.device} · ${d.serial}`;
        deviceSelect.appendChild(opt);
    }
    // one device only: connect right away, no extra tap needed
    if (devices.length === 1) {
        deviceSelect.value = devices[0].serial;
        connect(devices[0].serial);
    } else if (currentSerial && devices.some((d) => d.serial === currentSerial)) {
        deviceSelect.value = currentSerial;
    }
}

// ---- serverless signaling (--signal hosts) --------------------------------
// The room replaces both /api/devices and the /api/stream WebSocket with
// encrypted messages on public MQTT brokers, addressed per-session by sid.
// There is no WS video fallback on this path — media is WebRTC-only.

let signalRoom = null;
let roomPromise = null;
const signalRoutes = new Map(); // sid -> handler

function ensureRoom() {
    roomPromise ??= SignalRoom.create({ key: b64u.decode(SIGNAL_KEY), role: "viewer" }).then((room) => {
        signalRoom = room;
        room.onmessage = (msg) => signalRoutes.get(msg.sid)?.(msg);
        return room;
    });
    return roomPromise;
}

const randSid = () =>
    Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

async function signalDevices() {
    await ensureRoom();
    const sid = randSid();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signalRoutes.delete(sid);
            reject(new Error("timeout"));
        }, 12000);
        signalRoutes.set(sid, (msg) => {
            clearTimeout(timer);
            signalRoutes.delete(sid);
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.devices ?? []);
        });
        signalRoom.send({ sid, t: "devices", token: TOKEN || undefined });
    });
}

// quacks like the WebSocket connect() expects: send/close/onopen/onmessage/
// onclose/readyState — so the whole session protocol runs unchanged
function signalChannel(serial) {
    const sid = randSid();
    let hb = null;
    const chan = {
        readyState: WebSocket.CONNECTING,
        binaryType: "",
        onopen: null,
        onmessage: null,
        onclose: null,
        send(s) {
            signalRoom?.send({ sid, ...JSON.parse(s) });
        },
        close() {
            if (chan.readyState === WebSocket.OPEN) signalRoom?.send({ sid, t: "bye" });
            chan.readyState = WebSocket.CLOSED;
            clearInterval(hb);
            signalRoutes.delete(sid);
        },
    };
    ensureRoom().then(() => {
        if (chan.readyState === WebSocket.CLOSED) return;
        signalRoutes.set(sid, (msg) => {
            if (msg.t === "bye") {
                const wasOpen = chan.readyState === WebSocket.OPEN;
                chan.readyState = WebSocket.CLOSED;
                clearInterval(hb);
                signalRoutes.delete(sid);
                if (wasOpen) chan.onclose?.({ code: msg.code ?? 1000 });
            } else {
                chan.onmessage?.({ data: JSON.stringify(msg) });
            }
        });
        signalRoom.send({ sid, t: "open", serial, token: TOKEN || undefined });
        // brokers give no liveness signal for the peer; the host times a
        // session out after 90 s without traffic, so keep it warm
        hb = setInterval(() => signalRoom.send({ sid, t: "ping" }), 25000);
        chan.readyState = WebSocket.OPEN;
        chan.onopen?.();
    }).catch(() => {
        setBadge(t.signalDownHint, "error");
    });
    return chan;
}

function sendWs(obj) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function sendControl(obj) {
    if (dc?.readyState === "open") dc.send(JSON.stringify(obj));
    else sendWs(obj);
}

function teardownRtc() {
    clearInterval(statsTimer);
    statsTimer = null;
    dc = null;
    shellDc = null;
    pc?.close();
    pc = null;
    videoEl?.remove();
    videoEl = null;
    if (path === "rtc") {
        path = "ws";
        if (canvas) canvas.style.display = "";
        sendWs({ t: "video-path", mode: "ws" });
        setBadge(`${lastSize} · WS`);
    }
}

function disconnect() {
    teardownRtc();
    ws?.close();
    ws = null;
    writer?.releaseLock();
    writer = null;
    decoder?.dispose();
    decoder = null;
    canvas = null;
    currentSerial = null;
    path = "ws";
    stageEl.innerHTML = "";
    setBadge("");
}

function connect(serial) {
    disconnect();
    currentSerial = serial;
    setBadge(t.connecting);
    if (SIGNAL) {
        ws = signalChannel(serial);
    } else {
        const url = `${WS_BASE}/api/stream?serial=${encodeURIComponent(serial)}`;
        ws = TOKEN ? new WebSocket(url, [`tango.token.${TOKEN}`]) : new WebSocket(url);
    }
    ws.binaryType = "arraybuffer";
    // negotiate WebRTC immediately, in parallel with scrcpy startup
    ws.onopen = () => tryWebRtc();

    ws.onmessage = async (ev) => {
        if (typeof ev.data === "string") {
            const msg = JSON.parse(ev.data);
            if (msg.type === "meta") {
                startDecoder(msg.codec);
                $("btn-shell").hidden = !msg.shell;
                if (msg.preset) qualitySelect.value = msg.auto ? "auto" : msg.preset;
                if (path !== "rtc") setBadge("WS");
            } else if (msg.type === "quality") {
                // server auto-downshifted under congestion
                setBadge(t.downshift(PRESET_NAMES[msg.preset] ?? msg.preset), "p2p");
            } else if (msg.type === "clipboard") {
                lastClipFromDevice = msg.text;
                navigator.clipboard?.writeText(msg.text).catch(() => {});
            } else if (msg.type === "size") {
                lastSize = `${msg.width}×${msg.height}`;
                if (path !== "rtc") setBadge(`${lastSize} · WS`);
            } else if (msg.type === "error") {
                setBadge(t.error(msg.message), "error");
            } else if (msg.t === "rtc-offer") {
                acceptRtcOffer(msg.sdp, msg.iceServers).catch((e) => {
                    console.warn("webrtc setup failed:", e);
                    teardownRtc();
                });
            } else if (msg.t === "rtc-ice") {
                pc?.addIceCandidate(msg.candidate).catch(() => {});
            } else if (msg.t?.startsWith("shell-")) {
                handleShellMessage(msg);
            }
            return;
        }
        if (!writer) return;
        const buf = new Uint8Array(ev.data);
        const dv = new DataView(ev.data);
        const data = buf.subarray(10);
        const packet = buf[0] === 0
            ? { type: "configuration", data }
            : { type: "data", keyframe: buf[1] === 1, pts: dv.getBigUint64(2), data };
        try {
            await writer.write(packet);
        } catch (e) {
            setBadge(t.decodeError(e.message), "error");
        }
    };
    ws.onclose = (e) => {
        if (currentSerial !== serial) return;
        setBadge(e.code === 4001 ? t.unauthorizedHint : t.disconnected, "error");
    };
}

function startDecoder(codec) {
    let renderer;
    try {
        renderer = new WebGLVideoFrameRenderer();
    } catch {
        renderer = new BitmapVideoFrameRenderer();
    }
    decoder = new WebCodecsVideoDecoder({ codec, renderer });
    writer = decoder.writable.getWriter();

    // replace only the previous canvas — the WebRTC <video> may already be
    // in the stage (negotiation runs in parallel with scrcpy startup)
    canvas?.remove();
    canvas = renderer.canvas;
    canvas.className = "screen";
    // a quality change restarts the stream mid-session; if P2P is already
    // showing, the fresh canvas must stay hidden underneath
    if (path === "rtc") canvas.style.display = "none";
    stageEl.appendChild(canvas);
    attachInput(canvas);
}

function tryWebRtc() {
    if (typeof RTCPeerConnection === "undefined") {
        if (SIGNAL) setBadge(t.p2pFailed, "error");
        return;
    }
    sendWs({ t: "rtc-start" });
}

async function acceptRtcOffer(sdp, extraIce) {
    pc = new RTCPeerConnection({ iceServers: [...ICE_SERVERS, ...(extraIce ?? [])] });
    pc.onicecandidate = (e) => {
        if (e.candidate) sendWs({ t: "rtc-ice", candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
        if (pc && ["failed", "disconnected", "closed"].includes(pc.connectionState)) {
            teardownRtc();
        }
    };
    pc.ondatachannel = (e) => {
        if (e.channel.label === "shell") {
            shellDc = e.channel;
            shellDc.onmessage = (m) => handleShellMessage(JSON.parse(m.data));
        } else {
            dc = e.channel;
        }
    };
    pc.ontrack = (e) => {
        // minimize receive-side latency where supported
        try {
            e.receiver.playoutDelayHint = 0;
            e.receiver.jitterBufferTarget = 0;
        } catch {}
        // fires once per track (video + audio) — share one element/stream
        if (!videoEl) {
            videoEl = document.createElement("video");
            videoEl.className = "screen-video";
            videoEl.autoplay = true;
            videoEl.muted = muted;
            videoEl.playsInline = true;
            videoEl.srcObject = new MediaStream();
            stageEl.appendChild(videoEl);
            attachInput(videoEl);
            watchRtcStats();
        }
        videoEl.srcObject.addTrack(e.track);
        videoEl.play().catch((err) => console.warn("video.play() rejected:", err));
    };
    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWs({ t: "rtc-answer", sdp: answer.sdp });
}

// switch paths based on real decode progress from getStats(); keeps a live
// readout in the status badge so failures are diagnosable
function watchRtcStats() {
    let lastFrames = 0;
    let lastTime = performance.now();
    let ticksWithoutDecode = 0;
    clearInterval(statsTimer);
    statsTimer = setInterval(async () => {
        if (!pc) return;
        const stats = await pc.getStats();
        let inbound = null;
        stats.forEach((s) => {
            if (s.type === "inbound-rtp" && s.kind === "video") inbound = s;
        });
        if (!inbound) return;
        const { packetsReceived = 0, framesDecoded = 0, framesReceived = 0, pliCount = 0 } = inbound;
        if (path !== "rtc") {
            if (framesDecoded > 0 && videoEl) {
                path = "rtc";
                if (canvas) canvas.style.display = "none";
                videoEl.play?.().catch(() => {});
                sendWs({ t: "video-path", mode: "rtc" });
            } else {
                ticksWithoutDecode++;
                if (ticksWithoutDecode === 10) {
                    console.warn("webrtc: no decoded frames after 5s", inbound);
                    console.warn(`p2p stalled: pkts=${packetsReceived} recv=${framesReceived} dec=${framesDecoded} pli=${pliCount}`);
                }
                if (ticksWithoutDecode >= 20) {
                    console.warn("webrtc: giving up, staying on WebSocket path");
                    teardownRtc();
                    // no WS video exists on the signaling path — say why
                    // the screen is black instead of silently showing it
                    if (SIGNAL) setBadge(t.p2pFailed, "error");
                }
            }
            return;
        }
        const now = performance.now();
        const fps = Math.round(((framesDecoded - lastFrames) * 1000) / (now - lastTime));
        lastFrames = framesDecoded;
        lastTime = now;
        const size = videoEl?.videoWidth ? `${videoEl.videoWidth}×${videoEl.videoHeight}` : lastSize;
        setBadge(`${size} · P2P ${fps}fps`, "p2p");
    }, 500);
}

// normalized [0,1] coordinates; accounts for letterboxing in <video>
function norm(el, e) {
    const rect = el.getBoundingClientRect();
    let { width, height } = rect;
    let ox = 0;
    let oy = 0;
    if (el.videoWidth) {
        const scale = Math.min(rect.width / el.videoWidth, rect.height / el.videoHeight);
        width = el.videoWidth * scale;
        height = el.videoHeight * scale;
        ox = (rect.width - width) / 2;
        oy = (rect.height - height) / 2;
    }
    return {
        x: Math.min(1, Math.max(0, (e.clientX - rect.left - ox) / width)),
        y: Math.min(1, Math.max(0, (e.clientY - rect.top - oy) / height)),
    };
}

function attachInput(el) {
    let down = false;
    el.onpointerdown = (e) => {
        el.setPointerCapture(e.pointerId);
        down = true;
        sendControl({ t: "touch", a: "down", ...norm(el, e) });
        e.preventDefault();
    };
    el.onpointermove = (e) => {
        if (down) sendControl({ t: "touch", a: "move", ...norm(el, e) });
    };
    const up = (e) => {
        if (down) sendControl({ t: "touch", a: "up", ...norm(el, e) });
        down = false;
    };
    el.onpointerup = up;
    el.onpointercancel = up;
    el.onwheel = (e) => {
        e.preventDefault();
        sendControl({ t: "scroll", ...norm(el, e), dx: -e.deltaX / 100, dy: -e.deltaY / 100 });
    };
    el.oncontextmenu = (e) => e.preventDefault();
}

// ── device shell ───────────────────────────────────────────────
let term = null;
let fitAddon = null;
let shellReady = false;

function sendShell(obj) {
    // mirrors sendControl: prefer the dedicated P2P channel
    if (shellDc?.readyState === "open") shellDc.send(JSON.stringify(obj));
    else sendWs(obj);
}

async function openShell() {
    if (!currentSerial) return;
    shellPanel.hidden = false;
    // shrink the layout instead of covering it, so the screen stays visible
    document.body.classList.add("with-shell");
    try {
        await loadXterm();
    } catch (e) {
        $("shell-title").textContent = `${t.shell}: ${e.message}`;
        return;
    }
    if (!term) {
        term = new Terminal({
            fontSize: 13,
            cursorBlink: true,
            theme: { background: "#0f1115", foreground: "#e6e8ec" },
        });
        fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open($("terminal"));
        term.onData((d) => sendShell({ t: "shell-in", d }));
        term.onResize(({ rows, cols }) => sendShell({ t: "shell-resize", rows, cols }));
        // panel geometry changes on rotation / window resize
        new ResizeObserver(() => {
            if (!shellPanel.hidden) fitAddon?.fit();
        }).observe($("terminal"));
    }
    fitAddon.fit();
    term.focus();
    if (!shellReady) {
        sendShell({ t: "shell-start", rows: term.rows, cols: term.cols });
    }
}

function closeShell() {
    shellPanel.hidden = true;
    document.body.classList.remove("with-shell");
}

function handleShellMessage(msg) {
    if (msg.t === "shell-ready") {
        shellReady = true;
    } else if (msg.t === "shell-out") {
        term?.write(Uint8Array.from(atob(msg.d), (c) => c.charCodeAt(0)));
    } else if (msg.t === "shell-exit") {
        shellReady = false;
        term?.write(`\r\n\x1b[90m[${t.shellExited(msg.code)}]\x1b[0m\r\n`);
    } else if (msg.t === "shell-error") {
        shellReady = false;
        term?.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
    }
}

// physical keyboard passthrough (desktop); form fields keep their own keys
const isFormField = (t) => ["INPUT", "SELECT", "TEXTAREA"].includes(t.tagName);
window.onkeydown = (e) => {
    if (isFormField(e.target) || !currentSerial) return;
    if (e.key === "Backspace") sendControl({ t: "key", code: 67, a: "down" });
    else if (e.key === "Enter") sendControl({ t: "key", code: 66, a: "down" });
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) sendControl({ t: "text", text: e.key });
};
window.onkeyup = (e) => {
    if (isFormField(e.target) || !currentSerial) return;
    if (e.key === "Backspace") sendControl({ t: "key", code: 67, a: "up" });
    else if (e.key === "Enter") sendControl({ t: "key", code: 66, a: "up" });
};

// on-screen keyboard bar (mobile: summons the local IME, forwards to device)
function sendKbdText() {
    const text = kbdInput.value;
    if (text) {
        sendControl({ t: "text", text });
        kbdInput.value = "";
    } else {
        sendControl({ t: "key", code: 66, a: "down" });
        sendControl({ t: "key", code: 66, a: "up" });
    }
}
$("btn-kbd").onclick = () => {
    kbdBar.hidden = !kbdBar.hidden;
    if (!kbdBar.hidden) kbdInput.focus();
};
$("kbd-send").onclick = sendKbdText;
kbdInput.onkeydown = (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        sendKbdText();
    } else if (e.key === "Backspace" && !kbdInput.value) {
        sendControl({ t: "key", code: 67, a: "down" });
        sendControl({ t: "key", code: 67, a: "up" });
    }
};

for (const [id, code] of [["btn-back", 4], ["btn-home", 3], ["btn-recents", 187], ["btn-power", 26]]) {
    $(id).onclick = () => {
        sendControl({ t: "key", code, a: "down" });
        sendControl({ t: "key", code, a: "up" });
    };
}

$("btn-fullscreen").onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
};

$("btn-settings").onclick = promptBackend;
// a #k link needs no backend address — the host is found via signaling,
// so the ⚙ prompt would only mislead
$("btn-settings").hidden = SIGNAL;
$("btn-shell").onclick = () => {
    if (shellPanel.hidden) openShell().catch((e) => console.error("shell:", e));
    else closeShell();
};
$("shell-close").onclick = closeShell;

deviceSelect.onchange = () => {
    if (deviceSelect.value) connect(deviceSelect.value);
};
qualitySelect.onchange = () => sendWs({ t: "quality", preset: qualitySelect.value });

$("btn-mute").onclick = () => {
    muted = !muted;
    $("btn-mute").textContent = muted ? "🔇" : "🔊";
    if (videoEl) {
        videoEl.muted = muted;
        videoEl.play?.().catch(() => {});
    }
};

// clipboard sync: browser -> device on tab focus (permission permitting)
window.addEventListener("focus", async () => {
    if (!currentSerial || !navigator.clipboard?.readText) return;
    try {
        const text = await navigator.clipboard.readText();
        if (text && text !== lastClipFromDevice && text !== lastClipToDevice) {
            lastClipToDevice = text;
            sendControl({ t: "clipboard", text });
        }
    } catch {} // permission denied — ignore silently
});

$("refresh").onclick = loadDevices;
loadDevices();
