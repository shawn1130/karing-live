/**
 * The shapes Karing sends and accepts. Everything here mirrors the wire format
 * exactly, so these types are also the reference for the protocol itself.
 *
 * @module
 */

/** Where Karing's API lives. Override only to point at a test environment. */
export const DEFAULT_BASE_URL = "https://api.karing.ai";

/** A short-lived token that opens live sockets for your organization's calls. */
export interface LiveToken {
  /** Pass this to the browser. It opens sockets for one minute; an open socket stays open. */
  token: string;
  /** When the token stops opening new sockets, as an ISO 8601 timestamp. */
  expiresAt: string;
}

/**
 * Where a token comes from in the browser: either the URL of your own token
 * route (see `createTokenHandler` in `@karing/live/server`), which is called
 * with `POST` and your page's cookies, or a function that returns a token.
 * A function is passed a signal that aborts when the package stops waiting
 * (after 10 seconds, or when the connection closes); pass it to `fetch`.
 *
 * @example "/api/karing/token"
 * @example async (signal) => (await fetch("/api/karing/token", { method: "POST", signal })).json()
 */
export type TokenSource = string | ((signal?: AbortSignal) => Promise<LiveToken | string>);

/** Who is talking on a call. */
export type Speaker = "caller" | "agent";

/** One live call, as your board shows it. Every call leg is its own call. */
export interface LiveCall {
  /** The call leg's id. The same id Karing's call logs show. */
  callId: string;
  /** The AI agent on the call, or `null` when unknown. */
  agentId: string | null;
  /** The AI agent's display name, or `null` when unknown. */
  agentName: string | null;
  /** `"inbound"`, `"outbound"` or `"web"`; `null` when unknown. */
  direction: "inbound" | "outbound" | "web" | null;
  /**
   * The clinic line on the call in E.164 form (`+15551234567`): the number
   * dialed, or the number an outbound call came from. `null` on internal
   * transfer lines and web calls.
   */
  phoneNumber: string | null;
  /** The name of that line, including internal transfer lines. `null` when unnamed. */
  phoneNumberName: string | null;
  /** The caller's number in E.164 form, or `null` when withheld or on a web call. */
  customerNumber: string | null;
  /** When the call started, as an ISO 8601 timestamp. `null` when unknown. */
  startedAt: string | null;
}

/** A line of the live transcript. */
export interface TranscriptLine {
  /** Who said it. */
  who: Speaker;
  /** What was said. */
  text: string;
  /**
   * `false` while the words may still change (a live caption), `true` once
   * they are settled. Each settled line replaces the speaker's live caption.
   */
  final: boolean;
}

/** Messages the listen socket sends as text. */
export type ListenEvent =
  | { type: "start"; encoding: "mulaw"; sampleRate: 8000; channels: 1 }
  | { type: "speech"; who: Speaker; state: "start" | "stop" }
  | { type: "interrupt" }
  | ({ type: "transcript" } & TranscriptLine);

/**
 * Messages the live board socket sends. Apply them by `callId`:
 * a `snapshot` replaces everything you hold; `call.upsert` adds or updates
 * one call; `call.removed` takes one away. The board is current state, not
 * a history: a call that starts and ends while you are disconnected never
 * appears.
 */
export type BoardEvent =
  | { type: "snapshot"; calls: LiveCall[] }
  | { type: "call.upsert"; call: LiveCall }
  | {
      type: "call.removed";
      callId: string;
      /**
       * `"ended"`: no longer live. `"stale"`: shown for two hours, which is a
       * display rule, not proof the call ended.
       */
      reason: "ended" | "stale";
    };

/** Messages the listen socket accepts. */
export type ListenCommand = { type: "audio"; on: boolean } | { type: "transcript"; on: boolean };

/**
 * Why a socket closed, by close code, with what to do about it. The package
 * acts on these for you; they are listed so you can tell a user why.
 */
export const CLOSE_CODES = {
  /** The stream ended, normally because the call did. */
  1000: "ended",
  /** The connection dropped, or Karing was too busy to accept it. Reconnect with backoff. */
  1006: "dropped",
  /** The socket was sent something it does not accept. */
  1008: "rejected",
  /** Something failed on Karing's side. Retry a couple of times with backoff. */
  1011: "failed",
  /** Karing restarted a server. Reconnect straight away. */
  1012: "restarting",
  /** The token expired or was not valid. Get a new one. */
  4401: "unauthorized",
  /** The socket needs a token for a single organization. */
  4403: "forbidden",
  /** The call is not live, or is not one of yours. Do not reconnect. */
  4404: "not-live",
  /** Too many listeners right now. Try again later. */
  4429: "busy",
} as const;

/** The reason names in {@link CLOSE_CODES}, plus `"unknown"` for any other code. */
export type CloseReason = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES] | "unknown";

/** The reason name for a close code. */
export const closeReason = (code: number): CloseReason =>
  (Object.hasOwn(CLOSE_CODES, code) ? CLOSE_CODES[code as keyof typeof CLOSE_CODES] : "unknown");
