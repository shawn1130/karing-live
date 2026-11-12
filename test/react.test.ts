// React lifecycle: real components rendered with react-dom into a test DOM.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The DOM first, then React, which looks for it as it loads.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement: h, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { KaringLiveProvider, useCall, useLiveCalls } = await import("../src/react.ts");
const { contexts, FakeSocket, installFakes, settle } = await import("./fakes.ts");

const CALL_1 = "019a1b2c-3d4e-7f00-8a1b-000000000001";
const CALL_2 = "019a1b2c-3d4e-7f00-8a1b-000000000002";
const call = (callId: string) => ({ callId, agentId: null, agentName: "Front Desk", direction: "inbound", phoneNumber: null, phoneNumberName: null, customerNumber: "+12025550142", startedAt: null, sentiment: null, topic: null, tools: [] });

/** Renders into a fresh root; returns a rerender and an unmount. */
const mount = async (element: ReturnType<typeof h>) => {
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(element));
  return {
    rerender: (next: ReturnType<typeof h>) => act(async () => root.render(next)),
    unmount: () => act(async () => root.unmount()),
  };
};
const flush = () => act(async () => settle());
const inAct = (fn: () => void) => act(async () => fn());

beforeEach(installFakes);

describe("KaringLiveProvider userId", () => {
  it("closes the old person's board and never shows its calls under a new userId", async () => {
    const seen: { userId: string; calls: string[] }[] = [];
    const Board = ({ userId }: { userId: string }) => {
      const { calls } = useLiveCalls();
      seen.push({ userId, calls: calls.map((c) => c.callId) });
      return null;
    };
    const app = (userId: string, token: string) =>
      h(KaringLiveProvider, { userId, token: async () => token }, h(Board, { userId }));

    const view = await mount(app("user-1:org-a", "a"));
    await flush();
    const first = FakeSocket.last;
    assert.equal(first.token, "a");
    await inAct(() => {
      first.open();
      first.receive({ type: "snapshot", calls: [call(CALL_1)] });
    });
    assert.deepEqual(seen.at(-1), { userId: "user-1:org-a", calls: [CALL_1] });

    await view.rerender(app("user-2:org-b", "b"));
    await flush();
    assert.equal(first.readyState, 3, "the first organization's socket is closed");
    assert.equal(FakeSocket.last.token, "b");
    for (const render of seen.filter((r) => r.userId === "user-2:org-b")) {
      assert.deepEqual(render.calls, [], "not one render under the new userId shows the old calls");
    }
    await view.unmount();
  });

  it("aborts its token request when it unmounts", async () => {
    const signals: AbortSignal[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return new Promise(() => {});
    }) as typeof fetch;
    try {
      const Board = () => (useLiveCalls(), null);
      const view = await mount(h(KaringLiveProvider, { userId: "u:o", token: "/api/karing/token" }, h(Board)));
      await flush();
      assert.equal(signals.length, 1);
      assert.equal(signals[0]!.aborted, false);
      await view.unmount();
      assert.equal(signals[0]!.aborted, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not reconnect when an inline token function changes", async () => {
    const Board = () => (useLiveCalls(), null);
    const app = () => h(KaringLiveProvider, { userId: "u:o", token: async () => "t" }, h(Board));
    const view = await mount(app());
    await flush();
    await view.rerender(app());
    await view.rerender(app());
    await flush();
    assert.equal(FakeSocket.all.length, 1);
    await view.unmount();
  });

  it("calls the latest onEnded with how a call ended, without reconnecting when it changes", async () => {
    const ended: string[] = [];
    const Board = ({ tag }: { tag: string }) => (useLiveCalls({ onEnded: (c, outcome) => ended.push(`${tag}:${c.callId.slice(-1)}:${outcome}`) }), null);
    const app = (tag: string) => h(KaringLiveProvider, { userId: "u:o", token: async () => "t" }, h(Board, { tag }));
    const view = await mount(app("first"));
    await flush();
    const s = FakeSocket.last;
    await inAct(() => {
      s.open();
      s.receive({ type: "snapshot", calls: [call(CALL_1), call(CALL_2)] });
      s.receive({ type: "call.removed", callId: CALL_1, reason: "ended", outcome: "caller_hung_up" });
    });
    await view.rerender(app("second"));
    await inAct(() => s.receive({ type: "call.removed", callId: CALL_2, reason: "ended", outcome: "transferred" }));
    assert.deepEqual(ended, ["first:1:caller_hung_up", "second:2:transferred"]);
    assert.equal(FakeSocket.all.length, 1);
    await view.unmount();
  });
});

describe("a new userId", () => {
  it("closes the call, stops its audio, clears it and resets the app's own state, then asks for a new token", async () => {
    let state: ReturnType<typeof useCall> | undefined;
    const tokens: string[] = [];
    const Panel = () => {
      const [picked] = useState(() => CALL_1); // the app's own state: the call this person picked
      state = useCall(picked, { transcript: true });
      return null;
    };
    const app = (userId: string) =>
      h(KaringLiveProvider, { userId, token: async () => (tokens.push(userId), `t-${userId}`) }, h(Panel));

    const view = await mount(app("alex"));
    await flush();
    const alexSocket = FakeSocket.last;
    await inAct(() => {
      alexSocket.open();
      alexSocket.receive({ type: "transcript", who: "caller", text: "my date of birth is", final: true });
      state!.playAudio();
    });
    assert.equal(state!.audio, true);
    assert.equal(state!.transcript.length, 1);

    await view.rerender(app("sam"));
    assert.equal(alexSocket.readyState, FakeSocket.CLOSED, "Alex's connection is closed");
    assert.equal(contexts[0]!.state, "closed", "Alex's audio device is released");
    assert.deepEqual({ audio: state!.audio, lines: state!.transcript.length }, { audio: false, lines: 0 });
    await flush();
    assert.deepEqual(tokens, ["alex", "sam"], "a new token is asked for, for Sam");
    assert.notEqual(FakeSocket.last, alexSocket);
    assert.equal(FakeSocket.last.token, "t-sam");
    await view.unmount();
  });

  it("remounts everything inside the provider, so state the app kept does not carry over", async () => {
    const mounts: string[] = [];
    const Child = ({ label }: { label: string }) => {
      useState(() => mounts.push(label));
      return null;
    };
    const app = (userId: string) => h(KaringLiveProvider, { userId, token: async () => "t" }, h(Child, { label: userId }));
    const view = await mount(app("alex"));
    await view.rerender(app("alex")); // same person: nothing remounts
    await view.rerender(app("sam"));
    assert.deepEqual(mounts, ["alex", "sam"]);
    await view.unmount();
  });
});

describe("useCall", () => {
  it("never shows the previous call's transcript after switching calls", async () => {
    const seen: { callId: string; lines: number; status: string }[] = [];
    const Panel = ({ callId }: { callId: string }) => {
      const c = useCall(callId, { transcript: true });
      seen.push({ callId, lines: c.transcript.length, status: c.status });
      return null;
    };
    const app = (callId: string) => h(KaringLiveProvider, { userId: "u:o", token: async () => "t" }, h(Panel, { callId }));

    const view = await mount(app(CALL_1));
    await flush();
    await inAct(() => {
      FakeSocket.last.open();
      FakeSocket.last.receive({ type: "transcript", who: "caller", text: "my date of birth is", final: true });
    });
    assert.equal(seen.at(-1)!.lines, 1);

    await view.rerender(app(CALL_2));
    const firstForCall2 = seen.find((r) => r.callId === CALL_2)!;
    assert.deepEqual(firstForCall2, { callId: CALL_2, lines: 0, status: "connecting" });
    await view.unmount();
  });

  it("will not start audio for a call that is over", async () => {
    let state: ReturnType<typeof useCall> | undefined;
    const Panel = () => ((state = useCall(CALL_1)), null);
    const view = await mount(h(KaringLiveProvider, { userId: "u:o", token: async () => "t" }, h(Panel)));
    await flush();
    await inAct(() => FakeSocket.last.drop(4404));
    assert.equal(state!.error?.reason, "not-live");
    await inAct(() => state!.playAudio());
    assert.equal(state!.audio, false);
    assert.equal(contexts.length, 0, "no audio device was opened");
    await view.unmount();
  });

  it("drops an unfinished caption when the transcript is switched off", async () => {
    let state: ReturnType<typeof useCall> | undefined;
    const Panel = ({ on }: { on: boolean }) => ((state = useCall(CALL_1, { transcript: on })), null);
    const app = (on: boolean) => h(KaringLiveProvider, { userId: "u:o", token: async () => "t" }, h(Panel, { on }));
    const view = await mount(app(true));
    await flush();
    await inAct(() => {
      FakeSocket.last.open();
      FakeSocket.last.receive({ type: "transcript", who: "agent", text: "Let me ch", final: false });
    });
    assert.equal(state!.transcript.length, 1);
    await view.rerender(app(false));
    assert.equal(state!.transcript.length, 0);
    assert.deepEqual(FakeSocket.last.sent.at(-1), { type: "transcript", on: false });
    // A line that was already on its way when it was switched off.
    await inAct(() => FakeSocket.last.receive({ type: "transcript", who: "agent", text: "Let me check", final: false }));
    await view.rerender(app(true));
    assert.equal(state!.transcript.length, 0, "the old caption does not come back");
    await view.unmount();
  });
});
