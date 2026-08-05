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
npx tango-mirror --tunnel     # also start a cloudflared quick tunnel
                              # and print the public trycloudflare.com URL
```

Then open `http://localhost:8010`, or use the tunnel URL printed by
`--tunnel` (requires [cloudflared](https://github.com/cloudflare/cloudflared/releases)
installed; the URL is public and unauthenticated — share carefully).

Note: the page uses WebCodecs, which requires a secure context
(`https://` or `localhost`).

## Options

| Flag | Env | Default | |
|---|---|---|---|
| `--port`, `-p` | `PORT` | `8010` | HTTP/WebSocket listen port |
| `--adb-host` | `ADB_HOST` | `127.0.0.1` | adb server host |
| `--adb-port` | `ADB_PORT` | `5037` | adb server port |
| `--tunnel` | — | off | expose via cloudflared quick tunnel |
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

## License

MIT. Bundles the [scrcpy](https://github.com/Genymobile/scrcpy) server
binary (Apache-2.0, see `scrcpy-server.LICENSE`).
