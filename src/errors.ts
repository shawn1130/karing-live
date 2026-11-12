import type { CloseReason } from "./protocol.ts";

/** What went wrong, in a form your code can branch on. */
export type LiveErrorReason = CloseReason | "token" | "unsupported";

/**
 * Every error this package reports. `reason` says what happened; `message`
 * says what to do about it.
 *
 * @example
 * if (error.reason === "not-live") showEnded();
 */
export class LiveError extends Error {
  override readonly name = "LiveError";
  readonly reason: LiveErrorReason;

  constructor(reason: LiveErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}
