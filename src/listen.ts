import { createPlayer, type Player } from "./audio.ts";
import { LiveError } from "./errors.ts";
import { DEFAULT_BASE_URL, type Speaker, type TokenSource, type TranscriptLine } from "./protocol.ts";
import { keepOpen, safely, type ConnectionStatus } from "./socket.ts";

/** Who is speaking right now. */
export type Speaking = Readonly<Record<Speaker, boolean>>;

/** Options for {@link listenToCall}. */
export interface CallListenerOptions {
  /** Where tokens come from: your token route's URL, or a function. */
  token: TokenSource;
  /** Receive the live transcript from the start. Default `false`; see {@link CallListener.setTranscript}. */
  transcript?: boolean;
  /** Called whenever who is speaking changes. */
  onSpeaking?: (speaking: Speaking) => void;
  /** Called when the caller talks over the AI agent. */
  onInterrupt?: () => void;
  /**
   * Called for each transcript line. A line with `final: false` replaces that
   * speaker's unfinished line; `final: true` settles it. `addTranscriptLine`
   * keeps a list in speaking order for you. After a reconnect, words spoken
   * while disconnected are missing.
   */
  onTranscript?: (line: TranscriptLine) => void;
  /** Called whenever the connection status changes. */
  onStatus?: (status: ConnectionStatus) => void;
  /** Called once when listening is over: `null` when the call ended (also while reconnecting), otherwise why it stopped. */
  onEnd?: (error: LiveError | null) => void;
  /** Override only to point at a test environment. */
  baseUrl?: string;
}

/** A live call you are connected to. */
export interface CallListener {
  /**
   * Starts playing the call's audio, or resumes it if the device paused.
   * Call it from a click or key press: browsers only start audio after one.
   * Returns `false`, and does nothing, once the listener has closed.
   */
  playAudio(): boolean;
  /** Stops the audio, including any still playing out after the call ended. Speaking events and transcripts keep coming. */
  stopAudio(): void;
  /** Starts or stops the live transcript. */
  setTranscript(on: boolean): void;
  /** Disconnects and releases the audio device at once. Final: nothing restarts it. */
  close(): void;
}

const CALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const QUIET: Speaking = { caller: false, agent: false };
const isSpeaker = (who: unknown): who is Speaker => who === "caller" || who === "agent";

/**
 * Connects to one live call: who is speaking, the live transcript on request,
 * and its audio once you call `playAudio()`. Audio is only sent while it is
 * on, so an open connection costs little.
 *
 * @example
 * const call = listenToCall(callId, {
 *   token: "/api/karing/token",
 *   onSpeaking: (s) => render(s.caller, s.agent),
 * });
 * playButton.onclick = () => call.playAudio();
 */
export const listenToCall = (callId: string, options: CallListenerOptions): CallListener => {
  if (!CALL_ID.test(callId)) throw new LiveError("not-live", `"${callId}" is not a call id.`);
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/^http/, "ws").replace(/\/$/, "");
  let audioOn = false;
  let transcriptOn = options.transcript === true;
  let player: Player | undefined;
  let speaking: Speaking = QUIET;
  let disposed = false;
  // Karing sends "start" only once it has found the call live and its stream open.
  let established = false;

  const setSpeaking = (next: Speaking) => {
    if (next.caller === speaking.caller && next.agent === speaking.agent) return;
    speaking = next;
    safely(() => options.onSpeaking?.(speaking));
  };

  // Kept until closed, so close() and stopAudio() can still cut short audio playing out after the call ended.
  const stopPlayer = () => {
    player?.close();
    player = undefined;
  };

  const connection = keepOpen({
    url: `${base}/live-calls/${encodeURIComponent(callId)}/listen`,
    token: options.token,
    final: new Set(["ended", "not-live", "forbidden", "rejected"]),
    maxRetries: 5,
    onOpen: (send) => {
      // The server starts every connection with both off.
      if (audioOn) send({ type: "audio", on: true });
      if (transcriptOn) send({ type: "transcript", on: true });
    },
    onMessage: (data) => {
      if (typeof data !== "string") return player?.push(data);
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      if (!event || typeof event !== "object") return;
      const e = event as Record<string, unknown>;
      if (e.type === "start") established = true;
      else if (e.type === "speech" && isSpeaker(e.who) && (e.state === "start" || e.state === "stop")) {
        setSpeaking({ ...speaking, [e.who]: e.state === "start" });
      } else if (e.type === "interrupt") {
        safely(() => options.onInterrupt?.());
      } else if (
        e.type === "transcript" &&
        transcriptOn && // one already on its way when it was switched off is dropped
        isSpeaker(e.who) &&
        typeof e.text === "string" &&
        typeof e.final === "boolean"
      ) {
        const line: TranscriptLine = { who: e.who, text: e.text, final: e.final };
        safely(() => options.onTranscript?.(line));
      }
    },
    onStatus: (status) => {
      // Nothing is known about who is speaking until the stream is back.
      if (status !== "open") setSpeaking(QUIET);
      safely(() => options.onStatus?.(status));
    },
    onEnd: (failure) => {
      // A call that was established, and is not live on reconnecting, ended in the meantime.
      const error = failure?.reason === "not-live" && established ? null : failure;
      disposed = true;
      audioOn = false;
      // The call's last words can still be queued: they play out, unless stopped.
      if (error) stopPlayer();
      else player?.finish();
      safely(() => options.onEnd?.(error));
    },
  });

  return {
    playAudio() {
      if (disposed) return false;
      if (player) player.resume();
      else player = createPlayer();
      if (!audioOn) {
        audioOn = true;
        connection.send({ type: "audio", on: true });
      }
      return true;
    },
    stopAudio() {
      stopPlayer();
      if (!audioOn) return;
      audioOn = false;
      connection.send({ type: "audio", on: false });
    },
    setTranscript(on) {
      if (disposed || on === transcriptOn) return;
      transcriptOn = on;
      connection.send({ type: "transcript", on });
    },
    close() {
      stopPlayer();
      if (disposed) return;
      disposed = true;
      audioOn = false;
      connection.close();
    },
  };
};
