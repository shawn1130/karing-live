"use client";
/**
 * React hooks for live calls. Wrap the part of your app that shows live
 * calls in {@link KaringLiveProvider}, then use {@link useLiveCalls} for the
 * board and {@link useCall} for one call's audio, speakers and transcript.
 *
 * @module
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { LiveError } from "./errors.ts";
import { listenToCall, type CallListener, type Speaking } from "./listen.ts";
import { watchLiveCalls } from "./live-calls.ts";
import type { LiveCall, TokenSource, TranscriptLine } from "./protocol.ts";
import { fetchToken, type ConnectionStatus } from "./socket.ts";
import { addTranscriptLine, dropCaptions, EMPTY_TRANSCRIPT, type Transcript } from "./transcript.ts";

export * from "./index.ts";

/** One signed-in identity's settings. A new one tears every connection down. */
type Config = { token: (signal?: AbortSignal) => Promise<string>; baseUrl: string | undefined; scope: string };
const LiveContext = createContext<Config | null>(null);

/** Props for {@link KaringLiveProvider}. */
export interface KaringLiveProviderProps {
  /**
   * Where tokens come from: the URL of your token route (see
   * `createTokenHandler` in `@karing-ai/live/server`), or a function that
   * returns one. A function may change between renders without reconnecting.
   */
  token: TokenSource;
  /**
   * Who is signed in and for which organization, for example
   * `` `${user.id}:${org.id}` ``. When it changes (sign-out, a different user,
   * an organization switch), every live connection closes and nothing from
   * before is shown again. Required, so one person never sees another's calls.
   */
  scope: string;
  /** Override only to point at a test environment. */
  baseUrl?: string;
  children?: ReactNode;
}

/**
 * Makes live calls available to the hooks below it.
 *
 * @example
 * <KaringLiveProvider token="/api/karing/token" scope={`${user.id}:${org.id}`}>
 *   <LiveBoard />
 * </KaringLiveProvider>
 */
export function KaringLiveProvider({ token, scope, baseUrl, children }: KaringLiveProviderProps): ReactElement {
  // The token source as of the last committed render: a render React throws
  // away never changes what live connections use. Layout effects run before
  // the hooks' effects open anything.
  const source = useRef(token);
  useLayoutEffect(() => {
    source.current = token;
  });
  const tokenKey = typeof token === "string" ? token : "function";
  const value = useMemo<Config>(
    () => ({ token: (signal) => fetchToken(source.current, signal), baseUrl, scope }),
    // tokenKey: a different route is a different setup; a new function is not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scope, tokenKey, baseUrl],
  );
  return createElement(LiveContext.Provider, { value }, children);
}

const useConfig = (hook: string): Config => {
  const config = useContext(LiveContext);
  if (!config) throw new Error(`${hook}() must be used inside <KaringLiveProvider token="..." scope="...">.`);
  return config;
};

/** What {@link useLiveCalls} returns. */
export interface LiveCallsState {
  /** Your organization's live calls, newest first. Empty until the first update. */
  calls: readonly LiveCall[];
  /** Where the connection stands. */
  status: ConnectionStatus;
  /** Why the board stopped for good, if it did. */
  error: LiveError | null;
}

const NO_CALLS: LiveCallsState = { calls: [], status: "connecting", error: null };

/**
 * Your organization's live calls, kept current. Calls appear as they start
 * and disappear as they end; after a reconnect the list is rebuilt from
 * scratch.
 *
 * @example
 * const { calls, status } = useLiveCalls();
 * return calls.map((call) => <Row key={call.callId} call={call} />);
 */
export function useLiveCalls(): LiveCallsState {
  const config = useConfig("useLiveCalls");
  // State remembers whose it is, so a new scope never shows the last one's calls, not even for one render.
  const [state, setState] = useState<{ owner: Config; value: LiveCallsState } | null>(null);

  useEffect(() => {
    const update = (patch: Partial<LiveCallsState>) =>
      setState((s) => ({ owner: config, value: { ...(s?.owner === config ? s.value : NO_CALLS), ...patch } }));
    const board = watchLiveCalls({
      token: config.token,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      onChange: (calls) => update({ calls }),
      onStatus: (status) => update({ status }),
      onError: (error) => update({ error }),
    });
    return () => board.close();
  }, [config]);

  return state?.owner === config ? state.value : NO_CALLS;
}

/** Options for {@link useCall}. */
export interface UseCallOptions {
  /** Receive the live transcript. Default `false`. Switching it does not reconnect. */
  transcript?: boolean;
}

/** What {@link useCall} returns. */
export interface CallState {
  /** Where the connection stands. */
  status: ConnectionStatus;
  /** Who is speaking right now. */
  speaking: Speaking;
  /**
   * The transcript, oldest first, when `transcript` is on: at most the last
   * 500 lines. A speaker's unfinished line (`final: false`) keeps its place
   * and changes as they speak. Words spoken while disconnected are missing.
   */
  transcript: readonly TranscriptLine[];
  /** Whether the audio is playing. */
  audio: boolean;
  /**
   * Starts the audio, or resumes it if the device paused. Call it from a
   * click: browsers only start audio after one.
   */
  playAudio: () => void;
  /** Stops the audio. */
  stopAudio: () => void;
  /** `true` once the call has ended. */
  ended: boolean;
  /** Why listening stopped, if it was not the call ending. */
  error: LiveError | null;
}

type CallValue = Omit<CallState, "playAudio" | "stopAudio" | "transcript"> & { transcript: Transcript };
const QUIET: Speaking = { caller: false, agent: false };
const FRESH: CallValue = { status: "connecting", speaking: QUIET, transcript: EMPTY_TRANSCRIPT, audio: false, ended: false, error: null };
const CLOSED: CallValue = { ...FRESH, status: "closed" };

/**
 * One live call: who is speaking, its audio, and (with `transcript: true`)
 * its live transcript. Pass `null` to connect to nothing.
 *
 * @example
 * const call = useCall(callId, { transcript: true });
 * <button onClick={call.audio ? call.stopAudio : call.playAudio}>
 *   {call.audio ? "Stop" : "Listen"}
 * </button>
 */
export function useCall(callId: string | null | undefined, options: UseCallOptions = {}): CallState {
  const config = useConfig("useCall");
  const transcriptOn = options.transcript === true;
  // Whose state this is: the scope and the call. Anything else is never returned.
  const owner = useMemo(() => ({ config, callId: callId ?? null }), [config, callId]);
  const [state, setState] = useState<{ owner: typeof owner; value: CallValue } | null>(null);
  const listener = useRef<{ owner: typeof owner; call: CallListener } | null>(null);
  // Read when a connection opens; set only by committed renders.
  const wantTranscript = useRef(transcriptOn);
  useLayoutEffect(() => {
    wantTranscript.current = transcriptOn;
  });

  const update = useCallback(
    (patch: (value: CallValue) => Partial<CallValue>) =>
      setState((s) => {
        const value = s?.owner === owner ? s.value : FRESH;
        return { owner, value: { ...value, ...patch(value) } };
      }),
    [owner],
  );

  useEffect(() => {
    if (!owner.callId) return;
    const call = listenToCall(owner.callId, {
      token: config.token,
      ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      transcript: wantTranscript.current,
      onSpeaking: (speaking) => update(() => ({ speaking })),
      onStatus: (status) =>
        // A gap: an unfinished line will never be settled.
        update((v) => ({ status, ...(status === "open" ? {} : { transcript: dropCaptions(v.transcript) }) })),
      onTranscript: (line) => {
        // Only while the committed render wants it, so nothing returns after it was switched off.
        if (wantTranscript.current) update((v) => ({ transcript: addTranscriptLine(v.transcript, line) }));
      },
      onEnd: (why) => update(() => ({ audio: false, ...(why ? { error: why } : { ended: true }) })),
    });
    listener.current = { owner, call };
    return () => {
      listener.current = null;
      call.close();
    };
  }, [owner, config, update]);

  useEffect(() => {
    const current = listener.current;
    if (current?.owner !== owner) return;
    current.call.setTranscript(transcriptOn);
    if (!transcriptOn) update((v) => ({ transcript: dropCaptions(v.transcript) }));
  }, [transcriptOn, owner, update]);

  const playAudio = useCallback(() => {
    const current = listener.current;
    if (current?.owner === owner && current.call.playAudio()) update(() => ({ audio: true }));
  }, [owner, update]);
  const stopAudio = useCallback(() => {
    const current = listener.current;
    if (current?.owner !== owner) return;
    current.call.stopAudio();
    update(() => ({ audio: false }));
  }, [owner, update]);

  const value = !owner.callId ? CLOSED : state?.owner === owner ? state.value : FRESH;
  const transcript = transcriptOn ? value.transcript.lines : EMPTY_TRANSCRIPT.lines;
  return { ...value, transcript, playAudio, stopAudio };
}
