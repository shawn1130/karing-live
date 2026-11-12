/**
 * Server side: swaps your Karing API key for short-lived tokens your
 * browsers can use. Your API key never leaves your server.
 *
 * @module
 */
import { LiveError } from "./errors.ts";
import { DEFAULT_BASE_URL, type LiveToken } from "./protocol.ts";

export type { LiveToken } from "./protocol.ts";
export { LiveError } from "./errors.ts";

// A safety net for accidental use only. What actually keeps the key safe is
// keeping it in server-only configuration and this module out of browser code.
const serverOnly = () => {
  if (typeof (globalThis as { document?: unknown }).document !== "undefined") {
    throw new LiveError("token", "@karing/live/server is for your server only. Keep it, and your API key, out of browser code.");
  }
};

const TIMEOUT_MS = 10_000;

/** Options for {@link createLiveToken}. */
export interface CreateLiveTokenOptions {
  /** Your Karing API key. Keep it in a server environment variable. */
  apiKey: string;
  /** Override only to point at a test environment. */
  baseUrl?: string;
}

/**
 * Gets a token for your organization's live calls. It opens connections for
 * one minute; a connection opened in time stays open.
 *
 * Use {@link createTokenHandler} for a ready-made route instead.
 *
 * @example
 * const { token } = await createLiveToken({ apiKey: process.env.KARING_API_KEY! });
 */
export const createLiveToken = async ({ apiKey, baseUrl = DEFAULT_BASE_URL }: CreateLiveTokenOptions): Promise<LiveToken> => {
  serverOnly();
  if (!apiKey) throw new LiveError("unauthorized", "No Karing API key was given. Set it in your server's environment.");
  let response: Response;
  try {
    response = await fetch(`${baseUrl.replace(/\/$/, "")}/live-calls/token`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new LiveError("failed", "Could not reach Karing for a token.");
  }
  if (response.status === 401) throw new LiveError("unauthorized", "Karing did not accept the API key. Check that it is current.");
  if (!response.ok) throw new LiveError("failed", `Karing answered ${response.status} when asked for a token.`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const { token, expires_at } = (body && typeof body === "object" ? body : {}) as { token?: unknown; expires_at?: unknown };
  if (typeof token !== "string" || typeof expires_at !== "string") {
    throw new LiveError("failed", "Karing's token response was not in the expected form.");
  }
  return { token, expiresAt: expires_at };
};

/** Options for {@link createTokenHandler}. */
export interface TokenHandlerOptions {
  /** Your Karing API key. Keep it in a server environment variable. */
  apiKey: string;
  /**
   * Decides who may watch your live calls. Return `true` only for a signed-in
   * user, identified by your own server-side session, who belongs to the
   * organization this API key is for and may see every one of its live calls,
   * including callers' phone numbers, and hear them. Required: without it,
   * anyone who can reach your route could listen in.
   */
  authorize: (request: Request) => boolean | Promise<boolean>;
  /** Override only to point at a test environment. */
  baseUrl?: string;
}

const json = (status: number, body: object) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * A ready-made token route, as a standard `(Request) => Response` handler:
 * it works in Next.js route handlers, Remix, Hono, Bun, Deno and Cloudflare
 * Workers. Point the browser package's `token` option at it.
 *
 * @example
 * // app/api/karing/token/route.ts (Next.js)
 * import { createTokenHandler } from "@karing/live/server";
 *
 * export const POST = createTokenHandler({
 *   apiKey: process.env.KARING_API_KEY!,
 *   // Only signed-in users of the organization this key is for, who may see live calls.
 *   authorize: async (request) => {
 *     const session = await getSession(request);
 *     const orgId = process.env.KARING_ORG_ID;
 *     if (!session || !orgId) return false;
 *     return session.organizationId === orgId && session.user.canViewLiveCalls === true;
 *   },
 * });
 */
export const createTokenHandler = (options: TokenHandlerOptions): ((request: Request) => Promise<Response>) => {
  serverOnly();
  if (typeof options.authorize !== "function") {
    throw new LiveError("forbidden", "createTokenHandler needs an authorize function, so only your own users get tokens.");
  }
  if (!options.apiKey) throw new LiveError("unauthorized", "No Karing API key was given. Set it in your server's environment.");

  return async (request) => {
    if (request.method !== "POST") return json(405, { error: "Use POST." });
    let allowed = false;
    try {
      allowed = (await options.authorize(request)) === true;
    } catch {
      allowed = false;
    }
    if (!allowed) return json(401, { error: "Not allowed to watch live calls." });
    try {
      return json(200, await createLiveToken(options));
    } catch {
      // Never the cause: it could describe the key.
      return json(502, { error: "Could not get a live token." });
    }
  };
};
