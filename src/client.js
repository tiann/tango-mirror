import {
    WebCodecsVideoDecoder,
    WebGLVideoFrameRenderer,
    BitmapVideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs";

const ICE_SERVERS = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
];

const deviceListEl = document.getElementById("devices");
const stageEl = document.getElementById("stage");
const statusEl = document.getElementById("status");

let ws = null;
let decoder = null;
let writer = null;
let canvas = null;
let currentSerial = null;

let pc = null;
let dc = null;
let videoEl = null;
let path = "ws"; // "ws" | "rtc"

function setStatus(text) {
    statusEl.textContent = `${text}${currentSerial ? ` [${path === "rtc" ? "P2P" : "WS"}]` : ""}`;
}

async function loadDevices() {
    const res = await fetch("/api/devices");
    const devices = await res.json();
    deviceListEl.innerHTML = "";
    for (const d of devices) {
        const btn = document.createElement("button");
        btn.textContent = `${d.model ?? d.product ?? "device"} (${d.serial})`;
        btn.onclick = () => connect(d.serial);
        deviceListEl.appendChild(btn);
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
    dc = null;
    pc?.close();
    pc = null;
    videoEl?.remove();
    videoEl = null;
    if (path === "rtc") {
        path = "ws";
        if (canvas) canvas.style.display = "";
        sendWs({ t: "video-path", mode: "ws" });
        setStatus(`${currentSerial} — fell back to WebSocket video`);
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
}

function connect(serial) {
    disconnect();
    currentSerial = serial;
    setStatus(`connecting to ${serial}...`);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/stream?serial=${encodeURIComponent(serial)}`);
    ws.binaryType = "arraybuffer";

    ws.onmessage = async (ev) => {
        if (typeof ev.data === "string") {
            const msg = JSON.parse(ev.data);
            if (msg.type === "meta") {
                setStatus(`${serial} — ${msg.width}x${msg.height}, scrcpy v${msg.serverVersion}`);
                startDecoder(msg.codec);
                tryWebRtc();
            } else if (msg.type === "size") {
                setStatus(`${serial} — ${msg.width}x${msg.height}`);
            } else if (msg.type === "error") {
                setStatus(`error: ${msg.message}`);
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
            setStatus(`decode error: ${e.message}`);
        }
    };
    ws.onclose = () => setStatus(`${serial} disconnected`);
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

    canvas = renderer.canvas;
    canvas.className = "screen";
    stageEl.innerHTML = "";
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
        videoEl = document.createElement("video");
        videoEl.className = "screen";
        videoEl.autoplay = true;
        videoEl.muted = true;
        videoEl.playsInline = true;
        videoEl.style.display = "none";
        videoEl.srcObject = e.streams[0] ?? new MediaStream([e.track]);
        stageEl.appendChild(videoEl);
        attachInput(videoEl);
        // switch to the P2P path once real frames are decoding
        const onFrame = () => {
            if (!videoEl || path === "rtc") return;
            path = "rtc";
            if (canvas) canvas.style.display = "none";
            videoEl.style.display = "";
            sendWs({ t: "video-path", mode: "rtc" });
            setStatus(`${currentSerial} — ${videoEl.videoWidth}x${videoEl.videoHeight}`);
        };
        if (videoEl.requestVideoFrameCallback) {
            videoEl.requestVideoFrameCallback(onFrame);
        } else {
            videoEl.addEventListener("resize", onFrame, { once: true });
        }
    };
    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendWs({ t: "rtc-answer", sdp: answer.sdp });
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

    window.onkeydown = (e) => {
        if (e.target.tagName === "INPUT") return;
        if (e.key === "Backspace") sendControl({ t: "key", code: 67, a: "down" });
        else if (e.key === "Enter") sendControl({ t: "key", code: 66, a: "down" });
        else if (e.key.length === 1) sendControl({ t: "text", text: e.key });
    };
    window.onkeyup = (e) => {
        if (e.target.tagName === "INPUT") return;
        if (e.key === "Backspace") sendControl({ t: "key", code: 67, a: "up" });
        else if (e.key === "Enter") sendControl({ t: "key", code: 66, a: "up" });
    };
}

for (const [id, code] of [["btn-back", 4], ["btn-home", 3], ["btn-recents", 187], ["btn-power", 26]]) {
    document.getElementById(id).onclick = () => {
        sendControl({ t: "key", code, a: "down" });
        sendControl({ t: "key", code, a: "up" });
    };
}

document.getElementById("refresh").onclick = loadDevices;
loadDevices();
