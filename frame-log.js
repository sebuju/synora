'use strict';

// The `.frames` container: a recording of the object-frame channel, one file
// per XR session, written beside that session's pose journal in `recordings/`.
//
// Why the frames are kept at all rather than inferred once and thrown away:
// the detector is the part of this experiment most likely to be wrong or
// replaced. A different model, a different score threshold, a different class
// allow-list has to be a re-run over bytes already on disk, not another walk
// around the room. The pose journal made survey tuning measurable that way and
// this is the same bargain for the detector.
//
// The stored record is byte-for-byte what arrived on the socket (see
// `public/frame-wire.js`), so the offline detector reads what the live server
// read, through the same header decoder, with no second parser to drift.
//
// This file knows the container and nothing else — no policy about when to
// open one, what to detect, or what a detection means. Same restraint as
// `replay-common.js`.

const fs = require('fs');
const { decodeFrameRecord, FRAME_HEADER_BYTES } = require('./public/frame-wire.js');

const LOG_MAGIC = 0x53594652;   // 'SYFR', big-endian
const LOG_VERSION = 1;
const LOG_PREAMBLE_BYTES = 8;   // magic(4) + version(1) + reserved(1) + metaLen(2)
const RECORD_LEN_BYTES = 4;

// Bounds on a length read out of a file, so a torn or foreign file cannot make
// the reader allocate wildly before it discovers it is not a frame log.
const MAX_RECORD_BYTES = 32 * 1024 * 1024;

function preamble(meta) {
  const json = Buffer.from(JSON.stringify(meta), 'utf8');
  if (json.length > 0xffff) throw new Error('frame-log meta too large');
  const head = Buffer.alloc(LOG_PREAMBLE_BYTES);
  head.writeUInt32BE(LOG_MAGIC, 0);
  head.writeUInt8(LOG_VERSION, 4);
  head.writeUInt8(0, 5);
  head.writeUInt16LE(json.length, 6);
  return Buffer.concat([head, json]);
}

// Write side. `meta` is written once, at the head, for the same reason the pose
// journal's first line is meta: which client and which session these frames
// belong to cannot be recovered from the frames themselves, and a file that
// cannot say what it is a recording of is not evidence.
function openFrameLog(pathname, meta) {
  const stream = fs.createWriteStream(pathname);
  stream.write(preamble({ kind: 'meta', version: LOG_VERSION, ...meta }));
  let frames = 0;
  let bytes = 0;
  return {
    path: pathname,
    // `payload` is the whole socket message: frame header + JPEG. It is not
    // re-encoded here — a container that re-serialises its records is a second
    // place for the layout to be wrong.
    write(payload) {
      if (!payload || payload.length < FRAME_HEADER_BYTES) return false;
      const len = Buffer.alloc(RECORD_LEN_BYTES);
      len.writeUInt32LE(payload.length, 0);
      stream.write(len);
      stream.write(payload);
      frames++;
      bytes += payload.length;
      return true;
    },
    close() { stream.end(); },
    get frames() { return frames; },
    get bytes() { return bytes; },
  };
}

function readFrameLogMeta(pathname) {
  const fd = fs.openSync(pathname, 'r');
  try {
    const head = Buffer.alloc(LOG_PREAMBLE_BYTES);
    if (fs.readSync(fd, head, 0, LOG_PREAMBLE_BYTES, 0) < LOG_PREAMBLE_BYTES) return null;
    if (head.readUInt32BE(0) !== LOG_MAGIC) return null;
    if (head.readUInt8(4) !== LOG_VERSION) return null;
    const metaLen = head.readUInt16LE(6);
    const json = Buffer.alloc(metaLen);
    fs.readSync(fd, json, 0, metaLen, LOG_PREAMBLE_BYTES);
    return { meta: JSON.parse(json.toString('utf8')), offset: LOG_PREAMBLE_BYTES + metaLen };
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// Read side, a generator over `{ header, depth, jpeg }`.
//
// A log whose last record is torn — the session ended mid-write, which is the
// normal way one ends — stops cleanly at that record rather than throwing, the
// same rule `readJournals` applies to a torn final line.
function* readFrameLog(pathname) {
  const head = readFrameLogMeta(pathname);
  if (!head) throw new Error(`${pathname}: not a frame log (bad magic or version)`);
  const buf = fs.readFileSync(pathname);
  let off = head.offset;
  while (off + RECORD_LEN_BYTES <= buf.length) {
    const len = buf.readUInt32LE(off);
    off += RECORD_LEN_BYTES;
    if (len < FRAME_HEADER_BYTES || len > MAX_RECORD_BYTES) return;
    if (off + len > buf.length) return;               // torn tail
    const record = buf.subarray(off, off + len);
    off += len;
    const decoded = decodeFrameRecord(record);
    if (!decoded) return;                             // the stream is not what it claimed
    yield decoded;
  }
}

module.exports = { openFrameLog, readFrameLog, readFrameLogMeta, LOG_VERSION };
