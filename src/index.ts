/**
 * Live calls in your web app, without React: the live call board
 * ({@link watchLiveCalls}) and one call's audio, speakers and transcript
 * ({@link listenToCall}). For React, import `@karing-ai/live/react`; for your
 * token route, `@karing-ai/live/server`.
 *
 * @module
 */
export { LiveError, type LiveErrorReason } from "./errors.ts";
export { listenToCall, type CallListener, type CallListenerOptions, type Speaking } from "./listen.ts";
export { watchLiveCalls, type LiveCallsOptions } from "./live-calls.ts";
export {
  CLOSE_CODES,
  closeReason,
  type BoardEvent,
  type CallEnd,
  type CloseNotice,
  type CloseReason,
  type ListenCommand,
  type ListenEvent,
  type LiveCall,
  type LiveToken,
  type Outcome,
  type Speaker,
  type TokenSource,
  type ToolCall,
  type TranscriptLine,
} from "./protocol.ts";
export type { ConnectionStatus } from "./socket.ts";
export {
  addTranscriptLine,
  dropCaptions,
  EMPTY_TRANSCRIPT,
  MAX_TRANSCRIPT_LINES,
  type Transcript,
} from "./transcript.ts";
