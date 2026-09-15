import { useEffect, useState } from "react";
import type { AuthUser, UserSummary } from "@dhis-sync/contracts";
import { userApi } from "./api.js";
import type { ProfileMessage } from "./auth.js";
import { ROLE_LABEL, useCurrentUser } from "./auth-context.js";
import { beginGoogleFlow, googleSignInEnabled } from "./google-auth.js";

const BLANK_PASSWORD = { currentPassword: "", newPassword: "", confirmPassword: "" };

function when(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "never";
}

/**
 * The signed-in account's own profile. Everything here comes from
 * /users/me/profile and goes back to /users/me/profile — there is no id in any
 * request, so this screen cannot be pointed at somebody else's account.
 */
export function ProfilePage({ onProfileChange, initialMessage = null, onMessageShown }: {
  onProfileChange: (user: AuthUser) => void;
  /** The outcome of connecting Google, which lands here after the redirect back. */
  initialMessage?: ProfileMessage | null;
  onMessageShown?: () => void;
}) {
  const currentUser = useCurrentUser();
  const [profile, setProfile] = useState<UserSummary | null>(null);
  const [details, setDetails] = useState({ name: "", organisation: "", email: "", currentPassword: "" });
  const [passwords, setPasswords] = useState(BLANK_PASSWORD);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(initialMessage?.tone === "error" ? initialMessage.text : null);
  const [notice, setNotice] = useState<string | null>(initialMessage?.tone === "success" ? initialMessage.text : null);
  const hasPassword = profile?.signInMethods.password ?? true;

  // shown once: leaving and returning to the profile should not repeat it
  useEffect(() => { if (initialMessage) onMessageShown?.(); }, []);

  // the email is what you sign in with, so the API asks for a password to move it
  const emailChanged = profile !== null && details.email.trim().toLowerCase() !== profile.email;

  async function load() {
    try {
      const loaded = await userApi.readOwnProfile();
      setProfile(loaded);
      setDetails({ name: loaded.name, organisation: loaded.organisation, email: loaded.email, currentPassword: "" });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load your profile");
    }
  }

  useEffect(() => { void load(); }, []);

  async function saveDetails(event: React.FormEvent) {
    event.preventDefault();
    setBusy("details"); setError(null); setNotice(null);
    try {
      const updated = await userApi.updateOwnProfile({
        name: details.name,
        organisation: details.organisation,
        email: details.email,
        ...(emailChanged ? { currentPassword: details.currentPassword } : {})
      });
      setProfile(updated);
      setDetails({ name: updated.name, organisation: updated.organisation, email: updated.email, currentPassword: "" });
      // the header shows the name and role, so keep the shell in step
      onProfileChange(updated);
      setNotice(emailChanged
        ? `Saved. You now sign in as ${updated.email}.`
        : "Your profile was saved.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save your profile");
    } finally {
      setBusy("");
    }
  }

  async function savePassword(event: React.FormEvent) {
    event.preventDefault();
    if (passwords.newPassword !== passwords.confirmPassword) {
      setError("The new password and its confirmation do not match.");
      return;
    }
    setBusy("password"); setError(null); setNotice(null);
    try {
      await userApi.changeOwnPassword({
        currentPassword: passwords.currentPassword,
        newPassword: passwords.newPassword
      });
      setPasswords(BLANK_PASSWORD);
      setNotice("Your password was changed. Your current session stays signed in.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not change your password");
    } finally {
      setBusy("");
    }
  }

  async function connectGoogle() {
    setBusy("google"); setError(null); setNotice(null);
    try {
      await beginGoogleFlow("link");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start connecting Google");
      setBusy("");
    }
  }

  async function disconnectGoogle() {
    setBusy("google"); setError(null); setNotice(null);
    try {
      setProfile(await userApi.unlinkGoogle());
      setNotice("Google was disconnected. Sign in with your email and password from now on.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect Google");
    } finally {
      setBusy("");
    }
  }

  const owned = profile ? profile.owns.connections + profile.owns.blueprints + profile.owns.syncDefinitions : 0;

  return (
    <main className="content" id="main-content">
      <header className="page-header">
        <div>
          <p className="eyebrow">Your account</p>
          <h1>Profile</h1>
          <p className="lede">
            Your name, the organisation you belong to, the address you sign in with, and your password.
            Only you can change these — an administrator can change your role, but not your credentials.
          </p>
        </div>
      </header>

      {error && <div className="alert alert--error" role="alert"><strong>Unable to complete the request.</strong><span>{error}</span></div>}
      {notice && <div className="alert alert--success" role="status"><strong>Done.</strong><span>{notice}</span></div>}

      <section className="summary-grid" aria-label="Account summary">
        <article className="metric">
          <span>Role</span>
          <strong className="metric-text">{ROLE_LABEL[currentUser.role]}</strong>
          <small>{currentUser.role === "admin" ? "Full access to the control plane" : "Limited to what you own"}</small>
        </article>
        <article className="metric">
          <span>You own</span>
          <strong>{owned}</strong>
          <small>{profile ? `${profile.owns.connections} endpoint(s) · ${profile.owns.blueprints} table(s) · ${profile.owns.syncDefinitions} sync(s)` : "…"}</small>
        </article>
        <article className="metric">
          <span>Last sign-in</span>
          <strong className="metric-text metric-text--small">{profile ? when(profile.lastLoginAt) : "…"}</strong>
          <small>{profile ? `Account created ${when(profile.createdAt)}` : ""}</small>
        </article>
      </section>

      <section className="panel form-panel">
        <div className="panel-heading">
          <div><p className="step">Details</p><h2>Who you are</h2></div>
          {profile?.createdByName && <span className="secure-note">Account created by {profile.createdByName}</span>}
        </div>
        <form onSubmit={saveDetails}>
          <div className="form-grid">
            <label><span>Full name</span>
              <input required minLength={2} value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} />
            </label>
            <label><span>Organisation</span>
              <input value={details.organisation} onChange={(e) => setDetails({ ...details, organisation: e.target.value })} placeholder="Unassigned" />
            </label>
            <label className="span-2"><span>Email</span>
              <input required type="email" value={details.email} readOnly={!hasPassword} onChange={(e) => setDetails({ ...details, email: e.target.value })} />
              <small>{hasPassword
                ? "This is the address you sign in with. Changing it asks for your password."
                : "Your account signs in with Google and has no password to confirm a change, so this address is fixed."}</small>
            </label>
            {emailChanged && (
              <label className="span-2"><span>Current password</span>
                <input required type="password" autoFocus value={details.currentPassword}
                  onChange={(e) => setDetails({ ...details, currentPassword: e.target.value })} />
                <small>Confirms it is really you moving the account to {details.email.trim().toLowerCase()}.</small>
              </label>
            )}
          </div>
          <div className="form-actions">
            <button type="button" className="button button--quiet" disabled={Boolean(busy) || !profile}
              onClick={() => profile && setDetails({ name: profile.name, organisation: profile.organisation, email: profile.email, currentPassword: "" })}>
              Reset
            </button>
            <button type="submit" className="button button--primary" disabled={busy === "details" || !profile}>
              {busy === "details" ? "Saving…" : "Save details"}
            </button>
          </div>
        </form>
      </section>

      {profile && (profile.signInMethods.google || googleSignInEnabled) && (
        <section className="panel form-panel">
          <div className="panel-heading">
            <div><p className="step">Sign-in methods</p><h2>How you get in</h2></div>
            <span className="secure-note">Linked by Google's permanent account ID, not by email</span>
          </div>
          <ul className="signin-methods">
            <li>
              <div><strong>Email and password</strong>
                <small>{profile.signInMethods.password ? `Sign in as ${profile.email}.` : "Not set. This account signs in with Google only."}</small>
              </div>
            </li>
            <li>
              <div><strong>Google</strong>
                <small>{profile.signInMethods.google
                  ? profile.signInMethods.password
                    ? "Connected."
                    : "Connected. It is the only way into this account, so it cannot be disconnected."
                  : `Connect the Google account for ${profile.email} to sign in without a password.`}</small>
              </div>
              {profile.signInMethods.google
                ? profile.signInMethods.password && <button type="button" className="button button--quiet" disabled={Boolean(busy)} onClick={() => void disconnectGoogle()}>
                  {busy === "google" ? "Disconnecting…" : "Disconnect"}
                </button>
                : <button type="button" className="button button--quiet" disabled={Boolean(busy)} onClick={() => void connectGoogle()}>
                  {busy === "google" ? "Opening Google…" : "Connect Google"}
                </button>}
            </li>
          </ul>
        </section>
      )}

      {hasPassword && <section className="panel form-panel">
        <div className="panel-heading">
          <div><p className="step">Security</p><h2>Change your password</h2></div>
          <span className="secure-note">Stored as a scrypt hash, never in the clear</span>
        </div>
        <form onSubmit={savePassword}>
          <div className="form-grid">
            <label className="span-2"><span>Current password</span>
              <input required type="password" autoComplete="current-password" value={passwords.currentPassword}
                onChange={(e) => setPasswords({ ...passwords, currentPassword: e.target.value })} />
            </label>
            <label><span>New password</span>
              <input required type="password" minLength={8} autoComplete="new-password" value={passwords.newPassword}
                onChange={(e) => setPasswords({ ...passwords, newPassword: e.target.value })} />
              <small>At least 8 characters.</small>
            </label>
            <label><span>Confirm new password</span>
              <input required type="password" minLength={8} autoComplete="new-password" value={passwords.confirmPassword}
                onChange={(e) => setPasswords({ ...passwords, confirmPassword: e.target.value })} />
            </label>
          </div>
          <div className="form-actions">
            <button type="submit" className="button button--primary" disabled={busy === "password"}>
              {busy === "password" ? "Changing…" : "Change password"}
            </button>
          </div>
        </form>
      </section>}
    </main>
  );
}
