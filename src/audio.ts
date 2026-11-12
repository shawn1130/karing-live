/**
 * Plays the listen socket's audio: G.711 mu-law, 8 kHz, mono, in ~100 ms
 * binary messages.
 *
 * A 250 ms cushion absorbs network jitter. When more than a second is queued,
 * as after a network stall, the queue is stopped so the listener stays near
 * live; nothing ever plays over anything else. While the audio device is not
 * playing (suspended, or interrupted by a phone call), live audio is dropped
 * rather than queued, and `resume()` from a click starts it again.
 */

const MULAW = Float32Array.from({ length: 256 }, (_, i) => {
  const b = ~i & 0xff;
  const t = (((b & 0x0f) << 3) + 0x84) << ((b & 0x70) >> 4);
  return (b & 0x80 ? 0x84 - t : t - 0x84) / 32768;
});

const CUSHION_S = 0.25;
const MAX_QUEUED_S = 1;

// On iPhone, web audio otherwise follows the ring/silent switch. The page's
// own setting is restored when the last player closes.
type AudioSession = { type: string };
const audioSession = () => (globalThis.navigator as { audioSession?: AudioSession } | undefined)?.audioSession;
let sessionHolders = 0;
let pageSessionType: string | undefined;

export interface Player {
  /** Queues one binary message of mu-law audio. */
  push(data: ArrayBuffer): void;
  /** Starts a suspended or interrupted device again. Call it from a click. */
  resume(): void;
  /** Lets what is queued play out, then releases the device. `close()` still stops it at once. */
  finish(): void;
  /** Stops playback and releases the audio device. */
  close(): void;
}

/**
 * Starts an audio player. Call it from a click or key press: browsers only
 * start audio after one.
 */
export const createPlayer = (): Player => {
  // The device first: if it cannot be had, the page's audio setting is never touched.
  const ctx = new AudioContext({ sampleRate: 8000 });
  const session = audioSession();
  if (session && sessionHolders++ === 0) {
    pageSessionType = session.type;
    session.type = "playback";
  }
  const queued = new Set<AudioBufferSourceNode>();
  let at = 0; // when the next chunk plays, on the AudioContext clock
  let closed = false;
  // Set by finish(): the device is released once the last queued chunk has played.
  let finishing = false;

  const dropQueue = () => {
    for (const source of queued) {
      try {
        source.stop();
      } catch {}
    }
    queued.clear();
    at = 0;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    dropQueue();
    void ctx.close().catch(() => {});
    if (session && --sessionHolders === 0 && pageSessionType !== undefined) session.type = pageSessionType;
  };

  // Paused or interrupted: what was queued is stale live audio, never replayed.
  ctx.onstatechange = () => {
    if (ctx.state === "running") return;
    dropQueue();
    if (finishing) close();
  };

  return {
    push(data) {
      if (closed) return;
      if (ctx.state !== "running") return dropQueue();
      const bytes = new Uint8Array(data);
      if (!bytes.length) return;
      const buffer = ctx.createBuffer(1, bytes.length, 8000);
      const samples = buffer.getChannelData(0);
      for (let i = 0; i < bytes.length; i++) samples[i] = MULAW[bytes[i]!]!;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const now = ctx.currentTime;
      if (at > now + MAX_QUEUED_S) dropQueue();
      if (at <= now) at = now + CUSHION_S;
      source.connect(ctx.destination);
      // On the audio clock, so the last chunk has really played, not merely been due.
      source.onended = () => {
        queued.delete(source);
        if (finishing && !queued.size) close();
      };
      queued.add(source);
      source.start(at);
      at += buffer.duration;
    },
    resume() {
      if (closed || ctx.state === "running") return;
      dropQueue();
      void ctx.resume().catch(() => {});
    },
    finish() {
      if (closed) return;
      finishing = true;
      if (ctx.state !== "running" || !queued.size) close();
    },
    close,
  };
};
