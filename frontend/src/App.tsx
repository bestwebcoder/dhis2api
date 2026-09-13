import { useEffect, useState } from "react";
import { AdminPanel } from "./AdminPanel.js";
import { AuthDialog, type AuthMode } from "./AuthDialog.js";
import { Backups } from "./Backups.js";
import { ConnectionManager } from "./ConnectionManager.js";
import { LandingPage } from "./LandingPage.js";
import { Overview } from "./Overview.js";
import { ProfilePage } from "./ProfilePage.js";
import { Reports } from "./Reports.js";
import { SchemaBuilder } from "./SchemaBuilder.js";
import { SyncSchedules } from "./SyncSchedules.js";
import { ThemeChoice, ThemeToggle } from "./ThemeToggle.js";
import { hasStoredToken, initials, onSessionExpired, restoreSession, signOut, type AuthUser } from "./auth.js";
import { CurrentUserProvider, ROLE_LABEL } from "./auth-context.js";
import { useTheme } from "./theme.js";

type Page = "overview" | "connections" | "schema" | "sync" | "reports" | "backups" | "admin" | "profile";

/**
 * `adminOnly` keeps a page out of a client's navigation. It is presentation
 * only — the API refuses an admin route from a client account either way, and
 * every other page returns only the rows that client owns.
 */
const navigation: { id: Page; icon: string; label: string; adminOnly?: true }[] = [
  { id: "overview", icon: "⌂", label: "Overview" },
  { id: "connections", icon: "↔", label: "Connections" },
  { id: "schema", icon: "▦", label: "Schema builder" },
  { id: "sync", icon: "◴", label: "Sync schedules" },
  { id: "reports", icon: "≡", label: "Single-line reports" },
  { id: "backups", icon: "↓", label: "Backups" },
  { id: "admin", icon: "⚙", label: "Management panel", adminOnly: true }
];

export function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  // a stored token is only a hint; the API decides, so hold the shell until /auth/me answers
  const [restoring, setRestoring] = useState(() => hasStoredToken());
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [page, setPage] = useState<Page>("overview");
  const isAdmin = user?.role === "admin";
  const pages = navigation.filter((item) => isAdmin || !item.adminOnly);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const { preference, resolved, setPreference } = useTheme();
  const navigate = (target: Page) => { setPage(target); setMobileOpen(false); window.scrollTo({ top: 0 }); };

  useEffect(() => {
    if (!restoring) return;
    let cancelled = false;
    void restoreSession().then((restored) => { if (!cancelled) { setUser(restored); setRestoring(false); } });
    return () => { cancelled = true; };
  }, [restoring]);

  // the API rejected our token mid-session: fall back to signed-out
  useEffect(() => onSessionExpired(() => { setUser(null); setAccountOpen(false); setMobileOpen(false); }), []);

  useEffect(() => {
    if (!accountOpen) return;
    const close = () => setAccountOpen(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [accountOpen]);

  const onAuthenticated = (authenticated: AuthUser) => {
    setUser(authenticated);
    setAuthMode(null);
    setPage("overview");
    window.scrollTo({ top: 0 });
  };

  const endSession = () => { signOut(); setUser(null); setAccountOpen(false); setMobileOpen(false); };

  if (restoring) return <div className="session-restore" role="status"><span className="brand-mark">D2</span><p>Restoring your session…</p></div>;

  if (!user) return <>
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <LandingPage onAuth={setAuthMode} />
    {authMode && <AuthDialog mode={authMode} onModeChange={setAuthMode} onClose={() => setAuthMode(null)} onAuthenticated={onAuthenticated} />}
  </>;

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Skip to main content</a>
    <aside className={`sidebar ${mobileOpen ? "sidebar--open" : ""}`}>
      <div className="brand"><span className="brand-mark">D2</span><div><strong>Interoperability</strong><small>DHIS2 data hub</small></div></div>
      <nav aria-label="Primary navigation">{pages.map((item) => <button type="button" className={page === item.id ? "active" : ""} aria-current={page === item.id ? "page" : undefined} onClick={() => navigate(item.id)} key={item.id}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav>
      <div className="sidebar-foot"><span className="environment-dot" /> Development environment<small>API v1 · PostgreSQL</small></div>
    </aside>
    {mobileOpen && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => setMobileOpen(false)} />}
    <div className="workspace">
      {/* Sticky, and rendered on every authenticated page: the Home link and the
          theme control are reachable from anywhere without scrolling back up,
          and on mobile — where the sidebar is hidden — this is the whole nav. */}
      <header className="topbar">
        <button className="icon-button" aria-label="Open navigation" onClick={() => setMobileOpen(true)}>☰</button>
        <button
          type="button"
          className="home-link"
          aria-current={page === "overview" ? "page" : undefined}
          onClick={() => navigate("overview")}
        >
          <span className="brand-mark" aria-hidden="true">D2</span>
          <span>Home</span>
        </button>
        <div className="topbar-status"><span /> Platform operational</div>
        <ThemeToggle preference={preference} resolved={resolved} onChange={setPreference} />
        <div className="account">
          <button className="user-menu" aria-expanded={accountOpen} aria-haspopup="menu" onClick={(event) => { event.stopPropagation(); setAccountOpen((open) => !open); }}><span>{initials(user.name)}</span><div><strong>{user.name}</strong><small>{ROLE_LABEL[user.role]} · {user.organisation}</small></div></button>
          {accountOpen && <div className="account-menu" role="menu" onClick={(event) => event.stopPropagation()}>
            <div className="account-menu-head"><strong>{user.name}</strong><small>{user.email}</small><span className={`role-badge role-badge--${user.role}`}>{ROLE_LABEL[user.role]}</span></div>
            <button type="button" className="account-menu-link" role="menuitem" aria-current={page === "profile" ? "page" : undefined} onClick={() => { setAccountOpen(false); navigate("profile"); }}>Your profile</button>
            <div className="account-menu-theme"><small>Appearance</small><ThemeChoice preference={preference} onChange={setPreference} /></div>
            <button type="button" role="menuitem" onClick={endSession}>Sign out</button>
          </div>}
        </div>
      </header>
      <CurrentUserProvider user={user}>
        {page === "overview" && <Overview navigate={(target) => navigate(target as Page)} />}
        {page === "connections" && <ConnectionManager />}
        {page === "schema" && <SchemaBuilder />}
        {page === "sync" && <SyncSchedules />}
        {page === "reports" && <Reports />}
        {page === "backups" && <Backups navigate={(target) => navigate(target as Page)} />}
        {page === "admin" && isAdmin && <AdminPanel />}
        {page === "profile" && <ProfilePage onProfileChange={setUser} />}
      </CurrentUserProvider>
    </div>
  </div>;
}
