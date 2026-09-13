import { useEffect, useMemo, useState } from "react";
import type { ConnectionSummary, UserRole, UserSummary } from "@dhis-sync/contracts";
import { connectionApi, userApi } from "./api.js";
import { useCurrentUser, ROLE_LABEL } from "./auth-context.js";

const BLANK = { name: "", email: "", organisation: "", role: "client" as UserRole, password: "" };

function ownedTotal(user: UserSummary): number {
  return user.owns.connections + user.owns.blueprints + user.owns.syncDefinitions;
}

/**
 * Account and endpoint administration. Every control here is admin-only on the
 * API as well — App.tsx keeps the page out of a client's navigation, and the
 * RolesGuard refuses a hand-made request from one.
 */
export function AdminPanel() {
  const currentUser = useCurrentUser();
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [form, setForm] = useState(BLANK);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const clients = useMemo(() => users.filter((user) => user.role === "client"), [users]);
  const unassigned = useMemo(() => connections.filter((item) => !item.ownerId).length, [connections]);

  async function load() {
    try {
      const [accounts, endpoints] = await Promise.all([userApi.list(), connectionApi.list()]);
      setUsers(accounts);
      setConnections(endpoints);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the management panel");
    }
  }

  useEffect(() => { void load(); }, []);

  function update<K extends keyof typeof BLANK>(key: K, value: (typeof BLANK)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function act<T>(key: string, operation: () => Promise<T>, success: string): Promise<T | undefined> {
    setBusy(key); setError(null); setNotice(null);
    try {
      const result = await operation();
      await load();
      setNotice(success);
      return result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The request was refused");
      return undefined;
    } finally {
      setBusy("");
    }
  }

  async function createAccount(event: React.FormEvent) {
    event.preventDefault();
    const created = await act("create", () => userApi.create(form), `Account for ${form.email} was created.`);
    if (created) { setForm(BLANK); setShowForm(false); }
  }

  async function setRole(user: UserSummary, role: UserRole) {
    await act(`role-${user.id}`, () => userApi.update(user.id, {
      name: user.name, organisation: user.organisation, role, isActive: user.isActive
    }), `${user.name} is now ${ROLE_LABEL[role].toLowerCase()}.`);
  }

  async function setActive(user: UserSummary, isActive: boolean) {
    await act(`active-${user.id}`, () => userApi.update(user.id, {
      name: user.name, organisation: user.organisation, role: user.role, isActive
    }), `${user.name} was ${isActive ? "restored" : "deactivated"}.`);
  }

  async function removeAccount(user: UserSummary) {
    const owned = ownedTotal(user);
    const warning = owned
      ? `\n\nThe ${owned} object(s) they created are kept, but will belong to nobody until you reassign them.`
      : "";
    const confirmation = window.prompt(`Delete the account for ${user.email}?${warning}\n\nType ${user.email} to confirm.`);
    if (confirmation !== user.email) return;
    await act(`delete-${user.id}`, () => userApi.delete(user.id, user.email), `The account for ${user.email} was deleted.`);
  }

  async function reassign(connection: ConnectionSummary, ownerId: string) {
    const owner = users.find((user) => user.id === ownerId);
    await act(`owner-${connection.id}`, () => connectionApi.setOwner(connection.id, ownerId || null),
      owner ? `"${connection.name}" now belongs to ${owner.name}.` : `"${connection.name}" no longer belongs to anyone.`);
  }

  return (
    <main className="content content--wide" id="main-content">
      <header className="page-header">
        <div>
          <p className="eyebrow">Administration</p>
          <h1>Management panel</h1>
          <p className="lede">
            Create client accounts, monitor who is using the hub, and decide which DHIS2 endpoint belongs to whom.
            A client only ever sees the endpoints, tables and rows assigned to them.
          </p>
        </div>
        <button className="button button--primary" onClick={() => setShowForm((open) => !open)}>
          <span aria-hidden="true">＋</span> {showForm ? "Close form" : "New client account"}
        </button>
      </header>

      <section className="summary-grid" aria-label="Account summary">
        <article className="metric"><span>Accounts</span><strong>{users.length}</strong><small>{users.filter((user) => user.isActive).length} active</small></article>
        <article className="metric"><span>Clients</span><strong>{clients.length}</strong><small>{users.length - clients.length} administrator(s)</small></article>
        <article className="metric"><span>Endpoints</span><strong>{connections.length}</strong><small>{unassigned} unassigned</small></article>
      </section>

      {error && <div className="alert alert--error" role="alert"><strong>Unable to complete the request.</strong><span>{error}</span></div>}
      {notice && <div className="alert alert--success" role="status"><strong>Done.</strong><span>{notice}</span></div>}

      {showForm && (
        <section className="panel form-panel">
          <div className="panel-heading">
            <div><p className="step">Provision access</p><h2>Create an account</h2></div>
            <span className="secure-note">The password is stored as a scrypt hash, never in the clear</span>
          </div>
          <form onSubmit={createAccount}>
            <div className="form-grid">
              <label><span>Full name</span><input required minLength={2} value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Kofi Mensah" /></label>
              <label><span>Email</span><input required type="email" value={form.email} onChange={(e) => update("email", e.target.value)} placeholder="kofi@ministry.gov" /></label>
              <label><span>Organisation</span><input value={form.organisation} onChange={(e) => update("organisation", e.target.value)} placeholder="District Health Office" /></label>
              <label><span>Role</span>
                <select value={form.role} onChange={(e) => update("role", e.target.value as UserRole)}>
                  <option value="client">Client — sees only their own data</option>
                  <option value="admin">Administrator — sees everything</option>
                </select>
              </label>
              <label className="span-2"><span>Temporary password</span>
                <input required type="password" minLength={8} value={form.password} onChange={(e) => update("password", e.target.value)} />
                <small>At least 8 characters. Ask the account holder to change it from their profile after the first sign-in.</small>
              </label>
            </div>
            <div className="form-actions">
              <button type="button" className="button button--quiet" onClick={() => { setShowForm(false); setForm(BLANK); }}>Cancel</button>
              <button type="submit" className="button button--primary" disabled={busy === "create"}>{busy === "create" ? "Creating…" : "Create account"}</button>
            </div>
          </form>
        </section>
      )}

      <section className="panel">
        <div className="panel-heading"><div><p className="step">Accounts</p><h2>Everyone with access</h2></div></div>
        {users.length === 0 ? <p className="empty">No accounts yet.</p> : (
          <table className="sync-table">
            <thead><tr><th>Account</th><th>Organisation</th><th>Role</th><th>Owns</th><th>Last sign-in</th><th>Status</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {users.map((user) => {
                const isSelf = user.id === currentUser.id;
                const rowBusy = busy.endsWith(user.id);
                return (
                  <tr key={user.id}>
                    <td><strong>{user.name}</strong><small className="stack-note">{user.email}</small></td>
                    <td>{user.organisation}</td>
                    <td>
                      {/* an admin cannot demote themselves; the API refuses it too */}
                      <select value={user.role} disabled={isSelf || rowBusy} onChange={(e) => void setRole(user, e.target.value as UserRole)} aria-label={`Role for ${user.name}`}>
                        <option value="client">Client</option>
                        <option value="admin">Administrator</option>
                      </select>
                    </td>
                    <td>{ownedTotal(user) === 0 ? <span className="stack-note">nothing yet</span> : (
                      <span className="stack-note">{user.owns.connections} endpoint(s) · {user.owns.blueprints} table(s) · {user.owns.syncDefinitions} sync(s)</span>
                    )}</td>
                    <td>{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : <span className="stack-note">never</span>}</td>
                    <td><span className={`pill ${user.isActive ? "pill--applied" : "pill--retired"}`}>{user.isActive ? "Active" : "Deactivated"}</span></td>
                    <td>
                      <div className="row-actions row-actions--wrap">
                        {isSelf ? <span className="role-note">This is you</span> : <>
                          <button className="text-button" disabled={rowBusy} onClick={() => void setActive(user, !user.isActive)}>{user.isActive ? "Deactivate" : "Restore"}</button>
                          <button className="text-button text-button--danger" disabled={rowBusy} onClick={() => void removeAccount(user)}>Delete</button>
                        </>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel">
        <div className="panel-heading">
          <div><p className="step">Endpoints</p><h2>Who each DHIS2 connection belongs to</h2></div>
          <span className="secure-note">Reassigning moves the endpoint's tables and syncs with it</span>
        </div>
        {connections.length === 0 ? <p className="empty">No DHIS2 connections have been added yet.</p> : (
          <table className="sync-table">
            <thead><tr><th>Endpoint</th><th>Server</th><th>Health</th><th>Belongs to</th></tr></thead>
            <tbody>
              {connections.map((connection) => (
                <tr key={connection.id}>
                  <td><strong>{connection.name}</strong><small className="stack-note">{connection.role}</small></td>
                  <td><small className="stack-note">{connection.baseUrl}</small></td>
                  <td><span className={`status status--${connection.lastTestStatus}`}>{connection.lastTestStatus}</span></td>
                  <td>
                    <select
                      className="owner-select"
                      value={connection.ownerId ?? ""}
                      disabled={busy === `owner-${connection.id}`}
                      aria-label={`Owner of ${connection.name}`}
                      onChange={(e) => void reassign(connection, e.target.value)}
                    >
                      <option value="">Nobody — administrators only</option>
                      {users.filter((user) => user.isActive).map((user) => (
                        <option key={user.id} value={user.id}>{user.name} ({ROLE_LABEL[user.role]})</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
