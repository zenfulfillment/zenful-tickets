// AudioWorkletProcessor for voice capture.
//
// Lives in /public/ so Vite copies it verbatim to the bundle root and the
// webview can load it as a same-origin script — `script-src 'self'` allows
// it without weakening CSP. The previous inline-blob approach hit
// "Not allowed by CSP" because WKWebView gates worklet `addModule()` on
// script-src, which doesn't permit `blob:` URLs by default.
//
// Behaviour: downmix multi-channel input to mono and ship each render
// quantum (default 128 samples) back to the main thread. Resampling to
// 16 kHz PCM16 happens main-side in src/lib/voice.ts.

class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const len = input[0].length;
    const mono = new Float32Array(len);
    const chCount = input.length;
    for (let i = 0; i < len; i++) {
      let s = 0;
      for (let c = 0; c < chCount; c++) s += input[c][i];
      mono[i] = s / chCount;
    }
    this.port.postMessage(mono, [mono.buffer]);
    return true;
  }
}

registerProcessor("capture-processor", CaptureProcessor);
