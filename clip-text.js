'use strict';

// CLIP text: byte-level BPE tokenization, and the text embeddings an
// open-vocabulary detector is prompted with.
//
// Two of the candidate detectors are prompted with words rather than trained on
// a fixed class list, and both take CLIP's tokens:
//
//   - **YOLO-World** takes the *embeddings* as a graph input (`txt_feats`), so
//     the text encoder runs once, offline, and inference stays a plain YOLO
//     forward pass. That is the whole reason it is affordable here.
//   - **OWLv2** carries the text encoder inside its own graph and takes the
//     token ids directly, so this module stops at `tokenize`.
//
// The tokenizer is written out rather than pulled in as a dependency because it
// is sixty lines and the alternative is a transformers runtime for one function.
// It is CLIP's, not GPT-2's, and the three differences are all load-bearing: the
// text is lowercased and whitespace-collapsed first, every word carries an
// explicit `</w>` end marker into the merge table, and the sequence is wrapped
// in `<|startoftext|>` / `<|endoftext|>` and padded to a fixed length.

const fs = require('fs');
const path = require('path');

const MODELS_DIR = path.join(__dirname, 'models');
const VOCAB_FILE = path.join(MODELS_DIR, 'clip-vocab.json');
const MERGES_FILE = path.join(MODELS_DIR, 'clip-merges.txt');

const BOS = '<|startoftext|>';
const EOS = '<|endoftext|>';
// CLIP's own context length. OWLv2 was exported with 16 and pads to it; the
// prompts here are two or three words, so nothing is ever truncated by either.
const CONTEXT_LEN = 77;

// GPT-2's byte<->unicode table, which CLIP reuses unchanged: every one of the
// 256 byte values gets a printable codepoint, so the BPE merge table can be
// plain text and a byte sequence has exactly one spelling.
function bytesToUnicode() {
  const bs = [];
  for (let i = 33; i <= 126; i++) bs.push(i);
  for (let i = 161; i <= 172; i++) bs.push(i);
  for (let i = 174; i <= 255; i++) bs.push(i);
  const cs = bs.slice();
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (bs.includes(b)) continue;
    bs.push(b);
    cs.push(256 + n);
    n++;
  }
  const map = new Map();
  for (let i = 0; i < bs.length; i++) map.set(bs[i], String.fromCodePoint(cs[i]));
  return map;
}

// CLIP's pre-tokenizer. Contractions are split off, then letters, digits (one at
// a time) and punctuation runs.
const PAT = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu;

function createClipTokenizer() {
  const vocab = JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8'));
  const merges = fs.readFileSync(MERGES_FILE, 'utf8').split('\n')
    .slice(1)                                  // "#version: 0.2"
    .filter((l) => l.trim())
    .map((l) => l.split(/\s+/));
  const ranks = new Map();
  merges.forEach(([a, b], i) => ranks.set(`${a} ${b}`, i));
  const byteEnc = bytesToUnicode();
  const cache = new Map();

  function bpe(token) {
    if (cache.has(token)) return cache.get(token);
    // The end marker rides on the last symbol, so "door" and the "door" inside
    // "doorway" merge along different paths — which is the point of it.
    let word = [...token.slice(0, -1), `${token[token.length - 1]}</w>`];
    for (;;) {
      let best = null;
      let bestRank = Infinity;
      for (let i = 0; i < word.length - 1; i++) {
        const rank = ranks.get(`${word[i]} ${word[i + 1]}`);
        if (rank !== undefined && rank < bestRank) { bestRank = rank; best = i; }
      }
      if (best === null) break;
      word = [
        ...word.slice(0, best), word[best] + word[best + 1], ...word.slice(best + 2),
      ];
      if (word.length === 1) break;
    }
    cache.set(token, word);
    return word;
  }

  // One prompt -> its token ids, padded to `len` with an attention mask beside
  // them. Padding is zeros, which is what both exports were traced with.
  function tokenize(text, len = CONTEXT_LEN) {
    const clean = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
    const ids = [vocab[BOS]];
    for (const m of clean.matchAll(PAT)) {
      const bytes = Buffer.from(m[0], 'utf8');
      let token = '';
      for (const b of bytes) token += byteEnc.get(b);
      for (const piece of bpe(token)) {
        const id = vocab[piece];
        // An unknown piece cannot happen with a complete merge table, and if it
        // ever does, silently dropping it would produce a prompt that is not the
        // one asked for — which is invisible in every number downstream.
        if (id === undefined) throw new Error(`CLIP tokenizer: no id for "${piece}"`);
        ids.push(id);
      }
    }
    ids.push(vocab[EOS]);
    if (ids.length > len) throw new Error(`prompt "${text}" is ${ids.length} tokens, over ${len}`);
    const mask = ids.map(() => 1);
    while (ids.length < len) { ids.push(0); mask.push(0); }
    return { ids, mask, eosAt: mask.lastIndexOf(1) };
  }

  return { tokenize, vocab };
}

// The CLIP text tower as an ONNX graph, run once per prompt list. Its output is
// L2-normalized here rather than by the caller: YOLO-World's head compares text
// against image features by dot product and was trained on unit vectors, so an
// un-normalized prompt would scale that class's scores by its own magnitude —
// which looks exactly like a class the detector is more or less sure about.
async function embedPrompts(prompts, { modelFile, log } = {}) {
  const ort = require('onnxruntime-node');
  const file = modelFile || path.join(MODELS_DIR, 'clip-text.onnx');
  const tok = createClipTokenizer();
  const session = await ort.InferenceSession.create(file);
  const [inputName] = session.inputNames;
  const [outputName] = session.outputNames;
  const rows = [];
  for (const p of prompts) {
    const { ids } = tok.tokenize(p);
    const feeds = {
      [inputName]: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    };
    const res = await session.run(feeds);
    const v = Array.from(res[outputName].data);
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    rows.push(v.map((x) => x / n));
  }
  log?.(`CLIP text: ${prompts.length} prompts -> ${rows[0]?.length ?? 0}-d embeddings`);
  return rows;
}

module.exports = { createClipTokenizer, embedPrompts, CONTEXT_LEN, BOS, EOS };
