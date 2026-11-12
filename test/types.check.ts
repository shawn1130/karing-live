// Compiled by `npm run typecheck`, never run: it fails the build if the public
// types stop guiding the way they should.
import type { BoardEvent, ListenEvent, LiveCall, TokenSource } from "../src/index.ts";
import { createTokenHandler } from "../src/server.ts";

declare const board: BoardEvent;
if (board.type === "call.removed") {
  const reason: "ended" | "stale" = board.reason;
  void reason;
  // @ts-expect-error: an outcome may be missing
  const outcome: string = board.outcome;
  void outcome;
  // @ts-expect-error: a removal carries only the id
  void board.call;
}

declare const event: ListenEvent;
if (event.type === "speech") {
  const who: "caller" | "agent" = event.who;
  void who;
}

declare const call: LiveCall;
// @ts-expect-error: fields that may be missing are typed so
const number: string = call.customerNumber;
void number;

// @ts-expect-error: a token source is a URL or a function
const bad: TokenSource = 42;
void bad;

// @ts-expect-error: authorize is required
createTokenHandler({ apiKey: "k" });
