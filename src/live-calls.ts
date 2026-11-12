import type { LiveError } from "./errors.ts";
import { DEFAULT_BASE_URL, type CallEnd, type LiveCall, type TokenSource, type ToolCall } from "./protocol.ts";
import { keepOpen, safely, type ConnectionStatus } from "./socket.ts";

/** Options for {@link watchLiveCalls}. */
export interface LiveCallsOptions {
  /** Where tokens come from: your token route's URL, or a function. */
  token: TokenSource;
  /** Called with the full list of live calls whenever it changes, newest first. */
  onChange: (calls: readonly LiveCall[]) => void;
  /** Called whenever the connection status changes. */
  onStatus?: (status: ConnectionStatus) => void;
  /** Called if the board stops for good, with why. */
  onError?: (error: LiveError) => void;
  /**
   * Called when a call on the board ends, with the call as last shown and how
   * it ended. Not called for a call taken off the board after two hours, nor
   * for one that ended while you were disconnected. A call that comes back on
   * the board and ends again is reported again.
   */
  onEnded?: (call: LiveCall, end: CallEnd) => void;
  /** Override only to point at a test environment. */
  baseUrl?: string;
}

const nullableString = (v: unknown) => v === null || typeof v === "string";
const DIRECTIONS = new Set([null, "inbound", "outbound", "web"]);
const SENTIMENTS = new Set(["positive", "neutral", "negative"]);

const isTool = (t: unknown): t is ToolCall => {
  const x = t as Record<string, unknown> | null;
  return !!x && typeof x.name === "string" && nullableString(x.startedAt) && nullableString(x.endedAt);
};

/**
 * Every field checked: one malformed call must not break the board. The
 * fields a server may leave out (sentiment, topic, tools) are filled in.
 */
const toCall = (call: unknown): LiveCall | undefined => {
  if (!call || typeof call !== "object") return;
  const c = call as Record<string, unknown>;
  const valid =
    typeof c.callId === "string" &&
    DIRECTIONS.has(c.direction as string | null) &&
    [c.agentId, c.agentName, c.phoneNumber, c.phoneNumberName, c.customerNumber, c.startedAt].every(nullableString);
  if (!valid) return;
  return {
    ...(c as unknown as LiveCall),
    sentiment: SENTIMENTS.has(c.sentiment as string) ? (c.sentiment as LiveCall["sentiment"]) : null,
    topic: typeof c.topic === "string" ? c.topic : null,
    tools: Array.isArray(c.tools) ? c.tools.filter(isTool).slice(-20) : [],
  };
};

/** Any outcome but a transfer reads as `"ended"`; a destination only rides a transfer. */
const endOf = (e: Record<string, unknown>): CallEnd => {
  const outcome = typeof e.outcome !== "string" ? null : e.outcome === "transferred" ? "transferred" : "ended";
  return { outcome, transferredTo: outcome === "transferred" && typeof e.transferredTo === "string" ? e.transferredTo : null };
};

/** Newest first; calls with no start time last. */
const byStart = (a: LiveCall, b: LiveCall) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "");

/**
 * Keeps a list of your organization's live calls current. It reconnects on
 * its own, and every reconnect starts from a fresh, complete list.
 *
 * @example
 * const board = watchLiveCalls({
 *   token: "/api/karing/token",
 *   onChange: (calls) => render(calls),
 * });
 * // later: board.close();
 */
export const watchLiveCalls = (options: LiveCallsOptions): { close: () => void } => {
  const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/^http/, "ws").replace(/\/$/, "");
  const calls = new Map<string, LiveCall>();
  const changed = () => {
    const list = [...calls.values()].sort(byStart);
    safely(() => options.onChange(list));
  };

  return keepOpen({
    url: `${base}/live-calls`,
    token: options.token,
    final: new Set(["not-live", "forbidden", "rejected"]),
    maxRetries: Infinity,
    onOpen: () => {},
    onMessage: (data) => {
      if (typeof data !== "string") return;
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      if (!event || typeof event !== "object") return;
      const e = event as Record<string, unknown>;
      const upsert = e.type === "call.upsert" ? toCall(e.call) : undefined;
      if (e.type === "snapshot" && Array.isArray(e.calls)) {
        calls.clear();
        for (const raw of e.calls) {
          const call = toCall(raw);
          if (call) calls.set(call.callId, call);
        }
      } else if (upsert) {
        calls.set(upsert.callId, upsert);
      } else if (e.type === "call.removed" && typeof e.callId === "string") {
        const ended = calls.get(e.callId);
        if (!ended) return;
        calls.delete(e.callId);
        if (e.reason === "ended") safely(() => options.onEnded?.(ended, endOf(e)));
      } else {
        return;
      }
      changed();
    },
    onStatus: (status) => safely(() => options.onStatus?.(status)),
    onEnd: (error) => {
      if (error) safely(() => options.onError?.(error));
    },
  });
};
