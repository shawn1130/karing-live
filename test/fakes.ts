/**
 * Stand-ins for the browser APIs the package uses: a WebSocket the tests
 * drive by hand, and an AudioContext that records what would play.
 */

export class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];

  url: string;
  readyState = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;

  static failNext = false;
  constructor(url: string) {
    if (FakeSocket.failNext) {
      FakeSocket.failNext = false;
      throw new SyntaxError("The URL is invalid.");
    }
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  // Test controls.
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" || data instanceof ArrayBuffer ? data : JSON.stringify(data) });
  }
  drop(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  get token() {
    return new URL(this.url).searchParams.get("token");
  }
  static get last(): FakeSocket {
    return FakeSocket.all.at(-1)!;
  }
}

/** Sources scheduled on the fake audio clock: start time, length, and whether stopped. */
export const scheduled: { at: number; duration: number; stopped: boolean; end: () => void }[] = [];
export const clock = { now: 0 };
/** Every audio context made, newest last. */
export const contexts: FakeAudioContext[] = [];

export class FakeAudioContext {
  destination = {};
  state: "running" | "suspended" | "closed" = "running";
  onstatechange: (() => void) | null = null;
  /** Test control: what the browser does when the device pauses. */
  suspend() {
    this.state = "suspended";
    this.onstatechange?.();
  }
  constructor(options: { sampleRate: number }) {
    if (options.sampleRate !== 8000) throw new Error("expected 8 kHz");
    contexts.push(this);
  }
  resume() {
    if (this.state === "suspended") this.state = "running";
    return Promise.resolve();
  }
  get currentTime() {
    return clock.now;
  }
  createBuffer(_channels: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => data };
  }
  createBufferSource() {
    const entry = { at: 0, duration: 0, stopped: false, end: () => source.onended?.() };
    const source = {
      buffer: { duration: 0 },
      onended: null as null | (() => void),
      connect() {},
      start(at: number) {
        entry.at = at;
        entry.duration = source.buffer.duration;
        scheduled.push(entry);
      },
      stop() {
        entry.stopped = true;
      },
    };
    return source;
  }
  close() {
    this.state = "closed";
    return Promise.resolve();
  }
}

export const installFakes = () => {
  FakeSocket.all = [];
  scheduled.length = 0;
  contexts.length = 0;
  clock.now = 0;
  Object.assign(globalThis, { WebSocket: FakeSocket, AudioContext: FakeAudioContext });
};

/** Lets pending promises (token fetches) settle. Not a timer: some tests fake those. */
export const settle = (): Promise<void> => new Promise((r) => setImmediate(r));
