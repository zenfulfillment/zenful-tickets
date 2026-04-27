// Microphone capture pipeline.
//
// - getUserMedia → AudioContext at the mic's native rate
// - AudioWorklet pushes float32 frames to the main thread
// - We resample to 16kHz PCM16 (mono) and ship to Rust via IPC
//
// Why a worklet: ScriptProcessorNode is deprecated and runs on the main
// thread, introducing UI jank. AudioWorkletNode runs off-thread.
//
// The worklet code lives in /public/voice-worklet.js so it's served as a
// same-origin asset and matches `script-src 'self'` in the CSP. An earlier
// iteration loaded the worklet from a Blob URL; WKWebView's CSP blocks
// `blob:` URLs in `script-src`, so that path failed with "Not allowed by CSP"
// in production builds.

import { speechSendChunk, speechStart, speechStop } from "./tauri";

const TARGET_RATE = 16_000; // ElevenLabs Scribe V2 expects 16kHz PCM16
const CHUNK_MS = 80;        // ~1280 samples/chunk at 16kHz — low latency, low overhead

/**
 * Path to the worklet asset. Vite serves files in `public/` at the webview
 * root in both dev (vite) and prod (tauri's asset protocol).
 */
const WORKLET_URL = "/voice-worklet.js";

export interface VoiceSession {
  stop(): Promise<void>;
  /** 0..1 amplitude for orb reactivity. */
  readonly level: { current: number };
}

export async function startVoice(opts?: { deviceId?: string | null }): Promise<VoiceSession> {
  // Bail with a clear, user-actionable error before touching any IPC if the
  // webview doesn't expose getUserMedia (macOS WKWebView without
  // macOSPrivateApi enabled, or older Tauri builds). The previous code threw
  // "undefined is not an object (evaluating 'navigator.mediaDevices…')" which
  // is hostile to users.
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error(
      "Microphone access isn't available in this build. Update the app to the latest version, then re-grant microphone permission in System Settings → Privacy & Security → Microphone.",
    );
  }

  // Tell Rust to spin up the ElevenLabs websocket. Anything that throws
  // *after* this point must explicitly call speechStop() — otherwise Rust
  // stays in "session running" state and the next click fails with
  // "a voice session is already running" until the app is restarted.
  await speechStart();

  // Hold partial-setup state at function scope so the catch block below can
  // tear down whatever progress we made before re-throwing.
  let stream: MediaStream | undefined;
  let ac: AudioContext | undefined;

  try {
    const level = { current: 0 };

    // When a specific deviceId is requested, use `exact` so the OS doesn't
    // fall back to the default mic if the requested one disappears (e.g.
    // AirPods pulled out mid-session). Null/empty → use system default.
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    };
    if (opts?.deviceId) {
      audioConstraints.deviceId = { exact: opts.deviceId };
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    });

    ac = new AudioContext();
    await ac.resume();
    const srcNode = ac.createMediaStreamSource(stream);

    await ac.audioWorklet.addModule(WORKLET_URL);
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

    const capturedStream = stream;
    const capturedAc = ac;

    const stop = async () => {
      if (stopped) return;
      stopped = true;
      try { worklet.port.close(); } catch {}
      try { srcNode.disconnect(); } catch {}
      try { worklet.disconnect(); } catch {}
      for (const t of capturedStream.getTracks()) t.stop();
      await capturedAc.close().catch(() => {});
      await speechStop().catch(() => {});
      level.current = 0;
    };

    return { stop, level };
  } catch (err) {
    // Mid-setup failure (CSP rejection, mic permission denied, worklet
    // 404, etc.). Tear down everything we touched, then make sure Rust is
    // back in "no session running" state before re-throwing — otherwise
    // the user sees "a voice session is already running" on their next
    // click and is stuck until they restart the app.
    try {
      if (stream) for (const t of stream.getTracks()) t.stop();
    } catch {}
    try {
      if (ac) await ac.close();
    } catch {}
    await speechStop().catch(() => {});
    throw err;
  }
}
