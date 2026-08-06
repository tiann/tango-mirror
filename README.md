# tango-mirror

[![npm](https://img.shields.io/npm/v/tango-mirror)](https://www.npmjs.com/package/tango-mirror)
[![license](https://img.shields.io/npm/l/tango-mirror)](./LICENSE)

See and control your Android devices from any browser — including over the
internet, without port forwarding.

```bash
npx tango-mirror --tunnel
```

That prints a link (and a QR code) you can open anywhere. Video and touch
travel peer-to-peer, so the tunnel only carries a few KB of signaling.

## What you get

- **Any browser, any device** — no app to install; open the page on a phone,
  laptop, or tablet
- **Real remote access** — a tunnel gets you in from outside your network, and
  WebRTC then connects browser⇆host directly for low latency
- **Screen + audio + touch** — hardware H.264 and Opus straight from the
  device, no transcoding
- **Clipboard sync** in both directions
- **Device shell** — a real terminal on the device (`--shell`)
- **Adjustable quality** with automatic downshift on weak networks
- Works with several devices at once; pick from a list

## Requirements

- Node.js 20+
- `adb` on the host, with your devices already visible to it:
  `adb devices` should list them (`adb connect <ip>:5555` for WiFi, or plug
  in USB)
- Android 5+ for screen; audio needs Android 11+
- A recent browser (uses WebCodecs / WebRTC). The page must be served over
  `https://` or `localhost` — the printed links already are

## Getting started

**Just on this machine**

```bash
npx tango-mirror
```

Open the printed `http://localhost:8010/` link.

**From anywhere (phone, another network)**

```bash
npx tango-mirror --tunnel
```

Scan the QR code or open the printed link. The tunnel gives you a public
HTTPS address; no router or firewall changes needed.

**With a shell on the device**

```bash
npx tango-mirror --tunnel --shell
```

Adds a `>_` button opening a real terminal on the device. This one requires
the token that's printed at startup — it's already embedded in the links.

## Everyday things

| I want to… | Do this |
|---|---|
| Type into the device | Click the screen and type, or use the ⌨ button on mobile |
| Copy text between device and computer | Just copy — it syncs both ways |
| Save bandwidth on a slow link | Pick 流畅/Smooth in the quality selector (or leave it on Auto) |
| Hear the device | Click 🔇 (audio only flows in P2P mode) |
| Use a different port | `--port 9000` |
| Keep the same URL across restarts | Use the tunwg backend — its URL is derived from a local key and stays stable |
| Keep video off the tunnel when P2P fails | Add a TURN relay, e.g. `--turn cloudflare` — see [TURN](#turn-keeping-the-fallback-off-your-relay) |
| Lock down viewing too, not just the shell | `--token yoursecret` |
| Run without any external site | `--no-page` (serves the UI itself) |

## Options

Run `tango-mirror --help` for the same list.

| Flag | Env | Default | |
|---|---|---|---|
| `--port`, `-p` | `PORT` | `8010` | HTTP/WebSocket listen port |
| `--adb-host` | `ADB_HOST` | `127.0.0.1` | adb server host |
| `--adb-port` | `ADB_PORT` | `5037` | adb server port |
| `--shell` | — | off | enable the device shell (needs a token; generated if absent) |
| `--token` | `TANGO_TOKEN` | off | require this token for *everything*, viewing included |
| `--tunnel [backend]` | — | off | expose publicly; `tunwg`, `cloudflared`, or auto |
| `--tunnel-api` | `TUNWG_API` | `relay.hapi.run` | tunwg relay server |
| `--tunnel-auth` | — | off | basic auth `user:pass` (tunwg only) |
| `--turn <target>` | `TURN_URL` | off | TURN relay for failed P2P: `cloudflare` or a `turn:`/`turns:` URL |
| `--turn-auth` | `TURN_AUTH` | — | `user:pass` for a `--turn` URL |
| — | `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN` | — | Cloudflare TURN key, used by `--turn cloudflare` |
| `--page` | `TANGO_PAGE` | project page | frontend to point remote visitors at |
| `--no-page` | — | off | serve the bundled page instead |
| `--no-qr` | — | off | don't print the QR code |
| — | `TUNWG_BIN` | auto-detect | tunwg binary location |
| — | `CLOUDFLARED_PATH` | auto-detect | cloudflared binary location |

The UI follows your browser language (中文/English); `?lang=en` or `?lang=zh`
overrides it.

## Troubleshooting

**No devices listed** — run `adb devices` on the host. tango-mirror only sees
what adb sees. For WiFi devices, `adb connect <ip>:5555` first.

**"port 8010 is already in use"** — another copy is running; use `--port`.

**Tunnel won't start** — the error from the tunnel itself is printed below the
message. A missing binary means `tunwg`/`cloudflared` isn't installed; an
unreachable relay means you should try `--tunnel-api <host>`. Local serving
keeps working either way.

**Stuck on `WS` instead of `P2P`** — WebRTC couldn't establish a direct path
(symmetric NAT or CGNAT on one side). Everything still works through the
tunnel, just with more latency and tunnel traffic. A TURN relay
([`--turn`](#turn-keeping-the-fallback-off-your-relay)) usually gets such
connections onto WebRTC anyway.

**Shell button missing** — the server wasn't started with `--shell`, or the
page was opened without the token. Use the link printed at startup.

**Black screen after connecting** — force-reload the page (`Ctrl+Shift+R`) to
clear a stale cached bundle.

**`npx`/`bunx` runs an old version** — clear the runner's cache, e.g.
`rm -rf /tmp/bunx-*-tango-mirror@latest`, or pin the version explicitly.

## How it works

```
browser ──HTTPS/WSS──▶ tunnel ──▶ tango-mirror (Node) ──▶ adb ──▶ device
   ╰────────── WebRTC: video, audio, touch, shell ──────────╯
```

tango-mirror pushes the stock scrcpy v3.1 server to the device and starts it
through adb, then relays what comes back. The device's hardware H.264 encoder
output is **never transcoded** — it's repacketized as RTP and sent over
WebRTC, or framed over the WebSocket as a fallback.

The browser first connects over WebSocket (through the tunnel) and decodes
with WebCodecs. In parallel it negotiates WebRTC using that WebSocket for
signaling; once a peer-to-peer path is up, video switches to it and the
WebSocket stream pauses. Touch, keys and the shell move to DataChannels. If
ICE fails or the connection drops, everything falls back automatically — the
status badge shows which path is live.

Because the media never touches the tunnel in P2P mode, bandwidth-limited or
end-to-end-encrypted relays remain practical. For the same reason the page
itself is served from a CDN: visitors arriving through a tunnel get a small
notice page linking to the hosted frontend rather than pulling the bundle
through your relay.

### Security

The shell means full control of the device, so it always requires a token —
generated and printed at startup if you don't set one. Auth is tiered:
`--shell` gates only the shell, while `--token` locks down viewing as well.
The token travels in a WebSocket subprotocol and an `Authorization` header,
never in a URL query, and is compared in constant time. With the tunwg
backend the relay cannot read any of it — the tunnel is end-to-end encrypted
and it only routes TLS bytes by SNI.

### Tunnel backends

- **[tunwg](https://github.com/tiann/tunwg)** (preferred) — end-to-end
  encrypted, and the URL stays the same across restarts. Defaults to the
  `relay.hapi.run` relay; use `--tunnel-api` for your own. If a relay issues
  keys, one is fetched and cached under `~/.config/tango-mirror/`.
- **[cloudflared](https://github.com/cloudflare/cloudflared/releases)** —
  zero setup, but the URL is random per run and TLS terminates at
  Cloudflare's edge, so they can see the traffic.

### TURN: keeping the fallback off your relay

When WebRTC can't find a direct path (symmetric NAT or CGNAT), video falls
back to the WebSocket — and the full stream rides the tunnel. If that
tunnel is a tunwg relay you host, that's your bandwidth bill. Point
`--turn` at a TURN server and the fallback stays on WebRTC instead:

```bash
# Cloudflare TURN (1,000 GB/month free): create a TURN key under
# Realtime → TURN in the Cloudflare dashboard, then
CF_TURN_KEY_ID=… CF_TURN_API_TOKEN=… tango-mirror --tunnel --turn cloudflare
```

`--turn` takes two forms: `cloudflare`, which mints short-lived credentials
on demand, or a `turn:`/`turns:` URL plus `--turn-auth user:pass` for your
own coturn or any provider that hands out static credentials (Metered,
ExpressTURN, …). Either way the credentials ride to the browser with the
WebRTC offer — nothing to configure on the viewing side.

Media through TURN stays DTLS-encrypted end to end; the relay forwards
packets it cannot read, so a third-party TURN service gets no eyes on your
screen. There is no default TURN server — the once-popular free public
relays (Open Relay and friends) are dead.

### Hosting the frontend yourself

The UI is static (`public/`), and the repo ships a GitHub Action that
publishes it to `gh-pages` on every push. Deploy it anywhere, then start with
`--page https://your-url/`. For offline or LAN-only setups, `--no-page` makes
the server deliver the page itself with no external dependency.

## Built on

[ya-webadb (Tango)](https://github.com/yume-chan/ya-webadb) for the ADB and
scrcpy protocols, [werift](https://github.com/shinyoshiaki/werift-webrtc) for
WebRTC, [xterm.js](https://xtermjs.org/) for the terminal, and the stock
[scrcpy](https://github.com/Genymobile/scrcpy) server.

## License

MIT. Bundles the scrcpy server binary (Apache-2.0, see
`scrcpy-server.LICENSE`).
