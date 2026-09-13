import { describe, expect, it, vi } from "vitest";
import type { AuthUser, UserRole } from "@dhis-sync/contracts";
import { AccessScope } from "../common/access-scope.js";
import type { AuditService } from "../common/audit.service.js";
import type { UserRepository } from "../auth/user.repository.js";
import type { ControlPlaneTotals, DashboardRepository } from "./dashboard.repository.js";
import { DashboardService } from "./dashboard.service.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

const scope = (role: UserRole): AccessScope => AccessScope.for(user(role));

const user = (role: UserRole): AuthUser => ({
  id: USER_ID,
  name: "Kofi Mensah",
  email: "kofi@ministry.gov",
  organisation: "District Office",
  role,
  lastLoginAt: null,
  createdAt: "2026-09-01T00:00:00.000Z"
});

const totalsRow = (overrides: Partial<ControlPlaneTotals> = {}): ControlPlaneTotals => ({
  connections: 4,
  healthyConnections: 3,
  failedConnections: 1,
  appliedTables: 6,
  draftBlueprints: 2,
  syncDefinitions: 5,
  activeSyncDefinitions: 4,
  activeSchedules: 3,
  runsLast24h: 12,
  failedRunsLast24h: 1,
  accounts: 7,
  administrators: 2,
  ...overrides
});

const table = (overrides: Record<string, unknown> = {}) => ({
  blueprintId: "33333333-3333-4333-8333-333333333333",
  schemaName: "dhis_data",
  tableName: "tracker_antenatal_care",
  resourceName: "Antenatal care",
  isMine: true,
  lastRunAt: "2026-09-12T00:00:00.000Z",
  lastRunStatus: "succeeded",
  ...overrides
});

function harness(repository: Partial<DashboardRepository> = {}, owns = { connections: 1, blueprints: 2, syncDefinitions: 3 }) {
  const repo = {
    totals: async () => totalsRow(),
    tables: async () => [table()],
    failingConnections: async () => [{ id: "c1", name: "Sierra Leone HMIS", detail: "401 Unauthorized" }],
    failedRuns: async () => [{ id: "r1", name: "ANC weekly", detail: "Timed out" }],
    stalledSchedules: async () => [{ id: "s1", name: "ANC monthly", detail: "Was due at 2026-09-13T08:00:00.000Z" }],
    ownDraftBlueprints: async () => [{ id: "b1", name: "tracker_malaria", detail: "Malaria case" }],
    ...repository
  } as unknown as DashboardRepository;
  const users = { ownershipFor: async () => owns } as unknown as UserRepository;
  const recentFor = vi.fn(async () => [{ action: "sync.delete", entityType: "sync_definition", entityId: "x", at: "2026-09-12T10:00:00.000Z" }]);
  return { service: new DashboardService(repo, users, { recentFor } as unknown as AuditService), recentFor };
}

describe("an administrator's dashboard", () => {
  it("leads with the health of the whole control plane", async () => {
    const { service } = harness();
    const view = await service.viewFor(scope("admin"));
    expect(view.metrics.map((metric) => metric.key)).toEqual(["connections", "tables", "runs24h", "syncs", "accounts"]);
    expect(view.metrics.at(0)).toEqual({ key: "connections", label: "DHIS2 connections", value: 4, hint: "3 healthy, 1 failing" });
    expect(view.capabilities).toEqual({ manageUsers: true, deleteEntities: true, runSyncs: true });
  });

  it("lists what only an administrator can act on", async () => {
    const { service } = harness();
    const view = await service.viewFor(scope("admin"));
    expect(view.attention.map((alert) => alert.entityType)).toEqual(["connection", "sync_run", "sync_schedule"]);
    expect(view.attention.at(0)?.detail).toBe("401 Unauthorized");
  });
});

describe("a client's dashboard", () => {
  it("leads with their own endpoints and drops the numbers they cannot act on", async () => {
    const { service } = harness();
    const view = await service.viewFor(scope("client"));
    expect(view.metrics.map((metric) => metric.key)).toEqual(["connections", "tables", "runs24h", "syncs"]);
    expect(view.metrics.map((metric) => metric.label)).not.toContain("Accounts");
    // their endpoints lead: everything else they can see hangs off one
    expect(view.metrics.at(0)).toEqual({ key: "connections", label: "Your endpoints", value: 4, hint: "3 healthy, 1 failing" });
    expect(view.capabilities).toEqual({ manageUsers: false, deleteEntities: false, runSyncs: false });
  });

  it("never shows a failing credential or a stalled schedule", async () => {
    const failingConnections = vi.fn();
    const { service } = harness({ failingConnections });
    const view = await service.viewFor(scope("client"));
    expect(view.attention.map((alert) => alert.entityType)).toEqual(["schema_blueprint"]);
    expect(failingConnections).not.toHaveBeenCalled();
  });

  it("warns about a table whose last run did not finish", async () => {
    const { service } = harness({
      ownDraftBlueprints: async () => [],
      tables: async () => [table({ lastRunStatus: "failed" }), table({ lastRunStatus: "succeeded" })]
    });
    const view = await service.viewFor(scope("client"));
    expect(view.attention).toHaveLength(1);
    expect(view.attention.at(0)?.title).toContain("Antenatal care");
  });
});

describe("individualization", () => {
  it("asks for the signed-in account's own ownership, tables and history", async () => {
    const tables = vi.fn(async () => [table()]);
    const ownDraftBlueprints = vi.fn(async () => []);
    const { service, recentFor } = harness({ tables, ownDraftBlueprints });
    const view = await service.viewFor(scope("client"));
    expect(ownDraftBlueprints).toHaveBeenCalledWith(USER_ID);
    expect(recentFor).toHaveBeenCalledWith(USER_ID);
    expect(view.owns).toEqual({ connections: 1, blueprints: 2, syncDefinitions: 3 });
    expect(view.recentActivity.at(0)?.action).toBe("sync.delete");
    expect(view.user.id).toBe(USER_ID);
  });

  it("passes the client's own id as the owner filter to every scoped query", async () => {
    const totals = vi.fn(async () => totalsRow());
    const tables = vi.fn(async () => [table()]);
    const { service } = harness({ totals, tables });
    await service.viewFor(scope("client"));
    // the first argument is the owner filter on every dashboard query
    expect(totals).toHaveBeenCalledWith(USER_ID);
    expect(tables).toHaveBeenCalledWith(USER_ID, USER_ID);
  });

  it("lifts the owner filter for an administrator, and only for them", async () => {
    const totals = vi.fn(async () => totalsRow());
    const tables = vi.fn(async () => [table()]);
    const failingConnections = vi.fn(async () => []);
    const { service } = harness({ totals, tables, failingConnections });
    await service.viewFor(scope("admin"));
    expect(totals).toHaveBeenCalledWith(null);
    expect(tables).toHaveBeenCalledWith(null, USER_ID);
    expect(failingConnections).toHaveBeenCalledWith(null);
  });
});
