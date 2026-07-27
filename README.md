# android-streamer

Stream any number of phone cameras to a PC browser dashboard in real time over the local network (WebRTC), with automatic server-side recording per device.

## Setup

```
npm install
npm start
```

The server prints two URLs and a QR code:

1. **PC**: open `https://localhost:8443/viewer` (or `/dashboard`) in your browser.
2. **Phones**: scan the QR code (or open `https://<PC-IP>:8443/phone`) on each phone, same Wi-Fi as the PC.

Both devices show a "connection not private" warning once (self-signed certificate) — tap **Advanced → Proceed**. Then allow camera access on the phone.

## Features

- Multi-device dashboard: every connected phone appears as a live tile with the device count in the header. Click a tile to enlarge one device, click again to go back.
- **Combined** toggle: composites all live feeds onto a single canvas (auto grid layout, labeled), so every device shows in one video surface; Fullscreen expands whatever view is active.
- Sub-second latency live view (WebRTC, direct P2P over LAN)
- Automatic recording: every phone session is saved to `recordings/<timestamp>_phone<id>.webm` (plays in VLC or any browser)
- Camera switch button (rear/front) — starts a new recording file
- Optional microphone audio: **Mic** toggle on the phone (off by default). Audio is included in both the live stream and the recording; toggling starts a new recording file. On the viewer, click **Sound: off** to unmute (browsers require a click before playing audio).
- Resolution selector on the phone (480p / 720p / 1080p) — phone camera picks the closest supported mode; change starts a new recording file
- Auto-reconnect on either side
- Screen wake lock on the phone while streaming

## Notes

- Any number of phones; one dashboard viewer at a time (a new viewer replaces the old one).
- A recording with 0 bytes usually means the phone's screen was off or the browser was in the background — the camera stops delivering frames there. Keep the phone page in the foreground.
- The certificate is generated into `certs/` on first run; delete the folder to regenerate (e.g. after your PC's LAN IP changes).
- Recordings are only limited by disk space; delete old files from `recordings/` manually.
