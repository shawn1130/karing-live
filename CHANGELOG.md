# Changelog

Every release of `@karing-ai/live`, newest first. Releases follow [semantic versioning](https://semver.org): while the version starts with `0.`, a minor release (`0.x.0`) may change the API, and a patch release (`0.1.x`) never does.

Follow new releases on GitHub: open [the repository](https://github.com/shawn1130/karing-live), choose **Watch → Custom → Releases**, or subscribe to the [releases feed](https://github.com/shawn1130/karing-live/releases.atom).

## 0.2.0

Breaking changes, in the React provider. While the version starts with `0.`, a minor release may change the API.

```bash
npm install @karing-ai/live@0.2.0
```

### Changed (breaking)

- **`scope` is now `userId`.** `KaringLiveProvider`'s required prop is renamed, because "scope" read like a permission, and it never was one. It is the id of the person signed in to your app, used only to start fresh when that person changes. It is not sent to Karing and grants nothing. To upgrade, rename the prop; the value can stay the same:

  ```diff
  - <KaringLiveProvider token="/api/karing/token" scope={user.id}>
  + <KaringLiveProvider token="/api/karing/token" userId={user.id}>
  ```

  TypeScript points to every place that needs the change.

- **Everything inside the provider starts fresh when `userId` changes.** The provider now remounts its children. Your own components' state resets too (a selected call, for example), not only what the hooks return. Keep any component whose state should survive a change of signed-in person outside the provider.

### Documentation

- **A new section, [The `userId` prop](https://github.com/shawn1130/karing-live#the-userid-prop).** It explains what the prop is for, what it is not, and how to choose its value.

## 0.1.1

A patch release. No code changes are needed to upgrade:

```bash
npm install @karing-ai/live@0.1.1
```

### Fixed

- **Hover documentation is back.** Every hook, function, option and type shows its description and examples in your editor again. 0.1.0 shipped its type files without them.
- **A call's last words are no longer cut off.** When a call ends, audio already on its way plays to the end instead of stopping mid-word. `close()`, `stopAudio()`, unmounting, and changing `scope` still stop it at once.
- **A call that ends while reconnecting ends normally.** `useCall()` sets `ended: true` and `listenToCall()` calls `onEnd(null)`, instead of reporting a `"not-live"` error.
- **Error messages say what actually happened.** When the package gives up on a connection, the `LiveError` message no longer says it is reconnecting or retrying.
- **Token functions always get their `signal`.** Its type is now `AbortSignal` rather than optional, so you can hand it straight to `fetch` with `exactOptionalPropertyTypes` on. Token functions written for 0.1.0 still work.
- **The package's name is right everywhere.** The error thrown when a `@karing-ai/live/server` function is called in browser code, and the hover documentation, said `@karing/live`, a name that does not exist on npm.

### On Karing's side

These apply to every version, 0.1.0 included:

- **A dropped audio stream reconnects.** If a call's stream drops while the call is still live, the connection now reconnects instead of reporting the call as ended. A stream that stops responding is noticed within a minute and reconnected the same way.
- **A call that cannot be opened for a moment is retried.** If a live call's stream is briefly unavailable, or a connection cannot be set up within 15 seconds, it now retries instead of reporting the call as not live or staying silent.
- **Long sentences reach the transcript.** A single very long utterance could be left out of the live transcript. It now comes through.

### Documentation

- **Remix and Hono:** the one line each needs to use `createTokenHandler()`.
- **Without React:** the example now drops unfinished captions after a reconnect, as `useCall()` does.
- **Connections:** a call's connection reconnects on its own after four hours, and the board's every hour.
- **Releases:** this changelog now ships in the package, and the README says how to follow new versions.

## 0.1.0

The first release.

- **Live board.** `useLiveCalls()` (React) or `watchLiveCalls()` keeps your organization's live calls current as they start and end.
- **Call audio.** `useCall()` or `listenToCall()` plays any live call in the browser, at phone quality, with about a quarter second of delay.
- **Live transcript.** Each side's words as they are spoken, with captions that settle into final lines.
- **Who is speaking.** Know when the caller or the AI agent is talking, and when the caller interrupts.
- **Your token route.** `createTokenHandler()` from `@karing-ai/live/server` keeps your Karing API key on your server and gives your browsers one-minute tokens.
- Strict TypeScript types and no runtime dependencies. React 18 or later is optional.
