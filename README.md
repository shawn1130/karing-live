# @karing-ai/live

Live calls in your web app: a live call board, call audio, and live transcripts, from Karing. Strictly typed, with no runtime dependencies.

```tsx
const { calls } = useLiveCalls();
const call = useCall(callId, { transcript: true });
<button onClick={call.playAudio}>Listen</button>
```

- **Live board.** Your organization's calls appear as they start and disappear as they end.
- **Call audio.** Listen to any live call in the browser, at phone quality, with about a quarter second of delay.
- **Live transcript.** Each side's words as they are spoken, with captions that settle into final lines.
- **Who is speaking.** Know when the caller or the AI agent is talking, and when the caller interrupts.

## Contents

1. [How it works](#how-it-works)
2. [Install](#install)
3. [Quick start](#quick-start)
4. [The live board](#the-live-board)
5. [Listening to a call](#listening-to-a-call)
6. [Live transcripts](#live-transcripts)
7. [Without React](#without-react)
8. [Your token route](#your-token-route)
9. [Connections, errors and retries](#connections-errors-and-retries)
10. [Privacy and security](#privacy-and-security)
11. [Bandwidth](#bandwidth)
12. [API reference](#api-reference)
13. [Releases](#releases)

## How it works

Your Karing API key stays on your server. The browser never sees it.

1. **Your server** has one route that checks the user is signed in and allowed to see live calls, then exchanges your API key for a short-lived token. `createTokenHandler()` is that route, ready-made.
2. **Your web app** uses the React hooks (or the plain TypeScript functions). They fetch a token from your route whenever they connect, then talk to Karing directly.
3. **Karing** sends your organization's live calls, and the audio and transcript of the call you open.

A token opens connections for one minute. A connection opened in time stays open: a call's until the call ends (after four hours it reconnects), the board's for an hour before it reconnects. The package gets a fresh token on its own whenever it reconnects.

## Install

```sh
npm install @karing-ai/live
```

React 18 or later is needed for the hooks; the rest has no dependencies. Node.js 20 or later for the server helper.

## Quick start

### 1. Add a token route on your server

Keep your Karing API key in a server environment variable, for example `KARING_API_KEY`.

```ts
// app/api/karing/token/route.ts (Next.js App Router)
import { createTokenHandler } from "@karing-ai/live/server";
import { getSession } from "@/lib/auth"; // your own auth

export const POST = createTokenHandler({
  apiKey: process.env.KARING_API_KEY!,
  // Your API key is for one organization, and a token opens every live call
  // in it. Allow only signed-in users of THAT organization who may see and
  // hear them, judged from your own server-side session.
  authorize: async (request) => {
    const session = await getSession(request);
    const orgId = process.env.KARING_ORG_ID;
    if (!session || !orgId) return false;
    return session.organizationId === orgId && session.user.canViewLiveCalls === true;
  },
});
```

`createTokenHandler` takes a standard `Request` and returns a `Response`, so it works as is in Bun, Deno and Cloudflare Workers. Remix and Hono need one line to hand it the request: `export const action = ({ request }) => handler(request)` in Remix, `app.post("/api/karing/token", (c) => handler(c.req.raw))` in Hono. For Express and other frameworks, see [Your token route](#your-token-route).

### 2. Wrap your app

`scope` says who is signed in and for which organization. When it changes (sign-out, another user, an organization switch), every live connection closes and nothing from before is shown again.

```tsx
"use client";
import type { ReactNode } from "react";
import { KaringLiveProvider } from "@karing-ai/live/react";

export function LiveCallsProvider({ userId, orgId, children }: { userId: string; orgId: string; children: ReactNode }) {
  return (
    <KaringLiveProvider token="/api/karing/token" scope={`${userId}:${orgId}`}>
      {children}
    </KaringLiveProvider>
  );
}
```

When a user signs out, unmount the provider or change its `scope`.

### 3. Show the board and listen

```tsx
"use client";
import { useState } from "react";
import { useCall, useLiveCalls } from "@karing-ai/live/react";

export function LiveBoard() {
  const { calls, status } = useLiveCalls();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <>
      {status === "reconnecting" && <p>Reconnecting…</p>}
      <ul>
        {calls.map((call) => (
          <li key={call.callId} onClick={() => setOpen(call.callId)}>
            {call.agentName} · {call.customerNumber ?? "Unknown caller"}
          </li>
        ))}
      </ul>
      {open && <CallPanel callId={open} />}
    </>
  );
}

function CallPanel({ callId }: { callId: string }) {
  const call = useCall(callId, { transcript: true });

  if (call.ended) return <p>The call has ended.</p>;
  if (call.error) return <p>{call.error.message}</p>;
  return (
    <section>
      <button onClick={call.audio ? call.stopAudio : call.playAudio}>
        {call.audio ? "Stop listening" : "Listen"}
      </button>
      <p>
        Caller {call.speaking.caller ? "is speaking" : "is quiet"}, agent{" "}
        {call.speaking.agent ? "is speaking" : "is quiet"}
      </p>
      {call.transcript.map((line, i) => (
        <p key={i} style={{ opacity: line.final ? 1 : 0.6 }}>
          <b>{line.who === "caller" ? "Caller" : "Agent"}:</b> {line.text}
        </p>
      ))}
    </section>
  );
}
```

That is the whole integration. The package's React entry is marked `"use client"`, so it works from Next.js App Router client components as written.

## The live board

`useLiveCalls()` returns your organization's calls in progress, newest first, and keeps them current.

```ts
const { calls, status, error } = useLiveCalls();
```

Each call is a `LiveCall`:

| Field | Type | Meaning |
| --- | --- | --- |
| `callId` | `string` | The call leg's id, the same id Karing's call logs show. |
| `agentId` | `string \| null` | The AI agent on the call. |
| `agentName` | `string \| null` | The AI agent's display name. |
| `direction` | `"inbound" \| "outbound" \| "web" \| null` | Which way the call goes. |
| `phoneNumber` | `string \| null` | Your line on the call, in E.164 form (`+15551234567`). `null` on internal transfer lines and web calls. |
| `phoneNumberName` | `string \| null` | The name of that line, including internal transfer lines. |
| `customerNumber` | `string \| null` | The caller's number in E.164 form. `null` when withheld or on a web call. |
| `startedAt` | `string \| null` | When the call started (ISO 8601). |

Good to know:

- **Every call leg is its own call.** When one AI agent hands a caller to another, the first leg leaves the board and a new one appears, with a new `callId`.
- **The board shows what is live now.** After a reconnect the list is rebuilt from scratch, so it can never drift. A call that started and ended while the browser was offline never appears.
- **Calls are shown for at most two hours.** A call still marked live after two hours is taken off the board. That is a display rule; it does not prove the call ended.

## Listening to a call

`useCall(callId)` connects to one live call. Pass `null` to connect to nothing.

```ts
const call = useCall(callId);
call.playAudio(); // from a click
call.stopAudio();
call.speaking; // { caller: boolean, agent: boolean }
call.ended; // true once the call is over
```

- **Start audio from a click.** Browsers only allow sound after the user clicks or presses a key, so call `playAudio()` from an event handler.
- **Audio flows only while it is on.** With the audio off, an open `useCall` still holds one connection and receives small speaking events, but no audio.
- **If the audio pauses** (for example, a phone call takes over the device), `call.playAudio()` from another click resumes it.
- **iPhone.** While audio plays, the package asks Safari to play it as media, so the ring/silent switch does not mute it (iOS 17 and later). The page's own setting comes back when the last call stops playing.
- **Phone quality.** Both sides are mixed into one channel at 8 kHz, which is everything heard on a phone call.

## Live transcripts

Turn on the transcript with `useCall(callId, { transcript: true })`. You can switch it on and off without reconnecting.

`call.transcript` is a list of `TranscriptLine` (`{ who, text, final }`), oldest first, in speaking order:

- A line with `final: false` is a live caption. It keeps its place and changes as the words come in, until it is settled with `final: true`. Style captions differently if you like, for example dimmed.
- The transcript covers what was said while connected: after a reconnect, words spoken during the gap are missing. Switching the transcript off drops any unfinished caption.
- It keeps the last 500 lines.

## Without React

The same features as plain TypeScript, for Vue, Svelte, Angular or no framework at all.

```ts
import { addTranscriptLine, dropCaptions, EMPTY_TRANSCRIPT, listenToCall, watchLiveCalls } from "@karing-ai/live";

const board = watchLiveCalls({
  token: "/api/karing/token",
  onChange: (calls) => renderBoard(calls),
  onStatus: (status) => renderStatus(status),
});

let transcript = EMPTY_TRANSCRIPT;
const call = listenToCall(callId, {
  token: "/api/karing/token",
  transcript: true,
  onSpeaking: ({ caller, agent }) => renderSpeakers(caller, agent),
  // addTranscriptLine keeps captions in place, as useCall does.
  onTranscript: (line) => renderTranscript((transcript = addTranscriptLine(transcript, line)).lines),
  // After a gap, an unfinished caption will never be settled: drop it, as useCall does.
  onStatus: (status) => {
    if (status !== "open") renderTranscript((transcript = dropCaptions(transcript)).lines);
  },
  onEnd: (error) => (error ? showError(error.message) : showEnded()),
});

listenButton.addEventListener("click", () => call.playAudio());

// When done:
call.close();
board.close();
```

## Your token route

The token route is the one piece of server code you add. It must do two things, and `createTokenHandler` does both:

1. **Check who is asking.** `authorize` receives the incoming `Request`. Return `true` only for a user signed in to your app, by your own server-side session, who belongs to the organization your API key is for and may see every one of its live calls, including callers' phone numbers, and hear them. Return `false` for everyone else, including users of other organizations in a shared app. This check is required: without it, anyone who can reach your route could listen in.
2. **Exchange your API key for a token,** and answer with `{ token, expiresAt }`.

Other frameworks can use `createLiveToken` directly:

```ts
// Express
import { createLiveToken } from "@karing-ai/live/server";

// requireOwnOrgStaff: your own middleware, applying the same rule as authorize above.
app.post("/api/karing/token", requireOwnOrgStaff, async (req, res) => {
  res.set("cache-control", "no-store");
  res.json(await createLiveToken({ apiKey: process.env.KARING_API_KEY! }));
});
```

A token source in the browser can also be a function, if your app fetches tokens its own way:

```tsx
<KaringLiveProvider scope={`${user.id}:${org.id}`} token={async () => (await api.post("/live-token")).data} />
```

A function is passed an `AbortSignal` that aborts when the package stops waiting (after 10 seconds, or when the connection closes); pass it on to your request if you can:

```tsx
<KaringLiveProvider
  scope={`${user.id}:${org.id}`}
  token={async (signal) => (await fetch("/api/live-token", { method: "POST", signal })).json()}
/>
```

## Connections, errors and retries

The package keeps connections open for you:

- It gets a fresh token for every connection, and gives up on one that takes more than 10 seconds.
- It reconnects straight away the first time Karing restarts a server, and otherwise after a growing, randomized delay of up to 30 seconds, so many browsers do not return at once.
- The board keeps trying for as long as it is open. A call gives up after a few failed attempts in a row.

`status` is one of `"connecting"`, `"open"`, `"reconnecting"` or `"closed"`.

When something stops for good, you get a `LiveError` with a `reason` you can branch on and a `message` that says what to do:

| `reason` | Meaning |
| --- | --- |
| `"not-live"` | The call is not live, or is not one of yours. On the board: your organization has no live calls set up. A call that ends while reconnecting ends normally instead. |
| `"unauthorized"` | Karing refused the token. Check your token route. |
| `"forbidden"` | The token is not for a single organization. |
| `"token"` | Your token route did not return a token (for example, the user is signed out). |
| `"unsupported"` | A connection could not be opened at all here, for example a wrong `baseUrl`. |
| `"busy"` | Too many connections right now. |
| `"failed"`, `"dropped"`, `"unknown"` | Connection problems that persisted through the retries. |

When a call simply ends, `useCall` sets `ended: true` and `listenToCall` calls `onEnd(null)`: that is not an error.

## Privacy and security

- **Your API key never leaves your server.** Keep it in server-only configuration (never a variable your bundler exposes to the browser, such as `NEXT_PUBLIC_…`), and import `@karing-ai/live/server` only from server code. If it is called in a browser by mistake it throws, as a reminder; that check cannot protect a key already shipped to a browser.
- **Do not allow cross-origin requests to your token route.** With CORS off, other sites' JavaScript cannot read the tokens it returns.
- **A token's minute limits new connections only.** A connection that is already open stays open until it ends: a board reconnects (with a new token) within the hour, and a call connection ends with the call or reconnects after four hours. Signing a user out in your app closes their connections in that browser (change `scope` or unmount the provider); it cannot reach a copy of a token used elsewhere.
- **Live calls are protected health information.** The board includes callers' phone numbers, and calls include audio and transcripts. Show them only to people who need them. Do not record the audio or store transcripts unless your agreements allow it.
- **Render transcripts as text.** React does this for you. Without React, set `textContent`, never `innerHTML`.
- **Tokens are credentials.** Do not log or store them.

## Bandwidth

Audio is sent only while it is on, at about 8 KB per second (about 29 MB per hour of listening). The board and the speaking indicators are small messages, sent as calls change and people speak.

## API reference

Every export has a description and examples in its type definitions, which your editor shows on hover.

### `@karing-ai/live/react`

| Export | What it is |
| --- | --- |
| `KaringLiveProvider` | Makes live calls available to the hooks below it. Props: `token` (your token route's URL, or a function) and `scope` (who is signed in, for which organization). |
| `useLiveCalls()` | `{ calls, status, error }`: your organization's live calls. |
| `useCall(callId, { transcript? })` | `{ status, speaking, transcript, audio, playAudio, stopAudio, ended, error }` for one call. |

Everything from `@karing-ai/live` is also exported here.

### `@karing-ai/live`

| Export | What it is |
| --- | --- |
| `watchLiveCalls(options)` | Keeps a list of live calls current. Returns `{ close }`. |
| `listenToCall(callId, options)` | Connects to one call. Returns `{ playAudio, stopAudio, setTranscript, close }`. |
| `addTranscriptLine`, `dropCaptions`, `EMPTY_TRANSCRIPT` | Keep a transcript in speaking order, captions in place, as `useCall` does. |
| `LiveError` | Every error this package reports, with `reason` and `message`. |
| `CLOSE_CODES`, `closeReason(code)` | Close codes and what they mean. |
| Types | `LiveCall`, `TranscriptLine`, `Transcript`, `Speaker`, `Speaking`, `ConnectionStatus`, `TokenSource`, `LiveToken`, `BoardEvent`, `ListenEvent`, `ListenCommand`, `CloseReason`, `LiveErrorReason`. |

### `@karing-ai/live/server`

| Export | What it is |
| --- | --- |
| `createTokenHandler({ apiKey, authorize })` | A ready-made token route: `(Request) => Promise<Response>`. |
| `createLiveToken({ apiKey })` | Exchanges your API key for a `{ token, expiresAt }`. |

### Protocol

The package wraps two WebSocket endpoints. You do not need them directly, but they are typed here as `BoardEvent`, `ListenEvent` and `ListenCommand` if you want to:

- `wss://api.karing.ai/live-calls?token=…`: the board. A `snapshot`, then `call.upsert` and `call.removed`.
- `wss://api.karing.ai/live-calls/{callId}/listen?token=…`: one call. Speaking events, transcript lines, and G.711 mu-law audio at 8 kHz, mono, in binary messages, once switched on.

Just before Karing closes either socket, it sends `{"type":"close","code":…,"reason":…}` (`CloseNotice`) with the same code as the close itself. Some networks deliver close codes as `1005`. If you use the sockets directly and the close event's code is `1005` or `1006`, use this message's code instead; otherwise the close event's code stands.

## Releases

What changed in each version is in the [changelog](https://github.com/shawn1130/karing-live/blob/main/CHANGELOG.md), which also ships in the package as `CHANGELOG.md`. Each version is also a [GitHub release](https://github.com/shawn1130/karing-live/releases). To hear about new ones, open the repository and choose **Watch → Custom → Releases**, or subscribe to the [releases feed](https://github.com/shawn1130/karing-live/releases.atom).

While the version starts with `0.`, a minor release (`0.x.0`) may change the API, and a patch release (`0.1.x`) never does.
