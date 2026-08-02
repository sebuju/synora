'use strict';

// Replay a recorded journal into a *running* server, as if it were the phone.
//
//   node replay-feed.js recordings/<stamp>_clientN.pose.jsonl [--url wss://localhost:8443]
//     [--speed 4] [--device replay-feed] [--watch 1]
//
// This is the answer to "is any of this actually working", which the replay
// tools cannot give: they call the modules directly, so they exercise the maths
// and skip everything around it — the admission gate as the server applies it,
// the message the viewer is sent, the guidance, the survey and walls running
// alongside. Every bug this feature has had so far lived in that gap. The one
// that shut the whole thing off for three sessions was a gate the offline
// replay did not test.
//
// So this opens a real WebSocket, presents itself as a client, and sends the
// journal's own pose messages back at the server verbatim. With `--watch` it
// also connects as the viewer and reports what comes back: the anchor cloud, the
// candidate clouds, the regions. Nothing is simulated and nothing is stubbed —
// if this prints anchors, the live path builds anchors.
//
// **Point it at a throwaway server.** It drives the survey and the walls grid
// with recorded data, and those write `markers.json` and `walls.json`. Start one
// with its own state directory:
//
//   SYNORA_STATE_DIR=/tmp/synora-replay PORT=8544 node server.js
//
// The self-signed certificate is the same one the LAN clients accept by hand, so
// verification is off here for the same reason.

const WebSocket = require('ws');
const { parseArgs, numFlag, readJournals } = require('./replay-common.js');

function usage(err) {
  if (err) console.error(err);
  console.error('usage: node replay-feed.js <journal.pose.jsonl> [more ...]\n'
    + '  [--url wss://localhost:8443] [--speed N] [--device NAME] [--watch 1]\n'
    + '  [--carry HZ]   synthesize the carry reports a recorded journal predates');
  process.exit(1);
}

const { positional: journals, flags } = parseArgs(process.argv.slice(2), { usage });
if (!journals.length) usage();
const url = flags.url || 'wss://localhost:8443';
const speed = numFlag(flags, 'speed', 4, usage);
// A device id of its own, so a feed never collides with the real phone's
// identity or its stored calibration.
const deviceId = flags.device || 'replay-feed-0000';
const watch = flags.watch !== undefined;
// Synthesize the phone's carry reports between the journal's real ones, at this
// rate. A recorded journal predates them, so this is the only way to replay a
// session the way the client now reports it.
//
// The ARCore position is interpolated between the two real reports either side;
// the orientation is the earlier one's. That is enough to exercise the rate, the
// jitter window and everything downstream, and it is *not* a measurement of real
// steadiness — a straight line between two fixes is smoother than a walk.
const carryHz = numFlag(flags, 'carry', 0, usage);

const opts = { rejectUnauthorized: false };

// What the server sends the viewer about the room. This is the end of the
// chain, and the only honest place to check it.
function startWatcher() {
  const ws = new WebSocket(url, opts);
  const seen = { landmarks: 0, markerMap: 0, floor: 0 };
  let last = null;
  ws.on('open', () => ws.send(JSON.stringify({ type: 'role', role: 'viewer' })));
  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf);
    } catch {
      return;   // binary frame: recorder chunks, not ours
    }
    if (msg.type === 'marker-map') seen.markerMap++;
    else if (msg.type === 'floor') seen.floor++;
    else if (msg.type === 'landmarks') {
      seen.landmarks++;
      last = msg;
      for (const c of msg.clients || []) {
        if (!c.anchors?.length && !c.candidates?.length) continue;
        const regions = (c.groups || []).filter((g) => g.n >= 2).length;
        console.log(`  [viewer] client ${c.clientId}: ${c.anchors.length} anchor(s), `
          + `${c.candidates?.length ?? 0} candidate(s), ${regions} region card(s)`);
      }
    }
  });
  ws.on('error', (e) => console.error(`  [viewer] ${e.message}`));
  return { ws, seen, get last() { return last; } };
}

function feed() {
  const ws = new WebSocket(url, opts);
  const watcher = watch ? startWatcher() : null;
  const guides = { closer: 0, arc: 0, dwell: 0, none: 0 };
  const quality = {};
  let withJitter = 0;
  let roomPoses = 0;
  let sent = 0;
  let carried = 0;
  let lastGuide = null;
  let lastSummary = null;

  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf);
    } catch {
      return;
    }
    // The server's answer to each pose: this is what the phone draws its
    // overlay and its map guidance from.
    if (msg.type === 'room-pose') {
      roomPoses++;
      quality[msg.quality ?? 'none'] = (quality[msg.quality ?? 'none'] ?? 0) + 1;
      if (msg.jitter) withJitter++;
      lastSummary = msg.landmarks;
      guides[msg.guide ? msg.guide.mode : 'none']++;
      if (msg.guide) lastGuide = msg.guide;
    } else if (msg.type === 'client-id') {
      console.log(`connected as client ${msg.clientId} (device ${deviceId})`);
    }
  });
  ws.on('error', (e) => usage(`cannot reach ${url}: ${e.message}`));

  ws.on('open', async () => {
    ws.send(JSON.stringify({ type: 'role', role: 'client', deviceId }));
    // Reported as a room watcher, because that is the state a phone drawing the
    // map is in — and it is the state the server fans room messages to.
    ws.send(JSON.stringify({ type: 'client-state', kind: 'xr', map: 'full', pose: true }));

    let prevAt = null;
    let prevMsg = null;
    for (const { entry } of readJournals(journals, { onError: usage })) {
      const msg = entry.msg;
      if (!msg) continue;
      // Carries first: they belong to the gap that has just elapsed, between the
      // previous real report and this one.
      let paced = false;
      if (carryHz && prevMsg?.xr && msg.xr && prevAt !== null) {
        const gap = entry.at - prevAt;
        // The carry loop sleeps its way across the gap, so the pacing below must
        // not sleep across it a second time.
        paced = gap > 1000 / carryHz;
        const step = 1000 / carryHz;
        for (let t = step; t < gap; t += step) {
          const f = t / gap;
          const p = prevMsg.xr.p.map((v, i) => v + (msg.xr.p[i] - v) * f);
          if (ws.readyState !== WebSocket.OPEN) break;
          ws.send(JSON.stringify({
            type: 'xr-pose', sid: prevMsg.sid, source: 'xr', carry: true,
            xr: { p, q: prevMsg.xr.q },
            w: prevMsg.w, h: prevMsg.h, intrinsics: prevMsg.intrinsics,
            tags: [], mode: null, scanned: null, t: Date.now(),
          }));
          carried++;
          await new Promise((r) => setTimeout(r, Math.max(1, step / speed)));
        }
      }
      prevMsg = msg;
      // Recorded timing, compressed. Real time matters here in a way it does
      // not offline: the survey's jitter window, the alignment freshness and
      // the debounced pushes are all clock-driven, and a burst would replay a
      // session the server has never seen.
      if (!paced && prevAt !== null && entry.at > prevAt) {
        const wait = Math.min(500, (entry.at - prevAt) / speed);
        if (wait > 1) await new Promise((r) => setTimeout(r, wait));
      }
      prevAt = entry.at;
      if (ws.readyState !== WebSocket.OPEN) break;
      // Verbatim, with only the timestamp restamped: the server's clock sync
      // never ran for this socket, so a recorded `t` would be read as a
      // wildly stale frame.
      ws.send(JSON.stringify({ ...msg, type: entry.kind, t: Date.now() }));
      sent++;
      if (sent % 200 === 0) {
        console.log(`  ${sent} report(s) sent · `
          + `${lastSummary ? `${lastSummary.anchors} anchor(s), arc ${lastSummary.arc}°` : 'no summary yet'}`
          + (lastGuide ? ` · guide ${lastGuide.mode} (${lastGuide.n} corners at ${lastGuide.dist} m)` : ''));
      }
    }

    // The landmark push is debounced by a second; the last one has to be
    // allowed to land or this reports the state from before the final reports.
    await new Promise((r) => setTimeout(r, 1500));
    console.log(`\nsent ${sent} detection report(s)`
      + (carried ? ` + ${carried} carry report(s)` : ''));
    // The jitter share is the number this tool exists to watch now: the survey
    // needs 8 samples in 1500 ms, and a client reporting below 5.3/s never has
    // one — which is what shut the landmark gate.
    console.log(`room-pose back: ${roomPoses}, with a jitter measurement `
      + `${withJitter} (${roomPoses ? Math.round(100 * withJitter / roomPoses) : 0}%)`);
    console.log(`quality: ${Object.entries(quality)
      .map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
    console.log(`server said: ${lastSummary
      ? `${lastSummary.anchors} anchor(s) from ${lastSummary.tracks} live track(s), `
        + `best arc ${lastSummary.arc}°`
      : 'nothing — no room-pose ever came back'}`);
    console.log(`guidance: closer ${guides.closer}, arc ${guides.arc}, `
      + `dwell ${guides.dwell}, silent ${guides.none}`);
    if (watcher) {
      console.log(`viewer received: ${watcher.seen.landmarks} landmark push(es), `
        + `${watcher.seen.markerMap} marker map(s), ${watcher.seen.floor} floor(s)`);
    }
    ws.close();
    watcher?.ws.close();
    process.exit(0);
  });
}

feed();
