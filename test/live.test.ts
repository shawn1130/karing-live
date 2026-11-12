import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
import { createPlayer } from "../src/audio.ts";
import { addTranscriptLine, dropCaptions, EMPTY_TRANSCRIPT, listenToCall, watchLiveCalls, type LiveCall, type TranscriptLine } from "../src/index.ts";
import { TOKEN_TIMEOUT_MS } from "../src/socket.ts";
import { clock, contexts, FakeSocket, installFakes, scheduled, settle } from "./fakes.ts";

const CALL = "019a1b2c-3d4e-7f00-8a1b-2c3d4e5f6a7b";
const call = (n: number, startedAt = `2026-11-12T10:0${n}:00.000Z`): LiveCall => ({
  callId: `019a1b2c-3d4e-7f00-8a1b-00000000000${n}`,
  agentId: "a",
  agentName: "Front Desk",
  direction: "inbound",
  phoneNumber: "+12025550101",
  phoneNumberName: "Main",
  customerNumber: "+12025550142",
  startedAt,
});

/** A token source that hands out t1, t2, ... and counts its calls. */
const tokens = () => {
  let n = 0;
  const source = async () => ({ token: `t${++n}`, expiresAt: "" });
  return Object.assign(source, { count: () => n });
};

beforeEach(installFakes);

describe("watchLiveCalls", () => {
  it("applies a snapshot, upserts and removals, newest first", async () => {
    const lists: (readonly LiveCall[])[] = [];
    const board = watchLiveCalls({ token: tokens(), onChange: (c) => lists.push(c) });
    await settle();
    const s = FakeSocket.last;
    assert.equal(s.url, "wss://api.karing.ai/live-calls?token=t1");
    s.open();
    s.receive({ type: "snapshot", calls: [call(1), call(2)] });
    s.receive({ type: "call.upsert", call: { ...call(1), agentName: "Billing" } });
    s.receive({ type: "call.removed", callId: call(2).callId, reason: "ended" });
    s.receive({ type: "call.removed", callId: "never-shown", reason: "ended" });
    s.receive({ type: "something.new" });
    assert.deepEqual(
      lists.map((l) => l.map((c) => `${c.callId.slice(-1)}:${c.agentName}`)),
      [["2:Front Desk", "1:Front Desk"], ["2:Front Desk", "1:Billing"], ["1:Billing"]],
    );
    board.close();
  });

  it("replaces everything on a reconnect's snapshot, and reconnects straight away after a restart", async () => {
    const lists: (readonly LiveCall[])[] = [];
    const source = tokens();
    const board = watchLiveCalls({ token: source, onChange: (c) => lists.push(c) });
    await settle();
    FakeSocket.last.open();
    FakeSocket.last.receive({ type: "snapshot", calls: [call(1)] });
    FakeSocket.last.drop(1012);
    await settle();
    await settle();
    assert.equal(FakeSocket.last.token, "t2");
    FakeSocket.last.open();
    FakeSocket.last.receive({ type: "snapshot", calls: [] });
    assert.deepEqual(lists.at(-1), []);
    board.close();
  });

  it("stops for good when the org has no calls, and says why", async () => {
    const errors: string[] = [];
    const statuses: string[] = [];
    watchLiveCalls({ token: tokens(), onChange: () => {}, onError: (e) => errors.push(e.reason), onStatus: (s) => statuses.push(s) });
    await settle();
    FakeSocket.last.open();
    FakeSocket.last.drop(4404);
    await settle();
    assert.deepEqual(errors, ["not-live"]);
    assert.deepEqual(statuses, ["connecting", "open", "closed"]);
    assert.equal(FakeSocket.all.length, 1);
  });

  it("backs off with jitter on drops, up to 30 s, and keeps a fresh token for each attempt", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    mock.method(Math, "random", () => 1);
    const source = tokens();
    const board = watchLiveCalls({ token: source, onChange: () => {} });
    await settle();
    for (const wait of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
      FakeSocket.last.drop(1006);
      t.mock.timers.tick(wait - 1);
      await settle();
      const before = FakeSocket.all.length;
      t.mock.timers.tick(1);
      await settle();
      assert.equal(FakeSocket.all.length, before + 1, `retried after ${wait} ms`);
    }
    assert.equal(source.count(), 8);
    board.close();
    mock.restoreAll();
  });
});

describe("listenToCall", () => {
  it("refuses something that is not a call id", () => {
    assert.throws(() => listenToCall("../board", { token: tokens() }), { name: "LiveError", reason: "not-live" });
  });

  it("reports speakers and transcript lines, and asks for audio only when played", async () => {
    const speaking: string[] = [];
    const lines: string[] = [];
    const call = listenToCall(CALL, {
      token: tokens(),
      transcript: true,
      onSpeaking: (s) => speaking.push(`${s.caller}/${s.agent}`),
      onTranscript: (l) => lines.push(`${l.who}:${l.final}:${l.text}`),
    });
    await settle();
    const s = FakeSocket.last;
    assert.equal(s.url, `wss://api.karing.ai/live-calls/${CALL}/listen?token=t1`);
    s.open();
    assert.deepEqual(s.sent, [{ type: "transcript", on: true }]);
    s.receive({ type: "start", encoding: "mulaw", sampleRate: 8000, channels: 1 });
    s.receive({ type: "speech", who: "caller", state: "start" });
    s.receive({ type: "transcript", who: "caller", text: "I need", final: false });
    s.receive({ type: "speech", who: "caller", state: "stop" });
    s.receive({ type: "transcript", who: "caller", text: "I need to reschedule.", final: true });
    assert.deepEqual(speaking, ["true/false", "false/false"]);
    assert.deepEqual(lines, ["caller:false:I need", "caller:true:I need to reschedule."]);

    call.playAudio();
    assert.deepEqual(s.sent.at(-1), { type: "audio", on: true });
    s.receive(new Uint8Array(800).fill(0xff).buffer);
    assert.equal(scheduled.length, 1);
    call.stopAudio();
    assert.deepEqual(s.sent.at(-1), { type: "audio", on: false });
    call.close();
  });

  it("asks again for what it wants after a reconnect, and forgets who was speaking", async () => {
    const speaking: string[] = [];
    const call = listenToCall(CALL, { token: tokens(), onSpeaking: (s) => speaking.push(`${s.caller}/${s.agent}`) });
    await settle();
    FakeSocket.last.open();
    call.playAudio();
    call.setTranscript(true);
    FakeSocket.last.receive({ type: "speech", who: "agent", state: "start" });
    FakeSocket.last.drop(1012);
    await settle();
    await settle();
    FakeSocket.last.open();
    assert.deepEqual(FakeSocket.last.sent, [
      { type: "audio", on: true },
      { type: "transcript", on: true },
    ]);
    assert.deepEqual(speaking, ["false/true", "false/false"]);
    call.close();
  });

  it("ends without an error when the call ends, and with one when it is not live", async () => {
    const ends: (string | null)[] = [];
    listenToCall(CALL, { token: tokens(), onEnd: (e) => ends.push(e?.reason ?? null) });
    await settle();
    FakeSocket.last.open();
    FakeSocket.last.drop(1000);
    listenToCall(CALL, { token: tokens(), onEnd: (e) => ends.push(e?.reason ?? null) });
    await settle();
    FakeSocket.last.drop(4404);
    assert.deepEqual(ends, [null, "not-live"]);
  });
});

describe("connection failures", () => {
  it("stops with an error when a socket cannot even be created", async () => {
    const errors: string[] = [];
    FakeSocket.failNext = true;
    watchLiveCalls({ token: tokens(), onChange: () => {}, onError: (e) => errors.push(e.reason) });
    await settle();
    await settle();
    assert.deepEqual(errors, ["unsupported"]);
  });

  it("gives up on a token that never comes, and tries again with a fresh one", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    mock.method(Math, "random", () => 1);
    let asked = 0;
    const board = watchLiveCalls({ token: () => (asked++ ? Promise.resolve("t2") : new Promise(() => {})), onChange: () => {} });
    await settle();
    t.mock.timers.tick(TOKEN_TIMEOUT_MS);
    await settle();
    t.mock.timers.tick(1000); // the first backoff
    await settle();
    await settle();
    assert.equal(asked, 2);
    assert.equal(FakeSocket.last.token, "t2");
    board.close();
    mock.restoreAll();
  });

  it("retries a restart at once only the first time, then backs off", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    mock.method(Math, "random", () => 1);
    const board = watchLiveCalls({ token: tokens(), onChange: () => {} });
    await settle();
    FakeSocket.last.drop(1012);
    await settle();
    assert.equal(FakeSocket.all.length, 2, "the first restart reconnects at once");
    FakeSocket.last.drop(1012);
    await settle();
    assert.equal(FakeSocket.all.length, 2, "the second waits");
    t.mock.timers.tick(2000);
    await settle();
    assert.equal(FakeSocket.all.length, 3);
    board.close();
    mock.restoreAll();
  });

  it("aborts the request to the token route when it takes too long", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const signals: AbortSignal[] = [];
    mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return new Promise(() => {});
    });
    const board = watchLiveCalls({ token: "/api/karing/token", onChange: () => {} });
    await settle();
    assert.equal(signals[0]!.aborted, false);
    t.mock.timers.tick(TOKEN_TIMEOUT_MS);
    assert.equal(signals[0]!.aborted, true);
    board.close();
    mock.restoreAll();
  });

  it("refuses a call with any malformed field, keeping the rest of the board", async () => {
    const lists: (readonly LiveCall[])[] = [];
    const board = watchLiveCalls({ token: tokens(), onChange: (c) => lists.push(c) });
    await settle();
    FakeSocket.last.receive({
      type: "snapshot",
      calls: [{ ...call(1), startedAt: 42 }, { ...call(2), direction: "sideways" }, { ...call(3), agentName: {} }, call(4)],
    });
    assert.deepEqual(lists.at(-1)!.map((c) => c.callId), [call(4).callId]);
    board.close();
  });

  it("ignores malformed messages instead of throwing", async () => {
    const lists: (readonly LiveCall[])[] = [];
    const board = watchLiveCalls({ token: tokens(), onChange: (c) => lists.push(c) });
    await settle();
    for (const bad of ["null", "42", '{"type":"snapshot"}', '{"type":"snapshot","calls":[null,{"callId":5}]}', '{"type":"call.upsert"}']) {
      FakeSocket.last.receive(bad);
    }
    assert.deepEqual(lists, [[]], "only the snapshot with no valid calls changed anything");
    board.close();
  });
});

describe("a closed or finished call", () => {
  it("never starts an audio device again", async () => {
    const call = listenToCall(CALL, { token: tokens() });
    await settle();
    call.close();
    assert.equal(call.playAudio(), false);
    const ended = listenToCall(CALL, { token: tokens() });
    await settle();
    FakeSocket.last.drop(4404);
    assert.equal(ended.playAudio(), false);
    assert.equal(contexts.length, 0);
  });

  it("never replays audio queued before the device paused", async () => {
    const call = listenToCall(CALL, { token: tokens() });
    await settle();
    FakeSocket.last.open();
    call.playAudio();
    FakeSocket.last.receive(new Uint8Array(800).buffer);
    assert.equal(scheduled[0]!.stopped, false);
    contexts[0]!.suspend();
    assert.equal(scheduled[0]!.stopped, true, "stopped as the device paused, with no packet after");
    call.playAudio();
    assert.equal(contexts[0]!.state, "running");
    assert.equal(scheduled.filter((s) => !s.stopped).length, 0);
    call.close();
  });

  it("drops a transcript line already on its way when the transcript was switched off", async () => {
    const lines: string[] = [];
    const call = listenToCall(CALL, { token: tokens(), transcript: true, onTranscript: (l) => lines.push(l.text) });
    await settle();
    FakeSocket.last.open();
    call.setTranscript(false);
    FakeSocket.last.receive({ type: "transcript", who: "agent", text: "late", final: false });
    assert.deepEqual(lines, []);
    call.close();
  });

  it("resumes a paused device from the next click instead of making another", async () => {
    const call = listenToCall(CALL, { token: tokens() });
    await settle();
    FakeSocket.last.open();
    call.playAudio();
    contexts[0]!.state = "suspended";
    FakeSocket.last.receive(new Uint8Array(800).buffer);
    assert.equal(scheduled.length, 0, "nothing is queued while the device is paused");
    call.playAudio();
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0]!.state, "running");
    call.close();
  });
});

describe("transcript", () => {
  const line = (who: "caller" | "agent", text: string, final = false): TranscriptLine => ({ who, text, final });

  it("keeps each caption in its place and settles it there", () => {
    let t = EMPTY_TRANSCRIPT;
    for (const l of [
      line("caller", "I need"),
      line("agent", "One"),
      line("caller", "I need to move it"),
      line("caller", "I need to move it.", true),
      line("agent", "One moment.", true),
      line("caller", "Thanks"),
    ]) {
      t = addTranscriptLine(t, l);
    }
    assert.deepEqual(
      t.lines.map((l) => `${l.who}:${l.final}:${l.text}`),
      ["caller:true:I need to move it.", "agent:true:One moment.", "caller:false:Thanks"],
    );
  });

  it("drops unfinished captions after a gap, and keeps the last 500 lines", () => {
    let t = addTranscriptLine(addTranscriptLine(EMPTY_TRANSCRIPT, line("caller", "Hi", true)), line("agent", "Hel"));
    t = dropCaptions(t);
    assert.deepEqual(t.lines, [line("caller", "Hi", true)]);
    t = addTranscriptLine(t, line("agent", "typing"));
    for (let i = 0; i < 3; i++) t = addTranscriptLine(t, line("caller", `l${i}`, true), 3);
    assert.deepEqual(t.lines.map((l) => l.text), ["l0", "l1", "l2"]);
    assert.deepEqual(t.captions, {}, "a caption pushed out of the window is forgotten");
  });

  it("keeps whole line positions whatever limit it is given", () => {
    let t = EMPTY_TRANSCRIPT;
    for (const l of [line("caller", "a", true), line("agent", "b"), line("caller", "c")]) t = addTranscriptLine(t, l, 1.5);
    assert.deepEqual(t.lines.map((l) => l.text), ["c"]);
    assert.ok(Object.values(t.captions).every(Number.isInteger));
    for (const max of [Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(addTranscriptLine(EMPTY_TRANSCRIPT, line("caller", "x", true), max).lines.length, 1, String(max));
    }
  });
});

describe("audio player", () => {
  it("never plays two chunks at once, even after a stall and a burst", () => {
    const player = createPlayer();
    const chunk = () => player.push(new Uint8Array(800).buffer);
    for (let i = 0; i < 50; i++) {
      chunk();
      clock.now += 0.1;
    }
    clock.now += 1.5; // a stall...
    for (let i = 0; i < 15; i++) chunk(); // ...then 1.5 s at once
    for (let i = 0; i < 20; i++) {
      chunk();
      clock.now += 0.1;
    }
    const audible = scheduled.filter((s) => !s.stopped).sort((a, b) => a.at - b.at);
    for (let i = 1; i < audible.length; i++) {
      assert.ok(audible[i]!.at >= audible[i - 1]!.at + audible[i - 1]!.duration - 1e-9, `overlap at ${audible[i]!.at}`);
    }
    const queued = scheduled.at(-1)!.at + 0.1 - clock.now;
    assert.ok(queued <= 1.1, `latency ${queued}`);
    player.close();
  });
});
