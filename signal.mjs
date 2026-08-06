// Serverless signaling: small encrypted JSON messages exchanged through
// public MQTT brokers over WebSocket, so the host and a browser can meet
// without anyone running a server. Only session control and SDP/ICE travel
// here (a few KB per session); media always rides WebRTC.
//
// The key never reaches the brokers: the room topic is a one-way hash of
// it, payloads are AES-256-GCM, and anything that doesn't decrypt is
// ignored. Brokers see ciphertext and timing, nothing else.
//
// Shared verbatim between Node (server.mjs) and the browser bundle — no
// dependencies. Pass WebSocketImpl where there is no global WebSocket.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const DEFAULT_BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker-cn.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
];

export const b64u = {
    encode: (bytes) =>
        btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""),
    decode: (s) =>
        Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0)),
};

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// ---- MQTT 3.1.1, the QoS-0 subset we need (~150 lines) -------------------
// A full client library would be ~150 KB in the browser bundle; publishing
// and subscribing over WebSocket needs only CONNECT/SUBSCRIBE/PUBLISH/PING.

const mqttStr = (s) => {
    const b = enc.encode(s);
    return [b.length >> 8, b.length & 0xff, ...b];
};

function mqttPacket(type, body) {
    const len = [];
    let n = body.length;
    do {
        let d = n % 128;
        n = Math.floor(n / 128);
        if (n > 0) d |= 0x80;
        len.push(d);
    } while (n > 0);
    return new Uint8Array([type, ...len, ...body]);
}

class MqttClient {
    #url; #WS; #onPublish; #onReady; #log;
    #ws = null;
    #ready = false;
    #closed = false;
    #topics = new Set();
    #queue = [];
    #buf = new Uint8Array(0);
    #ping = null;
    #retry = null;

    constructor(url, { onPublish, onReady, log, WebSocketImpl }) {
        this.#url = url;
        this.#WS = WebSocketImpl;
        this.#onPublish = onPublish;
        this.#onReady = onReady;
        this.#log = log;
        this.#connect();
    }

    #connect() {
        let ws;
        try {
            ws = new this.#WS(this.#url, "mqtt");
        } catch {
            return this.#reconnect();
        }
        this.#ws = ws;
        this.#buf = new Uint8Array(0);
        ws.binaryType = "arraybuffer";
        ws.onopen = () => {
            const id = `tango-${hex(crypto.getRandomValues(new Uint8Array(8)))}`;
            ws.send(mqttPacket(0x10, [...mqttStr("MQTT"), 4, 0x02, 0, 60, ...mqttStr(id)]));
        };
        ws.onmessage = (ev) => this.#feed(new Uint8Array(ev.data));
        ws.onerror = () => {}; // close always follows
        ws.onclose = () => this.#reconnect();
    }

    #reconnect() {
        this.#ready = false;
        clearInterval(this.#ping);
        if (this.#closed) return;
        clearTimeout(this.#retry);
        this.#retry = setTimeout(() => this.#connect(), 5000);
        this.#retry.unref?.();
    }

    // a WebSocket frame MAY contain multiple or partial MQTT packets
    #feed(chunk) {
        const merged = new Uint8Array(this.#buf.length + chunk.length);
        merged.set(this.#buf);
        merged.set(chunk, this.#buf.length);
        this.#buf = merged;
        while (this.#buf.length >= 2) {
            let len = 0;
            let mult = 1;
            let i = 1;
            for (;;) {
                if (i >= this.#buf.length) return; // need more bytes
                const d = this.#buf[i++];
                len += (d & 0x7f) * mult;
                if (!(d & 0x80)) break;
                mult *= 128;
                if (i > 5) { this.#buf = new Uint8Array(0); return; } // malformed
            }
            const total = i + len;
            if (this.#buf.length < total) return;
            this.#packet(this.#buf[0], this.#buf.subarray(i, total));
            this.#buf = this.#buf.slice(total);
        }
    }

    #packet(first, body) {
        const type = first & 0xf0;
        if (type === 0x20) { // CONNACK
            if (body[1] !== 0) {
                this.#log(`mqtt: ${this.#url} refused connection (rc=${body[1]})`);
                return this.close();
            }
            this.#ready = true;
            for (const t of this.#topics) this.#sub(t);
            for (const [topic, payload] of this.#queue.splice(0)) this.publish(topic, payload);
            clearInterval(this.#ping);
            this.#ping = setInterval(() => this.#send(new Uint8Array([0xc0, 0])), 25_000);
            this.#ping.unref?.();
            this.#onReady?.();
        } else if (type === 0x30) { // PUBLISH
            const tlen = (body[0] << 8) | body[1];
            let off = 2 + tlen;
            if ((first >> 1) & 3) off += 2; // QoS>0 carries a packet id
            this.#onPublish(dec.decode(body.subarray(2, 2 + tlen)), body.subarray(off));
        }
    }

    #send(pkt) {
        if (this.#ws?.readyState === 1) this.#ws.send(pkt);
    }

    #sub(topic) {
        this.#send(mqttPacket(0x82, [0, 1, ...mqttStr(topic), 0]));
    }

    subscribe(topic) {
        this.#topics.add(topic);
        if (this.#ready) this.#sub(topic);
    }

    publish(topic, payload) {
        if (this.#ready) this.#send(mqttPacket(0x30, [...mqttStr(topic), ...payload]));
        else if (this.#queue.length < 64) this.#queue.push([topic, payload]);
    }

    close() {
        this.#closed = true;
        clearInterval(this.#ping);
        clearTimeout(this.#retry);
        try {
            this.#ws?.close();
        } catch {}
    }
}

// ---- the room -------------------------------------------------------------

export class SignalRoom {
    onmessage = null;
    #key; #pub; #log;
    #clients = [];
    #seen = new Set();
    #chain = Promise.resolve();

    // resolves once any broker accepts us (or rejects after waitMs)
    static async create({ key, role, brokers = DEFAULT_BROKERS, log = () => {}, WebSocketImpl = globalThis.WebSocket, waitMs = 10_000 }) {
        const room = new SignalRoom();
        room.#log = log;
        room.#key = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
        const digest = new Uint8Array(
            await crypto.subtle.digest("SHA-256", enc.encode(`tango-mirror-room:${b64u.encode(key)}`)),
        );
        const rid = hex(digest.subarray(0, 10));
        const me = role === "host" ? "h" : "v";
        room.#pub = `tango-mirror/${rid}/${me}`;
        const sub = `tango-mirror/${rid}/${me === "h" ? "v" : "h"}`;

        let onReady;
        const ready = new Promise((r) => { onReady = r; });
        // decrypt is async: serialize dispatch so message order survives
        const onPublish = (_topic, payload) => {
            room.#chain = room.#chain.then(() => room.#recv(payload));
        };
        for (const url of brokers) {
            const c = new MqttClient(url, { onPublish, onReady, log, WebSocketImpl });
            c.subscribe(sub);
            room.#clients.push(c);
        }
        const timer = setTimeout(() => onReady("timeout"), waitMs);
        timer.unref?.();
        if ((await ready) === "timeout") {
            room.close();
            throw new Error("no signaling broker reachable");
        }
        clearTimeout(timer);
        return room;
    }

    async send(obj) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(
            await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.#key, enc.encode(JSON.stringify(obj))),
        );
        const payload = new Uint8Array(12 + ct.length);
        payload.set(iv);
        payload.set(ct, 12);
        for (const c of this.#clients) c.publish(this.#pub, payload);
    }

    async #recv(payload) {
        if (payload.length < 29) return; // 12 iv + 16 tag + content
        const id = hex(payload.subarray(0, 12));
        if (this.#seen.has(id)) return; // same message via another broker
        this.#seen.add(id);
        if (this.#seen.size > 1024) this.#seen.delete(this.#seen.values().next().value);
        try {
            const pt = await crypto.subtle.decrypt(
                { name: "AES-GCM", iv: payload.subarray(0, 12) },
                this.#key,
                payload.subarray(12),
            );
            this.onmessage?.(JSON.parse(dec.decode(pt)));
        } catch {
            // not ours or corrupted — the topic is public, after all
        }
    }

    close() {
        for (const c of this.#clients) c.close();
    }
}
