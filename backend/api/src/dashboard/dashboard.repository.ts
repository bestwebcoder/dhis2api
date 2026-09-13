import { Inject, Injectable } from "@nestjs/common";
import type { DashboardTable } from "@dhis-sync/contracts";
import { DatabaseService } from "../database/database.service.js";

/** Headline counts. Scoped to one owner for a client, control-plane-wide for an admin. */
export interface ControlPlaneTotals {
  connections: number;
  healthyConnections: number;
  failedConnections: number;
  appliedTables: number;
  draftBlueprints: number;
  syncDefinitions: number;
  activeSyncDefinitions: number;
  activeSchedules: number;
  runsLast24h: number;
  failedRunsLast24h: number;
  accounts: number;
  administrators: number;
}

export interface NamedEntity {
  id: string;
  name: string;
  detail: string | null;
}

interface TableRow {
  id: string;
  schema_name: string;
  table_name: string;
  resource_name: string;
  is_mine: boolean;
  last_run_at: Date | null;
  last_run_status: string | null;
}

/**
 * The owner predicate every dashboard query carries. $1 is always the owner
 * filter: null for an administrator, an account id for a client.
 */
const OWNED = (alias: string) => `($1::uuid IS NULL OR ${alias}.created_by = $1::uuid)`;

@Injectable()
export class DashboardRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  /**
   * Every count carries the owner filter, so a client's headline numbers describe
   * their own control plane and nothing else. The two account counts collapse to
   * zero for a client rather than being filtered — how many operators exist is
   * not theirs to know, and the service does not put them on a client dashboard.
   */
  async totals(ownerId: string | null): Promise<ControlPlaneTotals> {
    const result = await this.database.query<Record<keyof ControlPlaneTotals, number>>(
      `SELECT
        (SELECT count(*)::int FROM dhis2_connections c WHERE ${OWNED("c")}) AS connections,
        (SELECT count(*)::int FROM dhis2_connections c WHERE ${OWNED("c")} AND c.last_test_status = 'healthy') AS "healthyConnections",
        (SELECT count(*)::int FROM dhis2_connections c WHERE ${OWNED("c")} AND c.last_test_status = 'failed') AS "failedConnections",
        (SELECT count(*)::int FROM schema_blueprints b WHERE ${OWNED("b")} AND b.status = 'applied') AS "appliedTables",
        (SELECT count(*)::int FROM schema_blueprints b WHERE ${OWNED("b")} AND b.status = 'draft') AS "draftBlueprints",
        (SELECT count(*)::int FROM sync_definitions d WHERE ${OWNED("d")}) AS "syncDefinitions",
        (SELECT count(*)::int FROM sync_definitions d WHERE ${OWNED("d")} AND d.is_active) AS "activeSyncDefinitions",
        (SELECT count(*)::int FROM sync_schedules sc JOIN sync_definitions d ON d.id = sc.sync_definition_id
          WHERE ${OWNED("d")} AND sc.is_active) AS "activeSchedules",
        (SELECT count(*)::int FROM sync_runs r JOIN sync_definitions d ON d.id = r.sync_definition_id
          WHERE ${OWNED("d")} AND r.queued_at > now() - interval '24 hours') AS "runsLast24h",
        (SELECT count(*)::int FROM sync_runs r JOIN sync_definitions d ON d.id = r.sync_definition_id
          WHERE ${OWNED("d")} AND r.queued_at > now() - interval '24 hours' AND r.status = 'failed') AS "failedRunsLast24h",
        (CASE WHEN $1::uuid IS NULL THEN (SELECT count(*)::int FROM users WHERE is_active) ELSE 0 END) AS accounts,
        (CASE WHEN $1::uuid IS NULL THEN (SELECT count(*)::int FROM users WHERE is_active AND role = 'admin') ELSE 0 END) AS administrators`,
      [ownerId]
    );
    const row = result.rows.at(0);
    if (!row) throw new Error("Control-plane totals returned no row");
    return row;
  }

  /**
   * The applied data tables, the account's own first. These are what a report
   * can be run against, so they are the client's view of the system.
   */
  async tables(ownerId: string | null, userId: string, limit = 25): Promise<DashboardTable[]> {
    const result = await this.database.query<TableRow>(
      `SELECT b.id, b.schema_name, b.table_name, s.resource_name,
        COALESCE(b.created_by = $2, false) AS is_mine,
        latest.finished_at AS last_run_at, latest.status AS last_run_status
       FROM schema_blueprints b
       JOIN metadata_snapshots s ON s.id = b.snapshot_id
       LEFT JOIN LATERAL (
         SELECT r.status, r.finished_at
         FROM sync_definitions d
         JOIN sync_runs r ON r.sync_definition_id = d.id
         WHERE d.blueprint_id = b.id
         ORDER BY r.queued_at DESC LIMIT 1
       ) latest ON true
       WHERE b.status = 'applied' AND ($1::uuid IS NULL OR b.created_by = $1::uuid)
       ORDER BY is_mine DESC, s.resource_name
       LIMIT $3`,
      [ownerId, userId, limit]
    );
    return result.rows.map((row) => ({
      blueprintId: row.id,
      schemaName: row.schema_name,
      tableName: row.table_name,
      resourceName: row.resource_name,
      isMine: row.is_mine,
      lastRunAt: row.last_run_at?.toISOString() ?? null,
      lastRunStatus: row.last_run_status
    }));
  }

  /** Connections whose last credential test failed: every sync through them is stalled. */
  async failingConnections(ownerId: string | null, limit = 5): Promise<NamedEntity[]> {
    const result = await this.database.query<{ id: string; name: string; last_test_message: string | null }>(
      `SELECT c.id, c.name, c.last_test_message FROM dhis2_connections c
       WHERE c.last_test_status = 'failed' AND ${OWNED("c")}
       ORDER BY c.last_tested_at DESC NULLS LAST LIMIT $2`,
      [ownerId, limit]
    );
    return result.rows.map((row) => ({ id: row.id, name: row.name, detail: row.last_test_message }));
  }

  async failedRuns(ownerId: string | null, sinceHours = 24, limit = 5): Promise<NamedEntity[]> {
    const result = await this.database.query<{ id: string; name: string; error_summary: string | null }>(
      `SELECT r.id, d.name, r.error_summary
       FROM sync_runs r JOIN sync_definitions d ON d.id = r.sync_definition_id
       WHERE r.status IN ('failed', 'partially_succeeded')
         AND ${OWNED("d")}
         AND r.queued_at > now() - make_interval(hours => $2::int)
       ORDER BY r.queued_at DESC LIMIT $3`,
      [ownerId, sinceHours, limit]
    );
    return result.rows.map((row) => ({ id: row.id, name: row.name, detail: row.error_summary }));
  }

  /** Active schedules whose next run is well overdue: the poller is not keeping up, or is not running. */
  async stalledSchedules(ownerId: string | null, graceMinutes = 15, limit = 5): Promise<NamedEntity[]> {
    const result = await this.database.query<{ id: string; name: string; next_run_at: Date }>(
      `SELECT sc.id, d.name, sc.next_run_at
       FROM sync_schedules sc JOIN sync_definitions d ON d.id = sc.sync_definition_id
       WHERE sc.is_active AND ${OWNED("d")}
         AND sc.next_run_at < now() - make_interval(mins => $2::int)
       ORDER BY sc.next_run_at LIMIT $3`,
      [ownerId, graceMinutes, limit]
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      detail: `Was due at ${row.next_run_at.toISOString()}`
    }));
  }

  /** The account's own blueprints that were never applied, so no table exists yet. */
  async ownDraftBlueprints(userId: string, limit = 5): Promise<NamedEntity[]> {
    const result = await this.database.query<{ id: string; table_name: string; resource_name: string }>(
      `SELECT b.id, b.table_name, s.resource_name
       FROM schema_blueprints b JOIN metadata_snapshots s ON s.id = b.snapshot_id
       WHERE b.status = 'draft' AND b.created_by = $1
       ORDER BY b.created_at DESC LIMIT $2`,
      [userId, limit]
    );
    return result.rows.map((row) => ({ id: row.id, name: row.table_name, detail: row.resource_name }));
  }
}
