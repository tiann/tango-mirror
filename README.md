# tango-mirror

View and control your WiFi/USB-connected Android devices from any browser.
A ~300-line self-hosted alternative to ws-scrcpy, built on
[ya-webadb (Tango)](https://github.com/yume-chan/ya-webadb) with the vanilla
scrcpy v3.1 server and WebCodecs hardware decoding.

## Usage

On the machine where `adb` runs (devices already connected via `adb connect` or USB):

```bash
npx tango-mirror              # default port 8010
npx tango-mirror --port 9000

# expose to the internet (tunnel backend auto-detected: tunwg > cloudflared)
npx tango-mirror --tunnel
npx tango-mirror --tunnel tunwg --tunnel-api relay.example.com --tunnel-auth user:pass
npx tango-mirror --tunnel cloudflared
```

Then open `http://localhost:8010`, or use the public URL printed by `--tunnel`.

Two tunnel backends are supported:

- [tunwg](https://github.com/tiann/tunwg) (preferred): **end-to-end encrypted**
  (the relay only routes TLS bytes by SNI — it cannot see your screen), stable
  URL across restarts, optional built-in basic auth via `--tunnel-auth`.
  If the relay requires issued keys, one is requested from `POST /issue`
  automatically and cached under `~/.config/tango-mirror/`.
- [cloudflared](https://github.com/cloudflare/cloudflared/releases): zero-config
  quick tunnel; note the URL is random per run, unauthenticated, and TLS
  terminates at Cloudflare's edge (they can see the traffic).

Note: the page uses WebCodecs, which requires a secure context
(`https://` or `localhost`).

The UI is localized (中文/English), following the browser language;
override with `?lang=en` / `?lang=zh` (remembered afterwards).

## Options

| Flag | Env | Default | |
|---|---|---|---|
| `--port`, `-p` | `PORT` | `8010` | HTTP/WebSocket listen port |
| `--adb-host` | `ADB_HOST` | `127.0.0.1` | adb server host |
| `--adb-port` | `ADB_PORT` | `5037` | adb server port |
| `--token` | `TANGO_TOKEN` | off | require this token for *everything*, including viewing |
| `--shell` | — | off | enable the device shell (gated by a token; generated if absent) |
| `--page` | `TANGO_PAGE` | — | static page URL to print a ready-to-open link for |
| `--tunnel [backend]` | — | off | expose publicly; backend `tunwg`, `cloudflared`, or auto |
| `--tunnel-api` | `TUNWG_API` | `l.tunwg.com` | tunwg relay server |
| `--tunnel-auth` | — | off | basic auth `user:pass` (tunwg only) |
| — | `TUNWG_BIN` | auto-detect | tunwg binary location |
| — | `CLOUDFLARED_PATH` | auto-detect | cloudflared binary location |

## How it works

```
browser ──HTTP/WS──▶ tango-mirror (Node)──TCP──▶ adb server ──▶ device
   ▲                        │                                    │
   │  H.264 packets over WS │  pushes scrcpy-server v3.1 jar,    │
   └─ WebCodecs decode      └─ starts it via app_process ────────┘
      touch/keys sent back ──▶ scrcpy control socket
```

There is no transcoding: the device's hardware H.264 encoder output is
relayed as-is to the browser, which decodes it with WebCodecs.

### WebRTC P2P mode (automatic)

After the WebSocket stream starts, the client automatically attempts a
WebRTC connection (signaling rides the existing WebSocket, so it works
through any tunnel). When ICE succeeds, video switches to a direct
peer-to-peer SRTP path — the tunnel then carries only a few KB of
signaling, which makes bandwidth-limited tunnels (e.g. tunwg's
end-to-end-encrypted relay) practical: use the tunnel for the page and
signaling, and let the video bytes flow browser⇆host directly.

- Same H.264 stream, repacketized as RFC 6184 RTP (still no transcoding)
- Opus audio (Android 11+) rides the same peer connection as a second
  track — the browser `<video>` element plays it natively (P2P mode only;
  toggle with the 🔇 button)
- Touch/key input moves to a DataChannel; browser PLI feedback triggers
  scrcpy keyframe resets
- If ICE fails or the connection drops, video falls back to the
  WebSocket path automatically (the status badge shows the active path)

### Quality presets & congestion control

The quality selector offers 流畅/平衡/高清 presets (800/1280/1920 max
size). Changing presets restarts the scrcpy encoder in-session — the
peer connection survives, so the picture just steps to the new quality.
In auto mode (default) the server watches WebRTC REMB bandwidth
estimates and downshifts one preset when the network can't keep up.
The receiver also requests zero jitter-buffer delay
(`playoutDelayHint`/`jitterBufferTarget`) for minimum glass-to-glass
latency.

### Device shell

`--shell` adds an interactive terminal (`>_` in the bottom bar) running
a real PTY on the device via the ADB shell protocol — `top`, `vi` and
Ctrl-C all work, and the terminal size is synced. It rides a dedicated
WebRTC DataChannel so output bursts (`logcat`) can't delay touch input,
falling back to the WebSocket when P2P is unavailable.

Because a shell is full control of the device, it always requires a
token — one is generated if you don't pass `--token`. Auth is tiered:
`--shell` alone gates *only* the shell (mirroring stays open, as
before), while an explicit `--token` locks down everything including
viewing.

On startup the server prints ready-to-open URLs with the token already
embedded — click one and you're in; the page saves the token and strips
it from the address bar. `--page https://you.github.io/tango-mirror/`
adds a link for a statically hosted frontend, pre-filled with both the
backend address and the token.

The token travels in a WebSocket subprotocol and an `Authorization`
header, never in a URL query; with tunwg the relay cannot see it, since
the tunnel is end-to-end encrypted.

### Clipboard sync

Bidirectional: copying on the device pushes into the browser clipboard;
focusing the tab pushes your local clipboard to the device (browser
permission permitting).

## License

MIT. Bundles the [scrcpy](https://github.com/Genymobile/scrcpy) server
binary (Apache-2.0, see `scrcpy-server.LICENSE`).
