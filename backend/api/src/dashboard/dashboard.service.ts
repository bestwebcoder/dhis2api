import { Inject, Injectable } from "@nestjs/common";
import type { AuthUser, DashboardAlert, DashboardMetric, DashboardView } from "@dhis-sync/contracts";
import type { AccessScope } from "../common/access-scope.js";
import { UserRepository } from "../auth/user.repository.js";
import { AuditService } from "../common/audit.service.js";
import { DashboardRepository, type ControlPlaneTotals } from "./dashboard.repository.js";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * An administrator is accountable for the whole control plane, so their headline
 * numbers describe its health. A client's describe only what they own — the
 * totals they are built from are owner-filtered before they get here, so the
 * shape of the dashboard and the reach of its data agree.
 */
function metricsFor(role: AuthUser["role"], totals: ControlPlaneTotals): DashboardMetric[] {
  const shared: DashboardMetric[] = [
    {
      key: "tables",
      label: "Data tables",
      value: totals.appliedTables,
      hint: totals.draftBlueprints ? `${plural(totals.draftBlueprints, "draft")} not applied yet` : "all blueprints applied"
    },
    {
      key: "runs24h",
      label: "Runs today",
      value: totals.runsLast24h,
      hint: totals.failedRunsLast24h ? `${totals.failedRunsLast24h} failed` : "none failed"
    }
  ];
  if (role === "admin") {
    return [
      {
        key: "connections",
        label: "DHIS2 connections",
        value: totals.connections,
        hint: `${totals.healthyConnections} healthy, ${totals.failedConnections} failing`
      },
      ...shared,
      {
        key: "syncs",
        label: "Synchronizations",
        value: totals.syncDefinitions,
        hint: `${plural(totals.activeSchedules, "active schedule")}`
      },
      {
        key: "accounts",
        label: "Accounts",
        value: totals.accounts,
        hint: plural(totals.administrators, "administrator")
      }
    ];
  }
  // A client's endpoints lead their dashboard: they are the thing a client
  // owns, and the root of everything else they can see. "how much of this is
  // mine" is not a useful question for them — all of it is.
  return [
    {
      key: "connections",
      label: "Your endpoints",
      value: totals.connections,
      hint: totals.connections
        ? `${totals.healthyConnections} healthy, ${totals.failedConnections} failing`
        : "ask an administrator to assign you one"
    },
    ...shared,
    {
      key: "syncs",
      label: "Active synchronizations",
      value: totals.activeSyncDefinitions,
      hint: `${plural(totals.activeSchedules, "active schedule")}`
    }
  ];
}

@Injectable()
export class DashboardService {
  constructor(
    @Inject(DashboardRepository) private readonly repository: DashboardRepository,
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  async viewFor(scope: AccessScope): Promise<DashboardView> {
    const user = scope.user;
    const owner = scope.ownerFilter;
    const [totals, owns, tables, recentActivity] = await Promise.all([
      this.repository.totals(owner),
      this.users.ownershipFor(user.id),
      this.repository.tables(owner, user.id),
      this.audit.recentFor(user.id)
    ]);
    return {
      generatedAt: new Date().toISOString(),
      user,
      capabilities: { manageUsers: scope.isAdmin, deleteEntities: scope.isAdmin, runSyncs: scope.isAdmin },
      metrics: metricsFor(user.role, totals),
      owns,
      attention: scope.isAdmin ? await this.adminAttention(owner) : await this.clientAttention(scope, tables),
      recentActivity,
      tables
    };
  }

  /** Everything an administrator alone can act on. */
  private async adminAttention(owner: string | null): Promise<DashboardAlert[]> {
    const [failingConnections, failedRuns, stalled] = await Promise.all([
      this.repository.failingConnections(owner),
      this.repository.failedRuns(owner),
      this.repository.stalledSchedules(owner)
    ]);
    return [
      ...failingConnections.map((entity): DashboardAlert => ({
        severity: "error",
        title: `${entity.name} is not reachable`,
        detail: entity.detail ?? "The last credential test failed. Re-test the connection.",
        entityType: "connection",
        entityId: entity.id
      })),
      ...failedRuns.map((entity): DashboardAlert => ({
        severity: "error",
        title: `${entity.name} did not complete`,
        detail: entity.detail ?? "The last run failed. Check the run history.",
        entityType: "sync_run",
        entityId: entity.id
      })),
      ...stalled.map((entity): DashboardAlert => ({
        severity: "warning",
        title: `${entity.name} is behind schedule`,
        detail: `${entity.detail ?? "Overdue"}. The scheduler polls inside the API process, so check that it is running.`,
        entityType: "sync_schedule",
        entityId: entity.id
      }))
    ];
  }

  /**
   * A client's list only holds things about their own work: their unapplied
   * blueprints, and their own data they should not trust yet.
   */
  private async clientAttention(scope: AccessScope, tables: DashboardView["tables"]): Promise<DashboardAlert[]> {
    const drafts = await this.repository.ownDraftBlueprints(scope.userId);
    const stale = tables.filter((table) => table.lastRunStatus === "failed" || table.lastRunStatus === "partially_succeeded");
    return [
      ...drafts.map((entity): DashboardAlert => ({
        severity: "info",
        title: `${entity.name} is still a draft`,
        detail: `Apply the blueprint for ${entity.detail ?? "this resource"} to create its table.`,
        entityType: "schema_blueprint",
        entityId: entity.id
      })),
      ...stale.map((table): DashboardAlert => ({
        severity: "warning",
        title: `${table.resourceName} may be out of date`,
        detail: "The last synchronization into this table did not complete. Ask an administrator to re-run it.",
        entityType: "schema_blueprint",
        entityId: table.blueprintId
      }))
    ];
  }
}
