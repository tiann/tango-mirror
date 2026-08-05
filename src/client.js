import {
    WebCodecsVideoDecoder,
    WebGLVideoFrameRenderer,
    BitmapVideoFrameRenderer,
} from "@yume-chan/scrcpy-decoder-webcodecs";

const deviceListEl = document.getElementById("devices");
const stageEl = document.getElementById("stage");
const statusEl = document.getElementById("status");

let ws = null;
let decoder = null;
let writer = null;

function setStatus(text) {
    statusEl.textContent = text;
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

function disconnect() {
    ws?.close();
    ws = null;
    writer?.releaseLock();
    writer = null;
    decoder?.dispose();
    decoder = null;
    stageEl.innerHTML = "";
}

function connect(serial) {
    disconnect();
    setStatus(`connecting to ${serial}...`);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/api/stream?serial=${encodeURIComponent(serial)}`);
    ws.binaryType = "arraybuffer";

    ws.onmessage = async (ev) => {
        if (typeof ev.data === "string") {
            const msg = JSON.parse(ev.data);
            if (msg.type === "meta") {
                setStatus(`${serial} — ${msg.width}x${msg.height}, scrcpy v${msg.serverVersion}`);
                startDecoder(msg.codec, serial);
            } else if (msg.type === "size") {
                setStatus(`${serial} — ${msg.width}x${msg.height}`);
            } else if (msg.type === "error") {
                setStatus(`error: ${msg.message}`);
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

function startDecoder(codec, serial) {
    let renderer;
    try {
        renderer = new WebGLVideoFrameRenderer();
    } catch {
        renderer = new BitmapVideoFrameRenderer();
    }
    decoder = new WebCodecsVideoDecoder({ codec, renderer });
    writer = decoder.writable.getWriter();

    const canvas = renderer.canvas;
    canvas.id = "screen";
    stageEl.innerHTML = "";
    stageEl.appendChild(canvas);
    attachInput(canvas);
}

function attachInput(canvas) {
    const send = (obj) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    };
    const norm = (e) => {
        const rect = canvas.getBoundingClientRect();
        return {
            x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
            y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
        };
    };
    let down = false;
    canvas.onpointerdown = (e) => {
        canvas.setPointerCapture(e.pointerId);
        down = true;
        send({ t: "touch", a: "down", ...norm(e) });
        e.preventDefault();
    };
    canvas.onpointermove = (e) => {
        if (down) send({ t: "touch", a: "move", ...norm(e) });
    };
    const up = (e) => {
        if (down) send({ t: "touch", a: "up", ...norm(e) });
        down = false;
    };
    canvas.onpointerup = up;
    canvas.onpointercancel = up;
    canvas.onwheel = (e) => {
        e.preventDefault();
        send({ t: "scroll", ...norm(e), dx: -e.deltaX / 100, dy: -e.deltaY / 100 });
    };
    canvas.oncontextmenu = (e) => e.preventDefault();

    window.onkeydown = (e) => {
        if (e.target.tagName === "INPUT") return;
        if (e.key === "Backspace") send({ t: "key", code: 67, a: "down" });
        else if (e.key === "Enter") send({ t: "key", code: 66, a: "down" });
        else if (e.key.length === 1) send({ t: "text", text: e.key });
    };
    window.onkeyup = (e) => {
        if (e.target.tagName === "INPUT") return;
        if (e.key === "Backspace") send({ t: "key", code: 67, a: "up" });
        else if (e.key === "Enter") send({ t: "key", code: 66, a: "up" });
    };
}

for (const [id, code] of [["btn-back", 4], ["btn-home", 3], ["btn-recents", 187], ["btn-power", 26]]) {
    const el = document.getElementById(id);
    el.onclick = () => {
        if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ t: "key", code, a: "down" }));
            ws.send(JSON.stringify({ t: "key", code, a: "up" }));
        }
    };
}

document.getElementById("refresh").onclick = loadDevices;
loadDevices();
