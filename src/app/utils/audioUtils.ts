/**
 * Audio utility functions for recording, VAD, and streaming.
 */


/* ────────────────────────────────────────────────────
 *  Continuous PCM16 streaming over WebSocket
 * ──────────────────────────────────────────────────── */

export interface StreamingMicHandle {
  stop: () => void;
}

interface StreamingMicOptions {
  /** RMS energy floor before dynamic calibration (default 0.0125) */
  energyThreshold?: number;
  /** Continuous speech required before emitting speech_start (default 120 ms) */
  speechStartMs?: number;
  /** Trailing silence in ms before emitting speech_end (default 600) */
  silenceMs?: number;
  /** Return false to pause PCM transmission while keeping local VAD active */
  shouldSendAudio?: () => boolean;
  /** Called when VAD detects the user started speaking */
  onSpeechStart?: () => void;
  /** Called when VAD detects the user stopped speaking */
  onSpeechEnd?: () => void;
}

/**
 * Start streaming raw PCM16 audio to a WebSocket at 16 kHz in 20 ms frames
 * (320 samples per frame — required for server-side VAD).
 *
 * Built-in energy-based VAD automatically sends JSON
 * `{ "type": "speech_start" }` and `{ "type": "speech_end" }` messages
 * bracketing each utterance. PCM16 frames are streamed while
 * `shouldSendAudio` returns true, but local VAD remains active either way.
 */
export const startStreamingMic = async (
  ws: WebSocket,
  onAudioLevel?: (level: number) => void,
  options: StreamingMicOptions = {},
): Promise<StreamingMicHandle> => {
  const {
    energyThreshold = 0.0125,
    speechStartMs = 120,
    silenceMs = 600,
    shouldSendAudio,
    onSpeechStart,
    onSpeechEnd,
  } = options;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const audioWindow = window as Window & { webkitAudioContext?: typeof AudioContext };
  const AudioContextCtor = window.AudioContext || audioWindow.webkitAudioContext;
  const audioContext: AudioContext = new AudioContextCtor({ sampleRate: 48000 });

  // MUST resume after user gesture
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(1024, 1, 1);
  const outputGain = audioContext.createGain();
  outputGain.gain.value = 0;
  let stopped = false;

  const safeSend = (payload: string | ArrayBuffer) => {
    try {
      ws.send(payload);
    } catch {
      // Ignore send failures during teardown/race conditions.
    }
  };

  // Connect the graph
  source.connect(processor);
  processor.connect(outputGain);
  outputGain.connect(audioContext.destination);

  /* ── VAD state ── */
  let isSpeaking = false;
  let lastSpeechTs = 0;         // ms timestamp of last above-threshold frame
  let speechCandidateSince = 0; // ms timestamp when above-threshold speech began
  let noiseSum = 0;
  let noiseCount = 0;
  const calibrationMs = 500;    // first 0.5 s used for noise-floor estimation
  const streamStartTime = performance.now();

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    if (stopped) return;
    if (ws.readyState !== WebSocket.OPEN) return;

    const input = event.inputBuffer.getChannelData(0);

    // ── Downsample to 16 kHz ──
    const targetSampleRate = 16000;
    const ratio = audioContext.sampleRate / targetSampleRate;
    const newLength = Math.floor(input.length / ratio);
    const downsampled = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      downsampled[i] = input[Math.floor(i * ratio)];
    }

    // ── Compute RMS energy on downsampled buffer ──
    let energySum = 0;
    for (let i = 0; i < downsampled.length; i++) {
      energySum += downsampled[i] * downsampled[i];
    }
    const rms = Math.sqrt(energySum / downsampled.length);

    // ── Dynamic noise-floor calibration (first 0.5 s) ──
    const elapsed = performance.now() - streamStartTime;
    if (elapsed < calibrationMs) {
      noiseSum += rms;
      noiseCount += 1;
    }

    let threshold = energyThreshold;
    if (noiseCount > 0) {
      const estNoise = noiseSum / noiseCount;
      threshold = Math.max(energyThreshold, estNoise * 3.0);
    }

    // ── VAD decision ──
    const now = performance.now();

    if (rms >= threshold) {
      if (isSpeaking) {
        lastSpeechTs = now;
      } else {
        if (speechCandidateSince === 0) {
          speechCandidateSince = now;
        }

        if (now - speechCandidateSince >= speechStartMs) {
          isSpeaking = true;
          lastSpeechTs = now;
          speechCandidateSince = 0;
          safeSend(JSON.stringify({ type: "speech_start" }));
          if (typeof onSpeechStart === "function") onSpeechStart();
        }
      }
    } else {
      speechCandidateSince = 0;

      if (isSpeaking) {
        const silenceElapsed = now - lastSpeechTs;
        if (silenceElapsed >= silenceMs) {
          isSpeaking = false;
          safeSend(JSON.stringify({ type: "speech_end" }));
          if (typeof onSpeechEnd === "function") onSpeechEnd();
        }
      }
    }

    // ── Float32 → PCM16 ──
    const pcm16 = new Int16Array(downsampled.length);
    for (let i = 0; i < downsampled.length; i++) {
      const s = Math.max(-1, Math.min(1, downsampled[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }

    // ── 20 ms frame chunking (REQUIRED FOR VAD) ──
    const FRAME_SIZE = 320; // 20 ms @ 16 kHz
    const canSendAudio = typeof shouldSendAudio === "function" ? shouldSendAudio() : true;

    if (canSendAudio) {
      for (let i = 0; i < pcm16.length; i += FRAME_SIZE) {
        const frame = pcm16.slice(i, i + FRAME_SIZE);
        if (frame.length === FRAME_SIZE) {
          safeSend(frame.buffer);
        }
      }
    }

    // ── Optional audio level callback ──
    if (typeof onAudioLevel === "function") {
      onAudioLevel(Math.min(rms * 8, 1));
    }
  };

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;

      processor.onaudioprocess = null;
      try {
        processor.disconnect();
      } catch {
        // ignore already disconnected processors
      }
      try {
        outputGain.disconnect();
      } catch {
        // ignore already disconnected outputs
      }
      try {
        source.disconnect();
      } catch {
        // ignore already disconnected sources
      }
      stream.getTracks().forEach((t) => t.stop());
      if (audioContext.state !== "closed") {
        audioContext.close().catch(() => {
          // ignore close errors during teardown
        });
      }
    },
  };
};
