import { useEffect, useRef, useState, type FormEvent } from "react";
import { signIn, signUp, type AuthUser } from "./auth.js";
import { beginGoogleFlow, googleSignInEnabled } from "./google-auth.js";

export type AuthMode = "signin" | "signup";

const emptyForm = { name: "", email: "", organisation: "", password: "" };

function GoogleMark() {
  return <svg viewBox="0 0 48 48" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>;
}

export function AuthDialog({ mode, onModeChange, onClose, onAuthenticated, initialError = null }: {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onClose: () => void;
  onAuthenticated: (user: AuthUser) => void;
  /** Set when the dialog reopens after a Google redirect that did not end in a session. */
  initialError?: string | null;
}) {
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const firstField = useRef<HTMLInputElement | null>(null);
  const isSignUp = mode === "signup";

  useEffect(() => { firstField.current?.focus(); }, [mode]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const update = (patch: Partial<typeof emptyForm>) => setForm((current) => ({ ...current, ...patch }));

  const run = async (action: () => Promise<AuthUser>) => {
    setBusy(true);
    setError(null);
    try {
      onAuthenticated(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not complete that request.");
      setBusy(false);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    void run(() => isSignUp
      ? signUp({ name: form.name, email: form.email, organisation: form.organisation, password: form.password })
      : signIn({ email: form.email, password: form.password }));
  };

  const switchMode = (next: AuthMode) => { setError(null); onModeChange(next); };

  // one call for both tabs: the API signs a known Google account in and creates an unknown one
  const continueWithGoogle = async () => {
    setBusy(true);
    setError(null);
    try {
      await beginGoogleFlow("signin");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start Google sign-in.");
      setBusy(false);
    }
  };

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="auth-dialog" role="dialog" aria-modal="true" aria-labelledby="auth-dialog-title">
      <button type="button" className="auth-close" aria-label="Close" onClick={onClose}>×</button>
      <div className="auth-dialog-head">
        <span className="brand-mark">D2</span>
        <p className="step">{isSignUp ? "Create your workspace" : "Welcome back"}</p>
        <h2 id="auth-dialog-title">{isSignUp ? "Start interoperating" : "Sign in to the hub"}</h2>
        <p>{isSignUp ? "One workspace for connections, schemas, syncs and reports." : "Your connections, schedules and reports are waiting."}</p>
      </div>
      <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
        <button type="button" role="tab" aria-selected={!isSignUp} className={isSignUp ? "" : "active"} onClick={() => switchMode("signin")}>Sign in</button>
        <button type="button" role="tab" aria-selected={isSignUp} className={isSignUp ? "active" : ""} onClick={() => switchMode("signup")}>Sign up</button>
      </div>
      {googleSignInEnabled && <>
        <button type="button" className="button auth-google" disabled={busy} onClick={() => void continueWithGoogle()}>
          <GoogleMark />{isSignUp ? "Sign up with Google" : "Sign in with Google"}
        </button>
        <div className="auth-divider"><span>or use your email</span></div>
      </>}
      <form onSubmit={onSubmit}>
        <div className="auth-fields">
          {isSignUp && <label>Full name
            <input ref={firstField} value={form.name} autoComplete="name" placeholder="Amina Yusuf" required onChange={(event) => update({ name: event.target.value })} />
          </label>}
          <label>Work email
            <input ref={isSignUp ? undefined : firstField} type="email" value={form.email} autoComplete="email" placeholder="you@ministry.gov" required onChange={(event) => update({ email: event.target.value })} />
          </label>
          {isSignUp && <label>Organisation <small>Optional</small>
            <input value={form.organisation} autoComplete="organization" placeholder="National HMIS Unit" onChange={(event) => update({ organisation: event.target.value })} />
          </label>}
          <label>Password {isSignUp && <small>8 characters minimum</small>}
            <input type="password" value={form.password} autoComplete={isSignUp ? "new-password" : "current-password"} placeholder="••••••••" required onChange={(event) => update({ password: event.target.value })} />
          </label>
        </div>
        {error && <div className="alert alert--error" role="alert">{error}</div>}
        <button type="submit" className="button button--primary auth-submit" disabled={busy}>
          {busy ? "Please wait…" : isSignUp ? "Create account and continue" : "Sign in"}
        </button>
      </form>
      <p className="auth-footnote">{isSignUp
        ? "The first account created on a fresh database becomes the administrator."
        : "Sessions expire after 12 hours and every API request is verified server-side."}</p>
    </div>
  </div>;
}
