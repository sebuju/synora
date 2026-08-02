'use strict';

// Capture side of /audio-lab: accumulate the mic into fixed blocks and hand
// them to the page with an absolute sample index. That index is the timing
// backbone of the whole experiment — the matched filter reports peaks in
// samples since capture start, and one sample at 48 kHz is 7 mm of sound
// travel, so nothing here may drop or double-count a frame. All analysis
// stays on the page: this thread is realtime and owns nothing but the copy.
const BLOCK = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(BLOCK);
    this.fill = 0;
    // Absolute index of buf[0] in samples since the node started processing.
    this.blockStart = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let src = 0;
    while (src < ch.length) {
      const n = Math.min(ch.length - src, BLOCK - this.fill);
      this.buf.set(ch.subarray(src, src + n), this.fill);
      this.fill += n;
      src += n;
      if (this.fill === BLOCK) {
        // Transfer the block; allocate a fresh one rather than recycling — at
        // ~23 blocks/s the churn is nothing, and a returned-buffer scheme
        // would couple this thread to the page's processing pace.
        this.port.postMessage({ startFrame: this.blockStart, samples: this.buf }, [this.buf.buffer]);
        this.buf = new Float32Array(BLOCK);
        this.blockStart += BLOCK;
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('capture', CaptureProcessor);
