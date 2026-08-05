import {
    WebCodecsVideoDecoder,
    WebGLVideoFrameRenderer,
    BitmapVideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs";

const ICE_SERVERS = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
];

// backend resolution: ?server= param > saved value > same-origin.
// lets the static page live on GitHub Pages while the backend sits
// behind a tunnel; the ⚙ button changes it at runtime.
const backendParam = new URLSearchParams(location.search).get("server");
if (backendParam !== null) {
    localStorage.setItem("tango-backend", backendParam.replace(/^[a-z]+:\/\//, "").replace(/\/$/, ""));
}
const BACKEND = localStorage.getItem("tango-backend") || "";
const HTTP_BASE = BACKEND ? `https://${BACKEND}` : "";
const WS_BASE = BACKEND
    ? `wss://${BACKEND}`
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;

function promptBackend() {
    const input = prompt("后端地址（tango-mirror 服务的域名，如 xxx.relay.hapi.run）：", BACKEND);
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

const PRESET_NAMES = { low: "流畅", medium: "平衡", high: "高清" };

let ws = null;
let decoder = null;
let writer = null;
let canvas = null;
let currentSerial = null;

let pc = null;
let dc = null;
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
    // static hosting (e.g. GitHub Pages) needs a backend configured first
    if (!BACKEND && location.hostname.endsWith("github.io")) {
        deviceSelect.innerHTML = "<option value=''>请先设置后端地址（⚙）</option>";
        promptBackend();
        return;
    }
    deviceSelect.innerHTML = "<option value=''>加载设备中…</option>";
    let devices = [];
    try {
        devices = await (await fetch(`${HTTP_BASE}/api/devices`)).json();
    } catch {
        deviceSelect.innerHTML = "<option value=''>加载失败，点 ⟳ 重试</option>";
        return;
    }
    deviceSelect.innerHTML = "<option value=''>选择设备…</option>";
    for (const d of devices) {
        const opt = document.createElement("option");
        opt.value = d.serial;
        opt.textContent = `${d.model?.replaceAll("_", " ") ?? d.product ?? "设备"} · ${d.serial}`;
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
    setBadge("连接中…");
    ws = new WebSocket(`${WS_BASE}/api/stream?serial=${encodeURIComponent(serial)}`);
    ws.binaryType = "arraybuffer";
    // negotiate WebRTC immediately, in parallel with scrcpy startup
    ws.onopen = () => tryWebRtc();

    ws.onmessage = async (ev) => {
        if (typeof ev.data === "string") {
            const msg = JSON.parse(ev.data);
            if (msg.type === "meta") {
                startDecoder(msg.codec);
                if (msg.preset) qualitySelect.value = msg.auto ? "auto" : msg.preset;
                if (path !== "rtc") setBadge("WS");
            } else if (msg.type === "quality") {
                // server auto-downshifted under congestion
                setBadge(`网络受限，已降为${PRESET_NAMES[msg.preset] ?? msg.preset}`, "p2p");
            } else if (msg.type === "clipboard") {
                lastClipFromDevice = msg.text;
                navigator.clipboard?.writeText(msg.text).catch(() => {});
            } else if (msg.type === "size") {
                lastSize = `${msg.width}×${msg.height}`;
                if (path !== "rtc") setBadge(`${lastSize} · WS`);
            } else if (msg.type === "error") {
                setBadge(`出错：${msg.message}`, "error");
            } else if (msg.t === "rtc-offer") {
                acceptRtcOffer(msg.sdp).catch((e) => {
                    console.warn("webrtc setup failed:", e);
                    teardownRtc();
                });
            } else if (msg.t === "rtc-ice") {
                pc?.addIceCandidate(msg.candidate).catch(() => {});
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
            setBadge(`解码出错：${e.message}`, "error");
        }
    };
    ws.onclose = () => {
        if (currentSerial === serial) setBadge("连接已断开", "error");
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
    if (typeof RTCPeerConnection === "undefined") return;
    sendWs({ t: "rtc-start" });
}

async function acceptRtcOffer(sdp) {
    pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pc.onicecandidate = (e) => {
        if (e.candidate) sendWs({ t: "rtc-ice", candidate: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
        if (pc && ["failed", "disconnected", "closed"].includes(pc.connectionState)) {
            teardownRtc();
        }
    };
    pc.ondatachannel = (e) => {
        dc = e.channel;
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
