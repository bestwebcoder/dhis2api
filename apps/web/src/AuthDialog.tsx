import { useEffect, useRef, useState, type FormEvent } from "react";
import { signIn, signUp, type AuthUser } from "./auth.js";

export type AuthMode = "signin" | "signup";

const emptyForm = { name: "", email: "", organisation: "", password: "" };

export function AuthDialog({ mode, onModeChange, onClose, onAuthenticated }: {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  onClose: () => void;
  onAuthenticated: (user: AuthUser) => void;
}) {
  const [form, setForm] = useState(emptyForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
