import { useEffect, useState } from "react";
import type { DashboardAlert, DashboardView } from "@dhis-sync/contracts";
import { dashboardApi } from "./api.js";
import { useCurrentUser } from "./auth-context.js";

const SEVERITY_LABEL: Record<DashboardAlert["severity"], string> = {
  error: "Needs attention",
  warning: "Check this",
  info: "Suggestion"
};

/**
 * The signed-in account's own dashboard. Everything on it comes from one
 * request: the API shapes it by role and fills it only with rows the caller
 * owns, so a client's page is their data and nothing else.
 */
export function Overview({ navigate }: { navigate: (page: string) => void }) {
  const user = useCurrentUser();
  const [view, setView] = useState<DashboardView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void dashboardApi.view().then(
      (result) => { if (!cancelled) setView(result); },
      (cause: unknown) => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Could not load your dashboard"); }
    );
    return () => { cancelled = true; };
  }, []);

  const isAdmin = view?.capabilities.manageUsers ?? false;

  return (
    <main className="content" id="main-content">
      <header className="page-header">
        <div>
          <p className="eyebrow">{isAdmin ? "System overview" : "Your workspace"}</p>
          <h1>{isAdmin ? "DHIS2 interoperability hub" : `Welcome back, ${user.name.split(" ")[0]}`}</h1>
          <p className="lede">
            {isAdmin
              ? "A local control plane for secure connections, metadata-driven tables, scheduled synchronization, and single-line tracker reporting."
              : "Your DHIS2 endpoints, the tables built from them, and the reports you can export. Only your own data appears here."}
          </p>
        </div>
      </header>

      {error && <div className="alert alert--error" role="alert"><strong>Unable to load your dashboard.</strong><span>{error}</span></div>}

      <section className="summary-grid" aria-label="Summary">
        {(view?.metrics ?? []).map((metric) => (
          <article className="metric" key={metric.key}>
            <span>{metric.label}</span>
            <strong>{metric.value.toLocaleString()}</strong>
            <small>{metric.hint ?? ""}</small>
          </article>
        ))}
      </section>

      {view && view.attention.length > 0 && (
        <section className="panel">
          <div className="panel-heading"><div><p className="step">{isAdmin ? "Across the platform" : "About your data"}</p><h2>Worth a look</h2></div></div>
          <ul className="insight-list">
            {view.attention.map((alert, index) => (
              <li key={`${alert.entityType}-${alert.entityId ?? index}`}>
                <span className={`pill pill--${alert.severity === "error" ? "retired" : "applied"}`}>{SEVERITY_LABEL[alert.severity]}</span>
                <strong>{alert.title}</strong>
                <small className="stack-note">{alert.detail}</small>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view && view.tables.length > 0 && (
        <section className="panel">
          <div className="panel-heading">
            <div><p className="step">Reporting</p><h2>{isAdmin ? "Applied data tables" : "Tables you can report on"}</h2></div>
            <button className="text-button" onClick={() => navigate("reports")}>Open reports</button>
          </div>
          <table className="sync-table">
            <thead><tr><th>Resource</th><th>Table</th><th>Last synchronization</th></tr></thead>
            <tbody>
              {view.tables.map((table) => (
                <tr key={table.blueprintId}>
                  <td><strong>{table.resourceName}</strong>{isAdmin && table.isMine && <small className="stack-note">created by you</small>}</td>
                  <td><small className="stack-note">{table.schemaName}.{table.tableName}</small></td>
                  <td>
                    {table.lastRunStatus
                      ? <><span className={`status status--${table.lastRunStatus === "succeeded" ? "healthy" : "failed"}`}>{table.lastRunStatus}</span>
                          {table.lastRunAt && <small className="stack-note">{new Date(table.lastRunAt).toLocaleString()}</small>}</>
                      : <span className="stack-note">never run</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="workflow-grid">
        <button onClick={() => navigate("connections")}><span>1</span><strong>{isAdmin ? "Connect DHIS2" : "Your endpoints"}</strong><small>Verify source and destination APIs</small></button>
        <button onClick={() => navigate("schema")}><span>2</span><strong>Build schema</strong><small>Discover metadata and apply tables</small></button>
        <button onClick={() => navigate("sync")}><span>3</span><strong>Run synchronization</strong><small>Manual and interval-based jobs</small></button>
        <button onClick={() => navigate("reports")}><span>4</span><strong>View reports</strong><small>Filter and export flattened records</small></button>
      </section>

      {view && view.recentActivity.length > 0 && (
        <section className="panel">
          <div className="panel-heading"><div><p className="step">History</p><h2>Your recent actions</h2></div></div>
          <ul className="insight-list">
            {view.recentActivity.map((activity, index) => (
              <li key={`${activity.action}-${index}`}>
                <strong>{activity.action.replaceAll(".", " · ").replaceAll("_", " ")}</strong>
                <small className="stack-note">{new Date(activity.at).toLocaleString()}</small>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
