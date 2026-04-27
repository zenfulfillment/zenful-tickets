// Microphone capture pipeline.
//
// - getUserMedia → AudioContext at the mic's native rate
// - AudioWorklet pushes float32 frames to the main thread
// - We resample to 16kHz PCM16 (mono) and ship to Rust via IPC
//
// Why a worklet: ScriptProcessorNode is deprecated and runs on the main
// thread, introducing UI jank. AudioWorkletNode runs off-thread.

import { speechSendChunk, speechStart, speechStop } from "./tauri";

const TARGET_RATE = 16_000; // ElevenLabs Scribe V2 expects 16kHz PCM16
const CHUNK_MS = 80;        // ~1280 samples/chunk at 16kHz — low latency, low overhead

const WORKLET_SRC = `
class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    // Mono downmix (average channels)
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
registerProcessor('capture-processor', CaptureProcessor);
`;

export interface VoiceSession {
  stop(): Promise<void>;
  /** 0..1 amplitude for orb reactivity. */
  readonly level: { current: number };
}

export async function startVoice(opts?: { deviceId?: string | null }): Promise<VoiceSession> {
  await speechStart();

  const level = { current: 0 };

  // When a specific deviceId is requested, use `exact` so the OS doesn't fall
  // back to the default mic if the requested one disappears (e.g. AirPods
  // pulled out mid-session). Null/empty → use system default.
  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };
  if (opts?.deviceId) {
    audioConstraints.deviceId = { exact: opts.deviceId };
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: audioConstraints,
  });

  const ac = new AudioContext();
  await ac.resume();
  const srcNode = ac.createMediaStreamSource(stream);

  const blob = new Blob([WORKLET_SRC], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    await ac.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const worklet = new AudioWorkletNode(ac, "capture-processor");

  const sampleRate = ac.sampleRate;
  const ratio = sampleRate / TARGET_RATE;
  const chunkSamples = Math.floor((TARGET_RATE * CHUNK_MS) / 1000);

  let resampleBuf: number[] = [];
  let stopped = false;

  worklet.port.onmessage = (ev: MessageEvent<Float32Array>) => {
    if (stopped) return;
    const input = ev.data;

    // amplitude for orb
    let sum = 0;
    for (let i = 0; i < input.length; i++) sum += Math.abs(input[i]);
    const avg = sum / input.length;
    level.current = Math.min(1, avg * 4);

    // linear resample to 16kHz
    for (let i = 0; i < input.length; i += ratio) {
      const idx = Math.floor(i);
      resampleBuf.push(input[idx]);
    }

    while (resampleBuf.length >= chunkSamples) {
      const slice = resampleBuf.splice(0, chunkSamples);
      const pcm = new Int16Array(chunkSamples);
      for (let i = 0; i < chunkSamples; i++) {
        const s = Math.max(-1, Math.min(1, slice[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // Ship bytes (little-endian already on x86/arm64).
      void speechSendChunk(new Uint8Array(pcm.buffer));
    }
  };

  srcNode.connect(worklet);

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { worklet.port.close(); } catch {}
    try { srcNode.disconnect(); } catch {}
    try { worklet.disconnect(); } catch {}
    for (const t of stream.getTracks()) t.stop();
    await ac.close().catch(() => {});
    await speechStop().catch(() => {});
    level.current = 0;
  };

  return { stop, level };
}
