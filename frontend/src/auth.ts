import type { AuthSession, AuthUser, SignInInput, SignUpInput } from "@dhis-sync/contracts";
import { authApi } from "./api.js";
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

export function signOut(): void {
  clearToken();
}
