import type { LiveError } from "./errors.ts";
import { DEFAULT_BASE_URL, type LiveCall, type TokenSource } from "./protocol.ts";
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
  /** Override only to point at a test environment. */
  baseUrl?: string;
}

const nullableString = (v: unknown) => v === null || typeof v === "string";
const DIRECTIONS = new Set([null, "inbound", "outbound", "web"]);

/** Every field checked: one malformed call must not break the board. */
const isCall = (call: unknown): call is LiveCall => {
  if (!call || typeof call !== "object") return false;
  const c = call as Record<string, unknown>;
  return (
    typeof c.callId === "string" &&
    DIRECTIONS.has(c.direction as string | null) &&
    [c.agentId, c.agentName, c.phoneNumber, c.phoneNumberName, c.customerNumber, c.startedAt].every(nullableString)
  );
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
    url: (token) => `${base}/live-calls?token=${encodeURIComponent(token)}`,
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
      if (e.type === "snapshot" && Array.isArray(e.calls)) {
        calls.clear();
        for (const call of e.calls) if (isCall(call)) calls.set(call.callId, call);
      } else if (e.type === "call.upsert" && isCall(e.call)) {
        calls.set(e.call.callId, e.call);
      } else if (e.type === "call.removed" && typeof e.callId === "string") {
        if (!calls.delete(e.callId)) return;
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
