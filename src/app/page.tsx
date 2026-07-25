"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { startStreamingMic, type StreamingMicHandle } from "./utils/audioUtils";
import VoiceSessionUI from "../components/VoiceSessionUI";
import Aurora from "../components/ui/Aurora";

type FlowState = "idle" | "active";
type CallPhase = "connecting" | "listening" | "speaking";

const WS_URL = process.env.NEXT_PUBLIC_BACKEND_WS_URL || "ws://localhost:8000/ws/audio/garima";
const SESSION_DURATION_SECONDS = 30 * 60;

const CREATOR = {
  firstName: "Garima",
  lastName: "Chaurasia",
  name: "Garima Chaurasia",
  image: "/garima.jpg",
  role: "Model & Influencer",
};

export default function Home() {
  const [flowState, setFlowState] = useState<FlowState>("idle");
  const [timeLeft, setTimeLeft] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [callPhase, setCallPhase] = useState<CallPhase>("connecting");
  const [isVisible, setIsVisible] = useState(false);

  const mousePosRef = useRef({ x: 0, y: 0 });
  const mouseTargetRef = useRef({ x: 0, y: 0 });
  const avatarRefs = useRef<(HTMLDivElement | null)[]>([]);

  /* ── Audio streaming refs ── */
  const wsRef = useRef<WebSocket | null>(null);
  const micControllerRef = useRef<StreamingMicHandle | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const playbackCursorRef = useRef(0);
  const playbackGenerationRef = useRef(0);
  const activePlaybackGenerationRef = useRef<number | null>(null);
  const activePlaybackNodesRef = useRef<AudioBufferSourceNode[]>([]);
  const pendingPlaybackEndRef = useRef(false);
  const playbackSampleRateRef = useRef(16000);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const ttsActiveRef = useRef(false);
  const captureAllowedRef = useRef(false);
  const micStartInFlightRef = useRef(false);
  const activeSessionRef = useRef(false);

  /* ── Entrance animation + mouse-follow parallax ── */
  useEffect(() => {
    const timeout = setTimeout(() => setIsVisible(true), 100);

    const handleMouseMove = (e: MouseEvent) => {
      mouseTargetRef.current = {
        x: (e.clientX / window.innerWidth - 0.5) * 20,
        y: (e.clientY / window.innerHeight - 0.5) * 20,
      };
    };

    let frameId: number;
    const animate = () => {
      mousePosRef.current.x +=
        (mouseTargetRef.current.x - mousePosRef.current.x) * 0.1;
      mousePosRef.current.y +=
        (mouseTargetRef.current.y - mousePosRef.current.y) * 0.1;

      avatarRefs.current.forEach((el, i) => {
        if (!el) return;
        const m = i === 0 ? 0.5 : -1;
        el.style.transform = `translate3d(${mousePosRef.current.x * m}px, ${mousePosRef.current.y * m}px, 0)`;
      });

      frameId = requestAnimationFrame(animate);
    };

    window.addEventListener("mousemove", handleMouseMove);
    animate();

    return () => {
      clearTimeout(timeout);
      window.removeEventListener("mousemove", handleMouseMove);
      cancelAnimationFrame(frameId);
    };
  }, []);

  /* ── Audio context helpers ── */
  const getAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      const audioWindow = window as Window & { webkitAudioContext?: typeof AudioContext };
      const AudioContextCtor = window.AudioContext || audioWindow.webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error("AudioContext is not supported in this browser.");
      }
      audioContextRef.current = new AudioContextCtor();
      playbackCursorRef.current = audioContextRef.current.currentTime;
    }
    return audioContextRef.current;
  }, []);

  const closeAudioContext = useCallback(() => {
    const audioCtx = audioContextRef.current;
    if (!audioCtx) return;

    if (audioCtx.state !== "closed") {
      audioCtx.close().catch(() => {
        // ignore close errors during teardown
      });
    }
    audioContextRef.current = null;
  }, []);

  const clearPlaybackState = useCallback(() => {
    playbackGenerationRef.current += 1;
    activePlaybackGenerationRef.current = null;
    pendingPlaybackEndRef.current = false;

    activePlaybackNodesRef.current.forEach((node) => {
      try {
        node.stop(0);
      } catch {
        // ignore nodes already ended/stopped
      }
      try {
        node.disconnect();
      } catch {
        // ignore already disconnected nodes
      }
    });

    activePlaybackNodesRef.current = [];
    playbackCursorRef.current = 0;
    ttsActiveRef.current = false;
  }, []);

  const stopPlaybackImmediately = useCallback(() => {
    clearPlaybackState();
    setIsSpeaking(false);
  }, [clearPlaybackState]);

  const finalizePlaybackIfDrained = useCallback((generation: number) => {
    if (generation !== activePlaybackGenerationRef.current) return;
    if (activePlaybackNodesRef.current.length > 0) return;

    activePlaybackGenerationRef.current = null;
    pendingPlaybackEndRef.current = false;
    ttsActiveRef.current = false;
    playbackCursorRef.current = 0;
    setIsSpeaking(false);
    setCallPhase("listening");
  }, []);

  const beginTtsPlayback = useCallback(() => {
    stopPlaybackImmediately();
    const generation = playbackGenerationRef.current;
    activePlaybackGenerationRef.current = generation;
    pendingPlaybackEndRef.current = false;
    playbackCursorRef.current = 0;
    ttsActiveRef.current = true;
    setIsSpeaking(true);
    setCallPhase("speaking");
  }, [stopPlaybackImmediately]);

  const scheduleBuffer = useCallback(
    (buffer: AudioBuffer) => {
      const generation = activePlaybackGenerationRef.current;
      if (generation === null) return;

      const audioCtx = getAudioContext();
      if (audioCtx.state === "suspended") {
        void audioCtx.resume();
      }

      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(audioCtx.destination);

      activePlaybackNodesRef.current.push(src);

      src.onended = () => {
        activePlaybackNodesRef.current = activePlaybackNodesRef.current.filter((node) => node !== src);
        try {
          src.disconnect();
        } catch {
          // ignore already disconnected sources
        }

        if (generation !== activePlaybackGenerationRef.current) return;
        if (pendingPlaybackEndRef.current && activePlaybackNodesRef.current.length === 0) {
          finalizePlaybackIfDrained(generation);
        }
      };

      if (playbackCursorRef.current < audioCtx.currentTime + 0.02) {
        playbackCursorRef.current = audioCtx.currentTime + 0.02;
      }

      const startTime = playbackCursorRef.current;
      src.start(startTime);
      playbackCursorRef.current = startTime + buffer.duration;
    },
    [finalizePlaybackIfDrained, getAudioContext],
  );

  const processBinaryChunk = useCallback(
    (arrayBuffer: ArrayBuffer) => {
      if (activePlaybackGenerationRef.current === null || !ttsActiveRef.current) {
        return;
      }

      const byteLength = arrayBuffer.byteLength - (arrayBuffer.byteLength % 2);
      if (byteLength <= 0) return;

      const view = new DataView(arrayBuffer, 0, byteLength);
      const float32 = new Float32Array(byteLength / 2);
      for (let i = 0; i < float32.length; i += 1) {
        float32[i] = view.getInt16(i * 2, true) / 32768;
      }

      const audioCtx = getAudioContext();
      const buffer = audioCtx.createBuffer(1, float32.length, playbackSampleRateRef.current);
      buffer.getChannelData(0).set(float32);

      scheduleBuffer(buffer);
    },
    [getAudioContext, scheduleBuffer],
  );

  const stopMicCapture = useCallback(() => {
    if (!micControllerRef.current) return;

    micControllerRef.current.stop();
    micControllerRef.current = null;
  }, []);

  const maybeStartMicCapture = useCallback(async () => {
    const ws = wsRef.current;
    if (
      !activeSessionRef.current ||
      !ws ||
      ws.readyState !== WebSocket.OPEN ||
      micControllerRef.current ||
      micStartInFlightRef.current
    ) {
      return;
    }

    micStartInFlightRef.current = true;

    try {
      const controller = await startStreamingMic(
        ws,
        () => {
          // Mic level callback intentionally ignored for now.
        },
        {
          energyThreshold: 0.0125,
          speechStartMs: 120,
          silenceMs: 600,
          shouldSendAudio: () => captureAllowedRef.current,
          onSpeechStart: () => {
            if (ttsActiveRef.current || activePlaybackGenerationRef.current !== null) {
              stopPlaybackImmediately();
            }
            setCallPhase("listening");
          },
          onSpeechEnd: () => {
            if (activeSessionRef.current) {
              setCallPhase("listening");
            }
          },
        },
      );

      if (
        !activeSessionRef.current ||
        wsRef.current !== ws ||
        ws.readyState !== WebSocket.OPEN
      ) {
        controller.stop();
        return;
      }

      micControllerRef.current = controller;
      if (captureAllowedRef.current && !ttsActiveRef.current) {
        setCallPhase("listening");
      }
    } catch {
      // mic start failed
    } finally {
      micStartInFlightRef.current = false;
    }
  }, [stopPlaybackImmediately]);

  /* ── WebSocket audio streaming when active ── */
  useEffect(() => {
    if (flowState !== "active") return;

    clearPlaybackState();
    playbackSampleRateRef.current = 16000;
    activeSessionRef.current = true;
    captureAllowedRef.current = false;
    micStartInFlightRef.current = false;
    ttsActiveRef.current = false;

    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setCallPhase("connecting");
      void maybeStartMicCapture();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer) {
        if (ttsActiveRef.current && activePlaybackGenerationRef.current !== null) {
          processBinaryChunk(event.data);
        }
        return;
      }

      // JSON control messages from the backend control protocol.
      try {
        const msg = JSON.parse(event.data as string);
        switch (msg.type) {
          case "capture_pause":
            captureAllowedRef.current = false;
            break;
          case "capture_resume":
            captureAllowedRef.current = true;
            void maybeStartMicCapture();
            if (!ttsActiveRef.current) {
              setCallPhase("listening");
            }
            break;
          case "tts_start": {
            if (msg?.encoding && msg.encoding !== "pcm_s16le") {
              break;
            }
            if (typeof msg?.channels === "number" && msg.channels !== 1) {
              break;
            }

            const sampleRate = Number(msg?.sample_rate);
            playbackSampleRateRef.current = Number.isFinite(sampleRate) && sampleRate > 0
              ? sampleRate
              : 16000;
            beginTtsPlayback();
            break;
          }
          case "tts_end": {
            const generation = activePlaybackGenerationRef.current;
            if (generation === null) break;

            pendingPlaybackEndRef.current = true;
            if (activePlaybackNodesRef.current.length === 0) {
              finalizePlaybackIfDrained(generation);
            }
            break;
          }
          case "tts_stop":
            stopPlaybackImmediately();
            setCallPhase("listening");
            void maybeStartMicCapture();
            break;
        }
      } catch {
        /* ignore non-JSON */
      }
    };

    ws.onerror = () => {
      setCallPhase("connecting");
    };

    ws.onclose = () => {
      activeSessionRef.current = false;
      captureAllowedRef.current = false;
      micStartInFlightRef.current = false;
      wsRef.current = null;
      setCallPhase("connecting");
      stopMicCapture();
      stopPlaybackImmediately();
      closeAudioContext();
    };

    return () => {
      // Cleanup on flowState change / unmount
    activeSessionRef.current = false;
    captureAllowedRef.current = false;
    micStartInFlightRef.current = false;
    ttsActiveRef.current = false;
      if (micControllerRef.current) {
        micControllerRef.current.stop();
        micControllerRef.current = null;
      }
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
      wsRef.current = null;
      setCallPhase("connecting");
      stopPlaybackImmediately();
      closeAudioContext();
    };
  }, [
    beginTtsPlayback,
    closeAudioContext,
    clearPlaybackState,
    finalizePlaybackIfDrained,
    flowState,
    maybeStartMicCapture,
    processBinaryChunk,
    stopMicCapture,
    stopPlaybackImmediately,
  ]);

  const handleStartSession = () => {
    setTimeLeft(SESSION_DURATION_SECONDS);
    setFlowState("active");
  };

  const handleEndCall = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);

    activeSessionRef.current = false;
    captureAllowedRef.current = false;
    micStartInFlightRef.current = false;

    // Stop mic streaming
    stopMicCapture();

    // Close WebSocket
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      wsRef.current.close();
      wsRef.current = null;
    }

    stopPlaybackImmediately();
    closeAudioContext();
    playbackSampleRateRef.current = 16000;

    setFlowState("idle");
    setTimeLeft(0);
    setCallPhase("connecting");
  }, [closeAudioContext, stopMicCapture, stopPlaybackImmediately]);

  /* ── Countdown timer ── */
  useEffect(() => {
    if (flowState !== "active" || timeLeft <= 0) return;

    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          clearInterval(timerRef.current!);
          handleEndCall();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [flowState, timeLeft, handleEndCall]);

  return (
    <main className="relative min-h-screen w-full overflow-hidden bg-[#0F0F13] text-white font-sans selection:bg-rose-500/30">
      {/* ── Background Aurora ── */}
      <div className="absolute inset-0 pointer-events-none">
        <Aurora
          colorStops={["#0B132B", "#6366f1", "#ec4899"]}
          blend={0.5}
          amplitude={flowState === "active" ? 0.6 : 1.0}
          speed={0.5}
        />
      </div>

      {/* ── Content ── */}
      <div
        className={`
          relative z-10 w-full min-h-screen flex flex-col items-center justify-center px-6 sm:px-10 py-16 sm:py-20
          transition-all duration-700 ease-out
          ${isVisible ? "opacity-100 scale-100" : "opacity-0 scale-95"}
        `}
      >
        {flowState === "active" ? (
          <VoiceSessionUI
            isSpeaking={isSpeaking}
            callPhase={callPhase}
            timeLeft={timeLeft}
            totalTime={SESSION_DURATION_SECONDS}
            onEndCall={handleEndCall}
            creatorName={CREATOR.name}
            creatorImage={CREATOR.image}
          />
        ) : (
          /* ── Idle Hero ── */
          <div className="relative w-full max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-center md:justify-between gap-6 md:gap-16">
            {/* Text Content */}
            <div className="relative z-20 flex flex-col items-center md:items-start text-center md:text-left">
              <h2 className="text-[10px] sm:text-sm md:text-base text-rose-300 font-bold tracking-[0.15em] sm:tracking-[0.2em] uppercase mb-2 sm:mb-4 animate-fade-in-up">
                • {CREATOR.role}
              </h2>
              <br />

<h1 className="text-[2.6rem] xs:text-[3.2rem] sm:text-6xl md:text-8xl font-black tracking-tighter leading-[1.05] md:leading-[1.1] mix-blend-exclusion mt-2">
  <span className="block text-transparent bg-clip-text bg-linear-to-r from-white to-white/50">
    {CREATOR.firstName}
  </span>
  <span className="block text-transparent bg-clip-text bg-linear-to-r from-white to-white/50">
    {CREATOR.lastName}
  </span>
</h1>

              <br />
              <br />

              {/* Desktop CTA */}
              <div className="animate-fade-in-up mt-8 shrink-0 hidden md:block">
                <button
                  onClick={handleStartSession}
                  className="group relative inline-flex items-center justify-center rounded-full bg-white text-black font-bold text-sm sm:text-base tracking-wide w-55 h-14 sm:h-16 shadow-[0_0_40px_rgba(255,255,255,0.3)] hover:shadow-[0_0_60px_rgba(255,255,255,0.5)] hover:scale-105 transition-all duration-300"
                >
                  <span className="flex items-center gap-3">
                    Start Session
                    <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 transition-transform duration-300 group-hover:translate-x-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
                    </svg>
                  </span>
                </button>
              </div>
            </div>

            {/* Image */}
            <div className="relative w-50 h-50 xs:w-60 xs:h-60 sm:w-75 sm:h-75 md:w-125 md:h-150 shrink-0">
              <div
                ref={(el) => { avatarRefs.current[1] = el; }}
                className="relative w-full h-full overflow-hidden shadow-2xl hover:scale-[1.02] transition-transform duration-700 will-change-transform"
                style={{ borderRadius: "30% 70% 70% 30% / 30% 30% 70% 70%" }}
              >
                <Image
                  src={CREATOR.image}
                  alt={CREATOR.name}
                  fill
                  sizes="(min-width: 768px) 500px, (min-width: 640px) 300px, (min-width: 475px) 240px, 200px"
                  className="object-cover scale-110"
                  priority
                />
                <div className="absolute inset-0 bg-linear-to-t from-black/50 via-transparent to-transparent opacity-60" />
              </div>

              {/* Floating Decorative Elements — clipped so they don't overflow on tiny screens */}
              <div
                className="absolute -top-6 -right-6 sm:-top-12 sm:-right-12 w-12 h-12 sm:w-24 sm:h-24 bg-white/10 backdrop-blur-md border border-white/20 z-20 animate-float"
                style={{ borderRadius: "50%" }}
              />
              <div
                className="absolute bottom-16 -left-4 sm:-left-16 w-14 h-14 sm:w-32 sm:h-32 bg-rose-500/20 backdrop-blur-md border border-rose-500/20 z-20 animate-float animation-delay-2000"
                style={{ borderRadius: "60% 40% 30% 70% / 60% 30% 70% 40%" }}
              />
            </div>

            {/* Mobile CTA */}
            <div className="animate-fade-in-up mt-6 md:hidden w-full flex justify-center z-30">
              <button
                onClick={handleStartSession}
                className="group relative inline-flex items-center justify-center gap-3 rounded-full bg-white text-black font-bold text-sm tracking-wide w-45 xs:w-50 h-13 sm:h-16 shadow-[0_0_40px_rgba(255,255,255,0.3)] hover:shadow-[0_0_60px_rgba(255,255,255,0.5)] hover:scale-105 transition-all duration-300"
              >
                Start Session
                <svg xmlns="http://www.w3.org/2000/svg" className="w-5 h-5 transition-transform duration-300 group-hover:translate-x-1" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M5 12h14" /><path d="m12 5 7 7-7 7" />
                </svg>
              </button>
            </div>
          </div>
        )}
      </div>

    </main>
  );
}
