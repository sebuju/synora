# synora

*syn + hórama — "seeing together".*

Multi-client camera system for a local network. N clients stream video peer-to-peer (WebRTC) to a single browser dashboard; the server handles signaling, per-device recording, and optionally exposes a feed as a Windows virtual webcam. With ArUco tags placed in the room, the clients additionally localize themselves in a shared room frame and feed a monocular-depth mapping pipeline that builds a voxel occupancy map and a fitted wall layer.

No build step, no app install: vanilla JS served as static files. A client is any phone (or tablet) pointed at a web page.

## Contents

- [Setup](#setup)
- [Architecture](#architecture)
- [Frame sync](#frame-sync)
- [Room positioning](#room-positioning)
- [Room mapping](#room-mapping)
- [Virtual webcam](#virtual-webcam)
- [Recordings](#recordings)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)

## Setup

Requirements: Node ≥ 18. Clients and PC on the same LAN.

```bash
npm install
npm run fetch-vendor   # opencv.js, three.js, depth models — required for positioning/mapping
npm start              # or: npm run dev (node --watch)
```

`fetch-vendor` downloads third-party assets into gitignored directories (`public/vendor/`, `models/`). Without them the server runs and streams; the positioning and mapping features are disabled, and the startup log lists what is missing.

The server listens on `:8443` (HTTPS + WSS) and prints both URLs and a QR code:

- Dashboard: `https://localhost:8443/viewer`
- Clients: `https://<LAN-IP>:8443/client` (the QR code encodes this)

The certificate is self-signed, generated into `certs/` on first run; each device accepts the browser warning once. HTTPS is required — browsers refuse `getUserMedia` on non-`localhost` HTTP origins.

There is no test suite, linter, or build step. Verification is manual: start the server, open both pages, watch the server log (connect/disconnect, client roster, recording byte counts, survey/mapping events, ffmpeg stderr).

## Architecture

```mermaid
flowchart LR
    P1["client 1..N  /client"]
    S["server.js  HTTPS + ws  :8443"]
    V["dashboard  /viewer"]
    R[("recordings/*.webm")]
    C["ffmpeg → AkVCamManager"]

    P1 -- "WS signaling + WS bulk (WebM chunks, keyframes)" --> S
    V -- "WS signaling" --> S
    S --> R
    S -.optional.-> C
    P1 == "WebRTC media (P2P over LAN)" ==> V
```

Live media is WebRTC peer-to-peer; it does not pass through the server. Each client holds two WebSockets under one client identity: a signaling socket for small latency-sensitive JSON, and a bulk socket for recorder chunks and mapping keyframes. The split exists so bulk bytes cannot queue ahead of pose or signaling messages.

Server responsibilities:

1. **Signaling relay.** `offer`/`answer`/`ice` relayed verbatim; client→viewer messages are tagged with a `clientId`, viewer→client messages carry one for routing. One viewer at a time — a new one displaces the old.
2. **Recording sink.** Binary frames on the bulk socket are `MediaRecorder` chunks appended to the client's current file. Recording state lives on the socket, so a new socket requires a new recorder (the first chunk carries the WebM header); the client therefore rebuilds its recorder on reconnect, camera switch, mic toggle, and resolution change. Frames beginning with the `KFR1` magic are mapping keyframes and are demuxed before the recording append.
3. **Room survey and mapping.** See the sections below.
4. **Virtual webcam tee** (optional, Windows).

**Client identity.** Each device persists a UUID in `localStorage` and presents it on every connection; the server maps it to a stable small integer, so a reload keeps its tile and recording filename prefix. A new socket for an existing id closes the old one; the old socket's close handler checks it still owns the id before cleaning up.

**Liveness.** Android freezes backgrounded pages and tears down their connections without a `close` event; the socket stays nominally `OPEN`. Both pages run an explicit ping/pong probe plus a probe on `visibilitychange`, and treat an unanswered ping as a dead socket. `readyState` is not trusted.

**Recovery.** Backgrounding can take the camera, recorder, and peer connection at once. `restartCall()` in `client.js` is the single recovery path, re-entrancy guarded so a request arriving mid-restart is replayed. Pause (tapping the feed) disables tracks and pauses the recorder without tearing anything down, so a recording spans a pause as one file.

**Resolution and bitrate.** Capture defaults to 4K with `ideal` constraints (unsupported clients degrade to their best mode). Recorder bitrate is tiered by the actual capture size: 16 Mbps ≥ 4K, 8 Mbps ≥ 1440p, 4 Mbps below.

## Frame sync

The dashboard's combined view composites all feeds onto one canvas. Feeds arrive with different end-to-end latencies, so naive compositing mixes moments captured tens of milliseconds apart. Alignment works as follows:

1. **Clock sync** (`common.js`). Clients and dashboard each run NTP-style probes against the server clock — the only shared timebase. The server clock is anchored once and advances monotonically, so OS time resyncs cannot step it. Clients keep a sliding window of samples on their monotonic clock, fit the low-RTT ones with least squares, and use the slope as crystal drift. A fixed offset alone goes tens of milliseconds stale within minutes at typical drift rates; the fit is what holds long sessions together. A run of samples inconsistent with any round trip (server restart, device suspend) clears the window.
2. **Client side.** Encoded-frame access (`encodedInsertableStreams`) exposes each encoded frame's RTP timestamp. The client publishes `{rtp, serverTime, unc}` pairings at 8/s, and inserts the abs-capture-time RTP header extension with an id free across the whole SDP (BUNDLE requires one meaning per id; ids above 14 need the two-byte form, so allocation stops there).
3. **Dashboard side.** `requestVideoFrameCallback` reports each displayed frame's RTP timestamp; conversion to capture time goes through the 90 kHz RTP clock, wraparound-aware. Among recent pairings, the one implying the earliest capture wins — encode delay is always positive, and the recency window is what lets the estimate reconverge after the client's clock estimate moves. Frames are buffered per device and the frame nearest the shared presentation instant (max latency + margin) is drawn.

Cost: roughly 70 ms of additional latency in the combined view only; the tile grid stays live.

Header readout: `sync ±N` is the worst drawn-frame misalignment (floor: half a frame interval). `lag spread` is the latency difference the sync compensates — not an error. `clock ±N` is the worst client's clock uncertainty, which the sync figure structurally cannot observe (the dashboard's own clock error shifts all feeds together and cancels; a client's does not).

## Room positioning

Clients detect ArUco tags fixed to the room and the server maintains a persistent room-frame marker map plus a live pose per client, shown in three dashboard views: 3D scene, floor plan, elevation.

**Setup.**

1. Print tags from `/markers`. Tag edge must be exactly 150 mm including the black border (`markerSizeM` in `server.js`); any scale error multiplies every distance in the room frame. A screen showing `/digital` also works as a tag.
2. Calibrate each client at `/calibrate` (ChArUco board from the same page). Intrinsics are stored per lens and per resolution in `localStorage`. Uncalibrated clients fall back to a generic FOV model and are flagged `calibrated:false` end to end.
3. Marker tracking is on by default (toggle on the client header). The client-side overlay reports resolution, scan mode, a detect-time breakdown (pixel grab / tag search / PnP), per-tag distance / viewing angle / reprojection error, and the current room fix.

**Detection** (`detect-worker.js` + `detect-core.js`, client). Runs at ~10 Hz on raw camera frames at native capture resolution, on a worker thread fed by a `MediaStreamTrackProcessor` — detection is the most expensive thing the client does per frame and it must not stall the encoded-frame transform, the recorder or the UI. Where a track processor is unavailable, `pose.js` runs the same core on the page via `requestVideoFrameCallback`.

Three things keep it cheap enough to run on a 4K preview, none of them at the cost of pose accuracy:

- **Luma only.** Camera frames are YUV, and plane 0 is already the grayscale image, so `VideoFrame.copyTo` writes it straight into the wasm heap the detector reads from. The old path drew to a canvas, read back 33 MB of RGBA per frame, copied that into the heap and converted it to gray — four passes over eight megapixels to produce one.
- **Region-of-interest scanning.** After tags have been seen, only a crop around them is scanned; the margin tracks the measured motion of the tags, an empty crop scan immediately retries the whole frame, and a full sweep is forced at least every 700 ms so new tags cannot be missed for long. Crop coordinates are mapped back to full-frame pixels before anything solves a pose, so the rest of the pipeline only ever sees one coordinate space.
- **ArUco3 on the full sweep.** Candidates are searched on a downscaled copy and corners refined against the full-resolution image. The downscale factor is `32 / (32 + longEdge * minMarkerLengthRatioOriginalImg)`, which with OpenCV's default ratio of `0` is exactly 1 — setting `useAruco3Detection` alone does nothing. At `0.015` a 4K frame is searched at ~0.36 scale (an 8x area cut) while still accepting a marker 58 px across, about 7.5 m out for a 150 mm tag.

Per tag, pose comes from `SOLVEPNP_IPPE_SQUARE`. Planar PnP has a two-fold mirror ambiguity; when the OpenCV build exposes `solvePnPGeneric`, both solutions are sent with per-solution reprojection error. The client knows nothing about the marker map — all room-frame math is server-side.

**Survey** (`survey.js`, server). The first cleanly observed tag is adopted as the room origin (anchor). Each pose message from a localized client that also sees unknown tags contributes room-pose estimates for them; a tag is promoted into the map once enough estimates agree with their own component-wise median. Known tags are continually refined by a slow running average using leave-one-out camera fixes (a tag never feeds back into its own estimate); the anchor is the datum and never moves. The map persists to `markers.json` (debounced atomic writes) and survives restarts.

**Localization.** A client's room pose is fused over all visible mapped tags — `T_room_cam = T_room_tag ∘ inv(T_cam_tag)` per tag, weighted by distance and reprojection error. Mirror-ambiguous observations are resolved by picking, per tag, the solution whose implied camera pose agrees with the pose implied by the other tags, or with the client's last recent fix when only one tag is visible. A jump-reject gate holds the previous fix when a new one teleports implausibly far, unless the jump persists.

Removing a tag: double-click it in the floor plan. Removing the anchor resets the entire survey, since all poses are expressed relative to it.

Expected accuracy is decimeter-level at room scale, dependent on calibration quality, tag print accuracy, viewing angle (degrades hard past ~60° off-normal), and distance.

## Room mapping

Requires a depth model in `models/` (`fetch-vendor` downloads Depth Anything V2 in relative and metric variants; the metric one is preferred). Pipeline:

1. **Keyframes.** About once per second, a client that currently sees a tag encodes the frame as a ≤672 px JPEG and sends it over the bulk socket with its tags and intrinsics (`KFR1` framing). Frames without tags are not sent — they could not be posed.
2. **Posing.** The server poses each keyframe purely from the tags in that frame via the survey (`locate`), independent of the live pose stream.
3. **Depth.** A worker thread runs inference (~0.5 s CPU). One job at a time; a newer keyframe from the same client replaces its queued predecessor rather than queuing behind it.
4. **Metric calibration.** The depth output is fitted against the true tag distances in the same frame. The metric model needs one tag (residual scale correction, rejected if far from 1). The relative model needs two tags at clearly different depths to solve scale and shift exactly; single-tag frames consume a per-client learned shift, and frames whose fit would be dishonest are rejected outright — a rejected frame is preferable to painted garbage.
5. **Voxel grid.** Valid depth pixels backproject through the keyframe pose into a 7.5 cm voxel grid. Hits are dilated to face-neighbors because monocular depth wobbles across frames. Each ray also votes free space for the cells it crosses (stopping short of the surface by more than the depth noise); cells seen through far more often than hit are dismissed. This carving is what removes hallucinated geometry.
6. **Wall layer.** Debounced after occupancy changes: columns of the floor plan whose occupied voxels span wall-like height (≥ 1 m, ≥ 45 % fill) are treated as wall samples; RANSAC fits floor-plan line segments through them (total-least-squares refit, split at gaps, percentile-bounded vertical extent). Segments stream to the dashboard as a separate layer — quads in the 3D view, lines/rectangles in the 2D views — independent of raw voxel noise. Assumes the room's y-axis is vertical, i.e. the anchor tag is mounted roughly upright.

Dashboard controls: map view select (accumulated / last-N keyframes debug / off) and a clear button. Turning mapping off also stops clients producing keyframes (server pushes `keyframeMs: 0`).

## Virtual webcam

Windows only. Exposes the selected client's feed as a system webcam device. Enabled when both pieces exist:

1. [AkVirtualCamera](https://github.com/webcamoid/akvirtualcamera/releases), with a device created:

```bat
"%ProgramFiles%\AkVirtualCamera\x64\AkVCamManager.exe" add-device "Phone Stream"
"%ProgramFiles%\AkVirtualCamera\x64\AkVCamManager.exe" add-format AkVCamVideoDevice0 RGB24 1280 720 30
"%ProgramFiles%\AkVirtualCamera\x64\AkVCamManager.exe" update
```

2. `ffmpeg.exe` in `tools/`.

The active client's WebM chunk stream is teed into `ffmpeg`, decoded, and piped to `AkVCamManager stream` at 1280×720@30. A **Webcam** button appears per tile; detection re-runs when a viewer connects, so a driver installed after startup is picked up without a restart.

## Recordings

- Path: `recordings/<stamp>_client<id>.webm`.
- A new file starts on connect/reconnect, camera switch, mic toggle, resolution change, and the new-recording button. Pause does not split the file.
- Retention is manual; disk space is the only limit.
- A 0-byte file means the client's screen was off or the page was backgrounded — the camera delivers no frames there.

## Project layout

```
server.js              HTTPS + WS: signaling relay, recording sink, vcam
survey.js              marker map + room-frame localization
mapping.js             voxel occupancy grid + wall-segment extraction
depth-worker.js        worker thread: depth inference, metric calibration
fetch-vendor.js        downloads opencv.js / three.js / depth models
public/
  common.js            signaling socket, liveness probe, clock sync
  client.js             camera, MediaRecorder, peer connection, recovery
  pose.js              pose sockets, intrinsics, stats, on-page fallback
  detect-worker.js     worker thread: camera frames in, tag poses out
  detect-core.js       detector objects, scan strategy, PnP, keyframe encode
  pose-math.js         quaternion / SE(3) helpers (shared with server)
  cv-common.js         opencv loading, intrinsics store, detector + luma factories
  viewer.js            tiles, combined canvas, frame buffering + sync
  scene.js             3D room view (three.js)
  map2d.js             floor plan + elevation views
  calibrate.js/.html   ChArUco camera calibration
  markers.js/.html     printable tag sheet
  digital.js/.html     exact-size on-screen tag
  client.html · viewer.html · index.html · style.css
certs/                 self-signed cert, generated on first run   (gitignored)
recordings/            output                                     (gitignored)
tools/                 ffmpeg.exe for the virtual webcam          (gitignored)
public/vendor/         fetched opencv.js / three.js               (gitignored)
models/                fetched depth models                       (gitignored)
markers.json           surveyed marker map                        (gitignored)
```

Conventions: dates/times are 24-hour `dd/mm/yy`, formatted only by the helpers in `server.js` — no `toLocaleString`. Comments explain why, not what. Shared client/viewer logic lives in `common.js`; shared CV definitions in `cv-common.js`; transform math in `pose-math.js`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Certificate warning | Self-signed; accept once per device. |
| Client cannot reach the server | Same Wi-Fi required; AP client isolation must be off; firewall must allow Node on 8443. |
| Cert invalid after an IP change | Delete `certs/` and restart — regenerated with current addresses in the SAN. |
| Recording is 0 bytes | Screen off / page backgrounded on the client. |
| "sync unavailable" | Browser lacks encoded-frame access, or no free extmap id. Combined view works unsynced. |
| Second dashboard kicks the first | By design. |
| No Webcam button | Missing `tools/ffmpeg.exe`, AkVirtualCamera, or device. Startup log names which. |
| Overlay shows UNCALIBRATED | No stored calibration for that lens/resolution — run `/calibrate`. Poses fall back to a FOV guess. |
| Tags detected but no room fix | No surveyed tag in view. The survey grows from the anchor: show a known and an unknown tag together repeatedly. |
| Distances uniformly wrong | Printed tag size ≠ 150 mm. Reprint at exact scale or adjust `markerSizeM`. |
| Mapping never starts | No depth model (`npm run fetch-vendor`), or map view set to off. |
| Keyframes rejected in the log | Depth scale could not be pinned. Show two tags at clearly different distances once; single-tag frames work after that. |
