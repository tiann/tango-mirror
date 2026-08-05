import {
    MediaStreamTrack,
    PictureLossIndication,
    RTCPeerConnection,
    RTCRtpCodecParameters,
    ReceiverEstimatedMaxBitrate,
    RtpHeader,
    RtpPacket,
} from "werift";

const RTP_MTU = 1200;
const VIDEO_PT = 96;
const AUDIO_PT = 111;

const DEFAULT_ICE_SERVERS = [
    { urls: "stun:stun.cloudflare.com:3478" },
    { urls: "stun:stun.l.google.com:19302" },
];

class RtpStreamState {
    seq = Math.floor(Math.random() * 0xffff);
    ssrc = Math.floor(Math.random() * 0xffffffff);

    packet(payloadType, payload, timestamp, marker) {
        const header = new RtpHeader({
            payloadType,
            sequenceNumber: this.seq,
            timestamp,
            ssrc: this.ssrc,
            marker,
        });
        this.seq = (this.seq + 1) & 0xffff;
        return new RtpPacket(header, Buffer.from(payload));
    }
}

// RFC 6184 packetizer: Annex B access units -> single-NAL / FU-A RTP packets
class H264Packetizer extends RtpStreamState {
    #configNalus = [];

    setConfig(data) {
        this.#configNalus = splitAnnexB(data);
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
                packets.push(this.packet(VIDEO_PT, nalu, timestamp, last));
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
                packets.push(this.packet(VIDEO_PT, payload, timestamp, last && fin));
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
                    payloadType: VIDEO_PT,
                    rtcpFeedback: [
                        { type: "nack" },
                        { type: "nack", parameter: "pli" },
                        { type: "goog-remb" },
                    ],
                    parameters:
                        "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
                }),
            ],
            audio: [
                new RTCRtpCodecParameters({
                    mimeType: "audio/opus",
                    clockRate: 48000,
                    channels: 2,
                    payloadType: AUDIO_PT,
                }),
            ],
        },
        iceServers: DEFAULT_ICE_SERVERS,
    });

    const videoTrack = new MediaStreamTrack({ kind: "video" });
    pc.addTransceiver(videoTrack, { direction: "sendonly" });
    const audioTrack = new MediaStreamTrack({ kind: "audio" });
    pc.addTransceiver(audioTrack, { direction: "sendonly" });

    const channel = pc.createDataChannel("control", { ordered: true });
    channel.onMessage.subscribe((msg) => {
        try {
            onControl(JSON.parse(String(msg)));
        } catch {}
    });

    let lastPli = 0;
    let onKeyframeRequest;
    let onBitrateEstimate;
    videoTrack.onReceiveRtcp.subscribe((rtcp) => {
        const feedback = rtcp.feedback;
        if (feedback instanceof ReceiverEstimatedMaxBitrate) {
            onBitrateEstimate?.(Number(feedback.bitrate));
        } else if (feedback instanceof PictureLossIndication || rtcp.type === 205) {
            // PLI (or transport NACK burst) -> ask scrcpy for a fresh keyframe
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

    const videoPacketizer = new H264Packetizer();
    const audioStream = new RtpStreamState();

    return {
        get connected() {
            return connected;
        },
        set onKeyframeRequest(fn) {
            onKeyframeRequest = fn;
        },
        set onBitrateEstimate(fn) {
            onBitrateEstimate = fn;
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
                videoPacketizer.setConfig(packet.data);
                return;
            }
            // scrcpy pts is in microseconds; RTP video clock is 90 kHz
            const ts = Number(((packet.pts ?? 0n) * 9n / 100n) & 0xffffffffn);
            for (const rtp of videoPacketizer.packetize(packet.data, ts, packet.keyframe)) {
                videoTrack.writeRtp(rtp);
            }
        },
        sendAudioPacket(packet) {
            if (packet.type === "configuration") return; // opus id header, not RTP payload
            // one opus frame per RTP packet; 48 kHz clock from microsecond pts
            const ts = Number(((packet.pts ?? 0n) * 48n / 1000n) & 0xffffffffn);
            audioTrack.writeRtp(audioStream.packet(AUDIO_PT, packet.data, ts, false));
        },
        close() {
            pc.close().catch(() => {});
        },
    };
}
