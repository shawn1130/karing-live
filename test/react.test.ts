// React lifecycle: real components rendered with react-dom into a test DOM.
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// The DOM first, then React, which looks for it as it loads.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement: h } = await import("react");
const { createRoot } = await import("react-dom/client");
const { KaringLiveProvider, useCall, useLiveCalls } = await import("../src/react.ts");
const { contexts, FakeSocket, installFakes, settle } = await import("./fakes.ts");

const CALL_1 = "019a1b2c-3d4e-7f00-8a1b-000000000001";
const CALL_2 = "019a1b2c-3d4e-7f00-8a1b-000000000002";
const call = (callId: string) => ({ callId, agentId: null, agentName: "Front Desk", direction: "inbound", phoneNumber: null, phoneNumberName: null, customerNumber: "+12025550142", startedAt: null });

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

describe("KaringLiveProvider scope", () => {
  it("closes the old organization's board and never shows its calls under a new scope", async () => {
    const seen: { scope: string; calls: string[] }[] = [];
    const Board = ({ scope }: { scope: string }) => {
      const { calls } = useLiveCalls();
      seen.push({ scope, calls: calls.map((c) => c.callId) });
      return null;
    };
    const app = (scope: string, token: string) =>
      h(KaringLiveProvider, { scope, token: async () => token }, h(Board, { scope }));

    const view = await mount(app("user-1:org-a", "a"));
    await flush();
    const first = FakeSocket.last;
    assert.equal(first.token, "a");
    await inAct(() => {
      first.open();
      first.receive({ type: "snapshot", calls: [call(CALL_1)] });
    });
    assert.deepEqual(seen.at(-1), { scope: "user-1:org-a", calls: [CALL_1] });

    await view.rerender(app("user-2:org-b", "b"));
    await flush();
    assert.equal(first.readyState, 3, "the first organization's socket is closed");
    assert.equal(FakeSocket.last.token, "b");
    for (const render of seen.filter((r) => r.scope === "user-2:org-b")) {
      assert.deepEqual(render.calls, [], "not one render under the new scope shows the old calls");
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
      const view = await mount(h(KaringLiveProvider, { scope: "u:o", token: "/api/karing/token" }, h(Board)));
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
    const app = () => h(KaringLiveProvider, { scope: "u:o", token: async () => "t" }, h(Board));
    const view = await mount(app());
    await flush();
    await view.rerender(app());
    await view.rerender(app());
    await flush();
    assert.equal(FakeSocket.all.length, 1);
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
    const app = (callId: string) => h(KaringLiveProvider, { scope: "u:o", token: async () => "t" }, h(Panel, { callId }));

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
    const view = await mount(h(KaringLiveProvider, { scope: "u:o", token: async () => "t" }, h(Panel)));
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
    const app = (on: boolean) => h(KaringLiveProvider, { scope: "u:o", token: async () => "t" }, h(Panel, { on }));
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
