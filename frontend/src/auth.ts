import type { AuthSession, AuthUser, GoogleAuthInput, SignInInput, SignUpInput } from "@dhis-sync/contracts";
import { authApi, userApi } from "./api.js";
import type { GoogleCallback } from "./google-auth.js";
import { clearToken, onSessionExpired, readToken, writeToken } from "./session-token.js";

export type { AuthUser, SignInInput, SignUpInput };
export { onSessionExpired };

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts.at(0)?.charAt(0) ?? "";
  const last = parts.length > 1 ? parts.at(-1)?.charAt(0) ?? "" : "";
  return (first + last).toUpperCase() || "U";
}

export function hasStoredToken(): boolean {
  return readToken() !== null;
}

/** Re-validates a stored token against the API; the user object is never trusted from local storage. */
export async function restoreSession(): Promise<AuthUser | null> {
  if (!hasStoredToken()) return null;
  try {
    return await authApi.me();
  } catch {
    clearToken();
    return null;
  }
}

function accept(session: AuthSession): AuthUser {
  writeToken(session.token);
  return session.user;
}

export async function signUp(input: SignUpInput): Promise<AuthUser> {
  return accept(await authApi.register(input));
}

export async function signIn(input: SignInInput): Promise<AuthUser> {
  return accept(await authApi.login(input));
}

/** Google issues no session of its own here: the API exchanges the code and returns ours. */
export async function signInWithGoogle(input: GoogleAuthInput): Promise<AuthUser> {
  return accept(await authApi.google(input));
}

export function signOut(): void {
  clearToken();
}

export interface ProfileMessage {
  tone: "success" | "error";
  text: string;
}

/** How the app opens: who is signed in, and anything a Google redirect has to report. */
export interface SessionStart {
  user: AuthUser | null;
  signInError?: string;
  profileMessage?: ProfileMessage;
}

const failure = (cause: unknown, fallback: string) => cause instanceof Error ? cause.message : fallback;

let googleStart: Promise<SessionStart> | undefined;

/**
 * Restores a stored session, or finishes a Google redirect. A Google code is
 * single-use, so that work is memoised for the page load — StrictMode runs the
 * boot effect twice in development, and a second exchange would fail.
 */
export function startSession(callback: GoogleCallback | null): Promise<SessionStart> {
  if (!callback) return restoreSession().then((user) => ({ user }));
  googleStart ??= finishGoogle(callback);
  return googleStart;
}

async function finishGoogle(callback: GoogleCallback): Promise<SessionStart> {
  if (callback.intent === "signin") {
    if (callback.kind === "error") return { user: null, signInError: callback.message };
    try {
      return { user: await signInWithGoogle(callback.input) };
    } catch (cause) {
      return { user: null, signInError: failure(cause, "Could not sign in with Google.") };
    }
  }

  const user = await restoreSession();
  if (!user) {
    return { user: null, signInError: "Your session ended before Google finished. Sign in, then connect Google again from your profile." };
  }
  if (callback.kind === "error") return { user, profileMessage: { tone: "error", text: callback.message } };
  try {
    await userApi.linkGoogle(callback.input);
    return { user, profileMessage: { tone: "success", text: "Google is connected. You can now sign in with either method." } };
  } catch (cause) {
    return { user, profileMessage: { tone: "error", text: failure(cause, "Could not connect Google.") } };
  }
}
