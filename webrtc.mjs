import {
    MediaStreamTrack,
    RTCPeerConnection,
    RTCRtpCodecParameters,
    RtpHeader,
    RtpPacket,
} from "werift";

const RTP_MTU = 1200;
const PAYLOAD_TYPE = 96;

const DEFAULT_ICE_SERVERS = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
];

// RFC 6184 packetizer: Annex B access units -> single-NAL / FU-A RTP packets
class H264Packetizer {
    #seq = Math.floor(Math.random() * 0xffff);
    #ssrc = Math.floor(Math.random() * 0xffffffff);
    #configNalus = [];

    setConfig(data) {
        this.#configNalus = splitAnnexB(data);
    }

    #packet(payload, timestamp, marker) {
        const header = new RtpHeader({
            payloadType: PAYLOAD_TYPE,
            sequenceNumber: this.#seq,
            timestamp,
            ssrc: this.#ssrc,
            marker,
        });
        this.#seq = (this.#seq + 1) & 0xffff;
        return new RtpPacket(header, Buffer.from(payload));
    }

    packetize(data, timestamp, keyframe) {
        let nalus = splitAnnexB(data);
        if (keyframe && this.#configNalus.length) {
            // repeat SPS/PPS before each IDR so late joiners can decode
            nalus = [...this.#configNalus, ...nalus];
        }
        const packets = [];
        for (let i = 0; i < nalus.length; i++) {
            const nalu = nalus[i];
            const last = i === nalus.length - 1;
            if (nalu.length <= RTP_MTU) {
                packets.push(this.#packet(nalu, timestamp, last));
                continue;
            }
            // FU-A fragmentation
            const indicator = (nalu[0] & 0xe0) | 28;
            const type = nalu[0] & 0x1f;
            let offset = 1;
            while (offset < nalu.length) {
                const end = Math.min(offset + RTP_MTU - 2, nalu.length);
                const start = offset === 1;
                const fin = end === nalu.length;
                const fuHeader = (start ? 0x80 : 0) | (fin ? 0x40 : 0) | type;
                const payload = Buffer.concat([
                    Buffer.from([indicator, fuHeader]),
                    nalu.subarray(offset, end),
                ]);
                packets.push(this.#packet(payload, timestamp, last && fin));
                offset = end;
            }
        }
        return packets;
    }
}

function splitAnnexB(data) {
    const nalus = [];
    let start = -1;
    for (let i = 0; i + 2 < data.length; i++) {
        if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
            if (start !== -1) {
                let end = i;
                if (i > 0 && data[i - 1] === 0) end = i - 1;
                nalus.push(data.subarray(start, end));
            }
            start = i + 3;
            i += 2;
        }
    }
    if (start !== -1) nalus.push(data.subarray(start));
    return nalus;
}

export function createRtcSession({ sendSignal, onControl, log }) {
    const pc = new RTCPeerConnection({
        codecs: {
            video: [
                new RTCRtpCodecParameters({
                    mimeType: "video/H264",
                    clockRate: 90000,
                    payloadType: PAYLOAD_TYPE,
                    rtcpFeedback: [
                        { type: "nack" },
                        { type: "nack", parameter: "pli" },
                        { type: "goog-remb" },
                    ],
                    parameters:
                        "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
                }),
            ],
        },
        iceServers: DEFAULT_ICE_SERVERS,
    });

    const track = new MediaStreamTrack({ kind: "video" });
    pc.addTransceiver(track, { direction: "sendonly" });

    const channel = pc.createDataChannel("control", { ordered: true });
    channel.onMessage.subscribe((msg) => {
        try {
            onControl(JSON.parse(String(msg)));
        } catch {}
    });

    // browser PLI (e.g. after packet loss) -> ask scrcpy for a fresh keyframe
    let lastPli = 0;
    let onKeyframeRequest;
    track.onReceiveRtcp.subscribe((rtcp) => {
        if (rtcp.type === 206 || rtcp.type === 205) {
            const now = Date.now();
            if (now - lastPli > 1000) {
                lastPli = now;
                onKeyframeRequest?.();
            }
        }
    });

    pc.onIceCandidate.subscribe((candidate) => {
        if (candidate) {
            sendSignal({ t: "rtc-ice", candidate: candidate.toJSON() });
        }
    });

    let connected = false;
    pc.connectionStateChange.subscribe((state) => {
        log?.(`webrtc: ${state}`);
        const wasConnected = connected;
        connected = state === "connected";
        // request an IDR immediately so the first P2P frames are decodable
        if (connected && !wasConnected) onKeyframeRequest?.();
    });

    const packetizer = new H264Packetizer();

    return {
        get connected() {
            return connected;
        },
        set onKeyframeRequest(fn) {
            onKeyframeRequest = fn;
        },
        async start() {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            sendSignal({ t: "rtc-offer", sdp: pc.localDescription.sdp });
        },
        async handleAnswer(sdp) {
            await pc.setRemoteDescription({ type: "answer", sdp });
        },
        async handleIce(candidate) {
            await pc.addIceCandidate(candidate).catch(() => {});
        },
        sendVideoPacket(packet) {
            if (packet.type === "configuration") {
                packetizer.setConfig(packet.data);
                return;
            }
            // scrcpy pts is in microseconds; RTP video clock is 90 kHz
            const ts = Number(((packet.pts ?? 0n) * 9n / 100n) & 0xffffffffn);
            for (const rtp of packetizer.packetize(packet.data, ts, packet.keyframe)) {
                track.writeRtp(rtp);
            }
        },
        close() {
            pc.close().catch(() => {});
        },
    };
}
