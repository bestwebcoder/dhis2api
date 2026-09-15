import type { GoogleAuthInput } from "@dhis-sync/contracts";

const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const PENDING_KEY = "d2hub.google";
// a public identifier, not a secret: the client secret lives only in backend/.env
const CLIENT_ID = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim() ?? "";

export const googleSignInEnabled = CLIENT_ID !== "";

/** Signing in (or up) from the landing page, or connecting Google to the signed-in account. */
export type GoogleIntent = "signin" | "link";

/** What this tab remembers across the round trip to Google, in sessionStorage. */
export interface PendingGoogleFlow {
  state: string;
  codeVerifier: string;
  redirectUri: string;
  intent: GoogleIntent;
}

export type GoogleCallback =
  | { kind: "code"; intent: GoogleIntent; input: GoogleAuthInput }
  | { kind: "error"; intent: GoogleIntent; message: string };

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 random bytes: 43 base64url characters, the shortest verifier RFC 7636 allows. */
function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function codeChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export function authorizationUrl(clientId: string, flow: PendingGoogleFlow, codeChallenge: string): string {
  const parameters = new URLSearchParams({
    client_id: clientId,
    redirect_uri: flow.redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state: flow.state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "select_account"
  });
  return `${AUTHORIZATION_ENDPOINT}?${parameters.toString()}`;
}

function isPendingFlow(value: unknown): value is PendingGoogleFlow {
  const candidate = value as Partial<PendingGoogleFlow> | null;
  return typeof candidate?.state === "string" && typeof candidate.codeVerifier === "string"
    && typeof candidate.redirectUri === "string" && (candidate.intent === "signin" || candidate.intent === "link");
}

/**
 * Interprets the query string Google redirected back with. `state` must be the
 * one this tab generated: a redirect this tab did not start — someone else's
 * code in a crafted link, trying to sign the visitor into the wrong account —
 * is refused before the code goes anywhere.
 */
export function parseCallback(search: string, pending: PendingGoogleFlow | null): GoogleCallback | null {
  const parameters = new URLSearchParams(search);
  const code = parameters.get("code");
  const error = parameters.get("error");
  if (!code && !error) return null;
  if (!pending || parameters.get("state") !== pending.state) {
    return { kind: "error", intent: pending?.intent ?? "signin", message: "That Google sign-in could not be verified. Start again." };
  }
  if (!code) {
    return {
      kind: "error",
      intent: pending.intent,
      message: error === "access_denied" ? "Google sign-in was cancelled." : "Google could not complete the sign-in. Start again."
    };
  }
  return { kind: "code", intent: pending.intent, input: { code, codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri } };
}

/** Leaves the app for Google's consent screen; the page comes back through takeGoogleCallback. */
export async function beginGoogleFlow(intent: GoogleIntent): Promise<void> {
  if (!googleSignInEnabled) throw new Error("Google sign-in is not configured for this dashboard.");
  const flow: PendingGoogleFlow = {
    state: randomToken(),
    codeVerifier: randomToken(),
    // the site root, so no router or rewrite is needed; register it on the OAuth client
    redirectUri: `${window.location.origin}/`,
    intent
  };
  try {
    window.sessionStorage.setItem(PENDING_KEY, JSON.stringify(flow));
  } catch {
    throw new Error("Your browser blocked the storage Google sign-in needs. Allow site data for this page and try again.");
  }
  window.location.assign(authorizationUrl(CLIENT_ID, flow, await codeChallengeFor(flow.codeVerifier)));
}

let taken: GoogleCallback | null | undefined;

/**
 * Reads Google's redirect once per page load and immediately removes both the
 * pending flow and the code from the address bar, so neither a refresh, the
 * back button nor a copied URL can replay it. Memoised because StrictMode calls
 * state initialisers twice.
 */
export function takeGoogleCallback(): GoogleCallback | null {
  if (taken !== undefined) return taken;
  let pending: PendingGoogleFlow | null = null;
  try {
    const raw = window.sessionStorage.getItem(PENDING_KEY);
    window.sessionStorage.removeItem(PENDING_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    pending = isPendingFlow(parsed) ? parsed : null;
  } catch {
    pending = null;
  }
  taken = parseCallback(window.location.search, pending);
  if (taken) window.history.replaceState(null, "", `${window.location.pathname}${window.location.hash}`);
  return taken;
}
