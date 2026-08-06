'use strict';

// The object-frame wire format: a header, an optional depth map, and a JPEG.
//
// The phone builds it and the server reads it, so it is one definition in one
// file rather than a struct written twice — the same standing this project
// gives `markerCornersM` (cv-common.js) and the transform math (pose-math.js).
// A layout disagreement here would not throw: it would decode a plausible width
// out of the wrong offset and mis-scale every box the detector produced.
//
// Why a header at all rather than a JSON message beside the bytes: the frame
// arrives on its own socket, and its pose arrives on another. Nothing may join
// them by arrival order — the two sockets reorder freely — so the join key
// travels *inside* the frame, and a frame is self-describing or it is useless.
//
// The bytes the phone sends are exactly the bytes `frame-log.js` stores. That
// symmetry is deliberate: a `.frames` file is a recording of the wire, so the
// offline detector reads what the live server read, with no second parser.
//
// **Why the depth map travels with the picture.** The obvious arrangement —
// the phone samples depth where the objects are, as it already does at every
// tag — is not available: the boxes are produced on the PC, hundreds of
// milliseconds later, and by then the XRFrame that owned the depth is long
// dead. Either the depth map comes along or there is no depth at a box at all.
// It is optional (`FRAME_FLAG_DEPTH`), and a device that refuses depth-sensing
// produces none without complaint — anything built on depth has to work
// without it.

const FRAME_MAGIC = 0x53594631;     // 'SYF1', big-endian so it reads as text in a hex dump
const FRAME_HEADER_BYTES = 24;
const FRAME_WIRE_VERSION = 2;

// Bit flags. The first two are descriptive, not instructions — they record how
// the picture was made so a replay can tell a detector bug from a producer bug.
const FRAME_FLAG_DOWNSCALED = 1 << 0;   // decimated from the camera image
const FRAME_FLAG_REUSED_FLIP = 1 << 1;  // drawn from the full flip another consumer had already paid for
const FRAME_FLAG_DEPTH = 1 << 2;        // a depth section sits between the header and the JPEG

// Depth sample formats, matching XRSession.depthDataFormat.
const DEPTH_FMT_U16 = 0;    // 'luminance-alpha'
const DEPTH_FMT_F32 = 1;    // 'float32'
const DEPTH_SECTION_BYTES = 76;   // dw,dh,fmt,pad,scale (12) + the 4x4 matrix (64)

// Frame header layout, little-endian throughout except the magic:
//   0  u32  magic 'SYF1' (big-endian)
//   4  u8   version
//   5  u8   flags
//   6  u16  width
//   8  u16  height
//  10  u16  roll       — quarter turn from upright, degrees clockwise
//  12  u32  fseq       — the join key against the pose message's `fseq`
//  16  f64  t          — clockSync.at() capture instant, or NaN when unsynced
//
// `t` sits at 16 so it is 8-byte aligned; the u16 at 10 is what buys that.
//
// **`roll` reclaims what was a reserved zero, and deliberately does not bump the
// version.** Zero is exactly the right reading for a log written before this
// field existed — no turn — so the whole recorded corpus stays decodable, which
// is the point of keeping it: every model comparison is a re-run over those
// bytes. It is descriptive like the flags, and only the image writers read it;
// nothing in the detector, the bearing math or the join is aware of it.
function encodeFrameHeader({ w, h, fseq, t, flags = 0, roll = 0 }) {
  const buf = new ArrayBuffer(FRAME_HEADER_BYTES);
  const view = new DataView(buf);
  view.setUint32(0, FRAME_MAGIC, false);
  view.setUint8(4, FRAME_WIRE_VERSION);
  view.setUint8(5, flags);
  view.setUint16(6, w, true);
  view.setUint16(8, h, true);
  // Snapped to a quarter turn by the producer, which is the only place gravity
  // is measured. Stored as degrees rather than a turn count so a hex dump of a
  // frame reads without a lookup.
  view.setUint16(10, ((Math.round((roll || 0) / 90) % 4) + 4) % 4 * 90, true);
  view.setUint32(12, fseq >>> 0, true);
  // NaN rather than 0 for "no clock sync yet": zero is a valid instant and
  // would silently join a frame to whatever the epoch happens to line up with.
  view.setFloat64(16, Number.isFinite(t) ? t : NaN, true);
  return new Uint8Array(buf);
}

// Returns null on anything that is not a frame header. A caller that gets null
// has been handed bytes from a socket that lied about its role, which is a bug
// to drop loudly rather than a stream to guess at.
function decodeFrameHeader(bytes) {
  if (!bytes || bytes.byteLength < FRAME_HEADER_BYTES) return null;
  const view = new DataView(
    bytes.buffer ?? bytes, bytes.byteOffset ?? 0, FRAME_HEADER_BYTES);
  if (view.getUint32(0, false) !== FRAME_MAGIC) return null;
  const version = view.getUint8(4);
  if (version !== FRAME_WIRE_VERSION) return null;
  const t = view.getFloat64(16, true);
  return {
    version,
    flags: view.getUint8(5),
    w: view.getUint16(6, true),
    h: view.getUint16(8, true),
    roll: view.getUint16(10, true),
    fseq: view.getUint32(12, true),
    t: Number.isNaN(t) ? null : t,
  };
}

// Depth section layout, little-endian, immediately after the frame header:
//   0  u16  depth width
//   2  u16  depth height
//   4  u8   format (DEPTH_FMT_*)
//   5  u8   reserved
//   8  f32  rawValueToMeters
//  12  f32[16]  normDepthBufferFromNormView
//  76  samples, dw*dh of the declared format
//
// `scale` sits at 8 rather than 6 so it is 4-byte aligned, and the matrix
// follows it for the same reason.
function encodeDepthSection(depth) {
  const fmt = depth.data instanceof Float32Array ? DEPTH_FMT_F32 : DEPTH_FMT_U16;
  const samples = depth.w * depth.h;
  const bytes = new Uint8Array(DEPTH_SECTION_BYTES + samples * (fmt === DEPTH_FMT_F32 ? 4 : 2));
  const view = new DataView(bytes.buffer);
  view.setUint16(0, depth.w, true);
  view.setUint16(2, depth.h, true);
  view.setUint8(4, fmt);
  view.setUint8(5, 0);
  view.setFloat32(8, depth.scale, true);
  for (let i = 0; i < 16; i++) view.setFloat32(12 + i * 4, depth.m[i] || 0, true);
  // Copied through a byte view rather than a typed-array set, because the
  // destination offset is not a multiple of the sample size and a typed array
  // cannot be created over a misaligned slice of an ArrayBuffer.
  bytes.set(new Uint8Array(depth.data.buffer, depth.data.byteOffset, depth.data.byteLength),
    DEPTH_SECTION_BYTES);
  return bytes;
}

function decodeDepthSection(bytes, offset) {
  if (!bytes || bytes.byteLength < offset + DEPTH_SECTION_BYTES) return null;
  const base = (bytes.byteOffset ?? 0) + offset;
  const view = new DataView(bytes.buffer ?? bytes, base, DEPTH_SECTION_BYTES);
  const w = view.getUint16(0, true);
  const h = view.getUint16(2, true);
  const fmt = view.getUint8(4);
  const wide = fmt === DEPTH_FMT_F32;
  const need = w * h * (wide ? 4 : 2);
  if (!w || !h || bytes.byteLength < offset + DEPTH_SECTION_BYTES + need) return null;
  const m = [];
  for (let i = 0; i < 16; i++) m.push(view.getFloat32(12 + i * 4, true));
  // Copied rather than viewed: the sample array's start is only 2- or 4-aligned
  // by luck, and a typed array over a misaligned offset throws.
  const raw = new Uint8Array(
    bytes.buffer ?? bytes, base + DEPTH_SECTION_BYTES, need).slice();
  return {
    w, h, m,
    scale: view.getFloat32(8, true),
    data: wide ? new Float32Array(raw.buffer) : new Uint16Array(raw.buffer),
    bytes: DEPTH_SECTION_BYTES + need,
  };
}

// The whole record, as it arrives on the socket and as it sits in a `.frames`
// log: `{ header, depth, jpeg }`. The JPEG is whatever is left after the
// sections that declare their own length, which is why neither needs a length
// field of its own.
function decodeFrameRecord(bytes) {
  const header = decodeFrameHeader(bytes);
  if (!header) return null;
  let offset = FRAME_HEADER_BYTES;
  let depth = null;
  if (header.flags & FRAME_FLAG_DEPTH) {
    depth = decodeDepthSection(bytes, offset);
    if (!depth) return null;
    offset += depth.bytes;
  }
  return { header, depth, jpeg: bytes.subarray(offset) };
}

// Depth at a camera-image pixel, in metres along the view z, or null.
//
// This is `XRDepthInformation.getDepthInMeters` done by hand, because by
// sampling time the frame that owned it is gone — on the phone the detector is
// still out, and on the server the phone is a room away. One implementation
// rather than two: the page samples at tag centres and the server samples at
// box centres, and a convention disagreement between them would show up as
// depth that is subtly wrong in one place only.
//
// Convention risk worth naming: the normalized coordinates are taken
// top-left-origin like the image's own. If ARCore means the other Y,
// `replay-depth.js` shows it instantly as errors that mirror with screen
// height, which is precisely what that measurement is for.
function depthAtPixel(d, u, v, w, h) {
  if (!d) return null;
  const nx = u / w;
  const ny = v / h;
  const bx = d.m[0] * nx + d.m[4] * ny + d.m[12];
  const by = d.m[1] * nx + d.m[5] * ny + d.m[13];
  if (!(bx >= 0 && bx < 1 && by >= 0 && by < 1)) return null;
  const ix = Math.min(d.w - 1, Math.floor(bx * d.w));
  const iy = Math.min(d.h - 1, Math.floor(by * d.h));
  const metres = d.data[iy * d.w + ix] * d.scale;
  return Number.isFinite(metres) && metres > 0 ? Math.round(metres * 1000) / 1000 : null;
}

if (typeof module !== 'undefined') {
  module.exports = {
    FRAME_MAGIC, FRAME_HEADER_BYTES, FRAME_WIRE_VERSION,
    FRAME_FLAG_DOWNSCALED, FRAME_FLAG_REUSED_FLIP, FRAME_FLAG_DEPTH,
    DEPTH_FMT_U16, DEPTH_FMT_F32, DEPTH_SECTION_BYTES,
    encodeFrameHeader, decodeFrameHeader,
    encodeDepthSection, decodeDepthSection, decodeFrameRecord,
    depthAtPixel,
  };
}
