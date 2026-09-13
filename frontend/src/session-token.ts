const TOKEN_KEY = "d2hub.token";

type Listener = () => void;
const expiryListeners = new Set<Listener>();

export function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private browsing: the session lasts only as long as the page */
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Called when the API rejects our token, so the app can drop back to the landing page. */
export function onSessionExpired(listener: Listener): () => void {
  expiryListeners.add(listener);
  return () => expiryListeners.delete(listener);
}

export function notifySessionExpired(): void {
  clearToken();
  for (const listener of expiryListeners) listener();
}
