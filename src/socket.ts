import { LiveError } from "./errors.ts";
import { closeReason, type CloseReason, type TokenSource } from "./protocol.ts";

/**
 * Where a live connection stands.
 *
 * - `"connecting"`: getting a token and opening the socket.
 * - `"open"`: connected to Karing; the call's stream may still be starting.
 * - `"reconnecting"`: the connection dropped and is being reopened.
 * - `"closed"`: finished, either by you or for good (see the error).
 */
export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

// Only ever shown once retrying is over, so none of these promise a retry.
const GUIDANCE: Record<CloseReason | "token" | "unsupported", string> = {
  ended: "The stream ended.",
  dropped: "The connection dropped and could not be restored.",
  rejected: "Karing refused a message this client sent. Please report it; this is a bug.",
  failed: "Something failed on Karing's side, and retrying did not help.",
  restarting: "Karing restarted a server, and reconnecting did not succeed.",
  unauthorized: "The token was refused. Check that your token route returns a fresh token from createTokenHandler().",
  forbidden: "This needs a token for a single organization.",
  "not-live": "The call is not live, or is not one of yours.",
  busy: "Too many connections right now. Try again later.",
  unknown: "The connection closed unexpectedly and could not be restored.",
  token: "Your token route did not return a token.",
  unsupported: "This environment could not open a live connection.",
};

const errorFor = (reason: keyof typeof GUIDANCE, detail?: string) =>
  new LiveError(reason, detail ? `${GUIDANCE[reason]} ${detail}` : GUIDANCE[reason]);

/** How long getting one token may take before the attempt counts as failed. */
export const TOKEN_TIMEOUT_MS = 10_000;

/**
 * Runs a callback you passed in, so a throw in your code cannot break the
 * package's own cleanup. The error is rethrown on its own, where your error
 * reporting sees it.
 */
export const safely = (fn: () => void): void => {
  try {
    fn();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
};

/** Gets a token string from a {@link TokenSource}, giving up when `signal` aborts. */
export const fetchToken = async (source: TokenSource, signal: AbortSignal): Promise<string> => {
  const tooLong = () => errorFor("token", "Getting a token took too long.");
  let value: unknown;
  if (typeof source === "function") {
    value = await new Promise((resolve, reject) => {
      if (signal.aborted) return reject(tooLong());
      signal.addEventListener("abort", () => reject(tooLong()), { once: true });
      source(signal).then(resolve, reject);
    });
  } else {
    let response: Response;
    try {
      response = await fetch(source, {
        method: "POST",
        credentials: "same-origin",
        headers: { accept: "application/json" },
        signal,
      });
    } catch {
      throw signal.aborted ? tooLong() : errorFor("token", `Could not reach ${source}.`);
    }
    if (!response.ok) throw errorFor("token", `${source} answered ${response.status}.`);
    try {
      value = await response.json();
    } catch {
      throw errorFor("token", `${source} did not answer with JSON.`);
    }
  }
  const token = typeof value === "string" ? value : value && typeof value === "object" ? (value as { token?: unknown }).token : undefined;
  if (typeof token !== "string" || !token) throw errorFor("token");
  return token;
};

export interface KeepOpenOptions {
  /** The socket URL. The token goes in the handshake's subprotocols, never here. */
  url: string;
  token: TokenSource;
  /** Close reasons after which reopening is pointless. */
  final: ReadonlySet<CloseReason>;
  /** How many failed attempts in a row before giving up. */
  maxRetries: number;
  /** Called on every open, so the desired state can be sent again after a reconnect. */
  onOpen: (send: (command: object) => void) => void;
  onMessage: (data: string | ArrayBuffer) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** Called once when the connection is finished for good: `null` when the stream simply ended. */
  onEnd: (error: LiveError | null) => void;
}

/** The longest wait between attempts. */
const MAX_BACKOFF_MS = 30_000;
/** A socket that stayed open this long resets the backoff. */
const HEALTHY_MS = 60_000;

/**
 * Keeps a live socket open: a fresh token for every attempt (within
 * {@link TOKEN_TIMEOUT_MS}), and on a drop a reconnect, straight away the
 * first time Karing restarts a server or a token expires on the way, and
 * otherwise after a growing, randomized delay, until a final close reason or
 * `maxRetries`.
 */
export const keepOpen = (options: KeepOpenOptions): { send: (command: object) => void; close: () => void } => {
  let socket: WebSocket | undefined;
  let attempt: AbortController | undefined;
  let attempts = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const status = (next: ConnectionStatus) => safely(() => options.onStatus(next));

  const finish = (error: LiveError | null) => {
    if (stopped) return;
    stopped = true;
    status("closed");
    safely(() => options.onEnd(error));
  };

  const retry = (error: LiveError, immediately: boolean) => {
    if (stopped) return;
    if (attempts >= options.maxRetries) return finish(error);
    attempts++;
    status("reconnecting");
    if (immediately) return void connect();
    // Full jitter, so many clients dropped at once do not return at once.
    timer = setTimeout(connect, Math.random() * Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (attempts - 1)));
  };

  const connect = async () => {
    if (stopped) return;
    if (!attempts) status("connecting");
    const mine = new AbortController();
    attempt = mine;
    const deadline = setTimeout(() => mine.abort(), TOKEN_TIMEOUT_MS);
    let token: string;
    try {
      token = await fetchToken(options.token, mine.signal);
    } catch (error) {
      if (stopped || attempt !== mine) return;
      return retry(error instanceof LiveError ? error : errorFor("token", String(error)), false);
    } finally {
      clearTimeout(deadline);
    }
    if (stopped || attempt !== mine) return;

    let ws: WebSocket;
    try {
      // In the subprotocol header, not the URL, which request logs keep. The
      // server answers with the first name offered, so the token is never echoed.
      ws = new WebSocket(options.url, ["karing-live", token]);
    } catch (error) {
      // A bad address or no WebSocket support: retrying cannot help.
      return finish(errorFor("unsupported", error instanceof Error ? error.message : undefined));
    }
    ws.binaryType = "arraybuffer";
    socket = ws;
    let openedAt = 0;
    // The close code Karing announced as a message just before closing. Some
    // networks deliver close codes as 1005 or 1006, so this one is trusted then.
    let announced: number | undefined;
    const send = (command: object) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(command));
    };

    ws.onopen = () => {
      if (socket !== ws) return;
      openedAt = Date.now();
      status("open");
      safely(() => options.onOpen(send));
    };
    ws.onmessage = (event) => {
      if (socket !== ws) return;
      const data = event.data as string | ArrayBuffer;
      if (typeof data === "string" && data.startsWith('{"type":"close"')) {
        try {
          const code = (JSON.parse(data) as { code?: unknown }).code;
          if (typeof code === "number") announced = code;
        } catch {}
        return;
      }
      safely(() => options.onMessage(data));
    };
    ws.onclose = (event) => {
      if (socket !== ws || stopped) return;
      socket = undefined;
      if (openedAt && Date.now() - openedAt > HEALTHY_MS) attempts = 0;
      const reason = closeReason((event.code === 1005 || event.code === 1006) && announced !== undefined ? announced : event.code);
      if (options.final.has(reason)) return finish(reason === "ended" ? null : errorFor(reason));
      // The first restart or expired token after a healthy spell is retried at once; after that, back off.
      retry(errorFor(reason), attempts === 0 && (reason === "restarting" || reason === "unauthorized"));
    };
  };

  void connect();

  return {
    send(command) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(command));
    },
    close() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      attempt?.abort();
      const ws = socket;
      socket = undefined;
      ws?.close(1000);
      status("closed");
    },
  };
};
