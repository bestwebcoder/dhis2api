import { Inject, Injectable } from "@nestjs/common";
import type {
  FlattenStrategy,
  ResourceType,
  SchemaBlueprintSummary,
  SchemaColumnPreview
} from "@dhis-sync/contracts";
import { DatabaseService } from "../database/database.service.js";
import { createTableSql, reconcileTableColumnsSql } from "./schema-generator.js";

/** What a drop of one blueprint's table did, or why it did nothing. */
export interface DropTableOutcome {
  outcome: "dropped" | "not_found" | "blocked_by_dependencies" | "blocked_by_running";
  /** Sync definition names: the blockers, or what the cascade removed. */
  dependencies: string[];
  cascaded: Record<string, number>;
  retiredBlueprints: number;
}

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

/** Identifiers reach the SQL as text, so nothing that fails this may be interpolated. */
function assertSafeIdentifiers(...identifiers: string[]): void {
  if (identifiers.some((identifier) => !SAFE_IDENTIFIER.test(identifier))) {
    throw new Error("Unsafe table identifier");
  }
}

interface BlueprintRow {
  id: string;
  snapshot_id: string;
  resource_name: string;
  resource_type: ResourceType;
  schema_name: string;
  table_name: string;
  strategy: FlattenStrategy;
  status: SchemaBlueprintSummary["status"];
  version: number;
  generated_by: SchemaBlueprintSummary["generatedBy"];
  applied_at: Date | null;
  created_at: Date;
  created_by: string | null;
}

interface ColumnRow {
  blueprint_id: string;
  ordinal: number;
  column_name: string;
  sql_type: string;
  source_kind: SchemaColumnPreview["sourceKind"];
  source_uid: string | null;
  stage_uid: string | null;
  repeat_policy: string | null;
  nullable: boolean;
  is_filterable: boolean;
  label: string;
  mapping: Record<string, unknown>;
}

function mapColumn(row: ColumnRow): SchemaColumnPreview {
  return {
    ordinal: row.ordinal,
    columnName: row.column_name,
    sqlType: row.sql_type,
    sourceKind: row.source_kind,
    sourceUid: row.source_uid,
    stageUid: row.stage_uid,
    repeatPolicy: row.repeat_policy,
    nullable: row.nullable,
    isFilterable: row.is_filterable,
    label: row.label,
    mapping: row.mapping
  };
}

function mapBlueprint(row: BlueprintRow, columns: SchemaColumnPreview[]): SchemaBlueprintSummary {
  return {
    id: row.id,
    snapshotId: row.snapshot_id,
    resourceName: row.resource_name,
    resourceType: row.resource_type,
    schemaName: row.schema_name,
    tableName: row.table_name,
    strategy: row.strategy,
    status: row.status,
    version: row.version,
    generatedBy: row.generated_by,
    columns,
    sqlPreview: createTableSql(row.schema_name, row.table_name, columns),
    createdAt: row.created_at.toISOString(),
    appliedAt: row.applied_at?.toISOString() ?? null,
    ownerId: row.created_by
  };
}

const blueprintSelect = `
  SELECT b.id, b.snapshot_id, s.resource_name, s.resource_type,
    b.schema_name, b.table_name, b.strategy, b.status, b.version,
    b.generated_by, b.applied_at, b.created_at, b.created_by
  FROM schema_blueprints b
  JOIN metadata_snapshots s ON s.id = b.snapshot_id`;

/** null lifts the restriction; anything else limits the result to that owner. */
const ownedBy = (parameter: string) => `(${parameter}::uuid IS NULL OR b.created_by = ${parameter}::uuid)`;

@Injectable()
export class SchemaRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private async columnsFor(ids: string[]): Promise<Map<string, SchemaColumnPreview[]>> {
    const byBlueprint = new Map<string, SchemaColumnPreview[]>();
    if (!ids.length) return byBlueprint;
    const result = await this.database.query<ColumnRow>(
      `SELECT blueprint_id, ordinal, column_name, sql_type, source_kind,
        source_uid, stage_uid, repeat_policy, nullable, is_filterable, label, mapping
      FROM schema_columns WHERE blueprint_id = ANY($1::uuid[]) ORDER BY ordinal`,
      [ids]
    );
    for (const row of result.rows) {
      const current = byBlueprint.get(row.blueprint_id) ?? [];
      current.push(mapColumn(row));
      byBlueprint.set(row.blueprint_id, current);
    }
    return byBlueprint;
  }

  async list(ownerId: string | null): Promise<SchemaBlueprintSummary[]> {
    const result = await this.database.query<BlueprintRow>(
      `${blueprintSelect} WHERE ${ownedBy("$1")} ORDER BY b.created_at DESC`,
      [ownerId]
    );
    const columns = await this.columnsFor(result.rows.map((row) => row.id));
    return result.rows.map((row) => mapBlueprint(row, columns.get(row.id) ?? []));
  }

  async findById(id: string): Promise<SchemaBlueprintSummary | null> {
    const result = await this.database.query<BlueprintRow>(`${blueprintSelect} WHERE b.id = $1`, [id]);
    const row = result.rows[0];
    if (!row) return null;
    const columns = await this.columnsFor([id]);
    return mapBlueprint(row, columns.get(id) ?? []);
  }

  /**
   * Who else already owns this physical table. Blueprint versions share one
   * table by design, so a second account generating the same deterministic name
   * would write into the first account's rows — the one place where API-level
   * isolation is not enough on its own.
   */
  async conflictingOwners(schemaName: string, tableName: string, ownerId: string): Promise<string[]> {
    const result = await this.database.query<{ name: string }>(
      `SELECT DISTINCT COALESCE(u.name, 'an unassigned blueprint') AS name
       FROM schema_blueprints b
       LEFT JOIN users u ON u.id = b.created_by
       WHERE b.schema_name = $1 AND b.table_name = $2
         AND b.created_by IS DISTINCT FROM $3`,
      [schemaName, tableName, ownerId]
    );
    return result.rows.map((row) => row.name);
  }

  async create(input: {
    snapshotId: string;
    tableName: string;
    strategy: FlattenStrategy;
    columns: SchemaColumnPreview[];
    createdBy: string | null;
  }): Promise<SchemaBlueprintSummary> {
    const id = await this.database.transaction(async (client) => {
      const versionResult = await client.query<{ version: number }>(
        `SELECT COALESCE(max(version), 0) + 1 AS version
         FROM schema_blueprints WHERE snapshot_id = $1 AND table_name = $2`,
        [input.snapshotId, input.tableName]
      );
      const version = versionResult.rows[0]?.version ?? 1;
      const blueprint = await client.query<{ id: string }>(
        `INSERT INTO schema_blueprints (
          snapshot_id, schema_name, table_name, strategy, version, generated_by, created_by
        ) VALUES ($1, 'dhis_data', $2, $3, $4, 'rules', $5) RETURNING id`,
        [input.snapshotId, input.tableName, input.strategy, version, input.createdBy]
      );
      const blueprintId = blueprint.rows[0]?.id;
      if (!blueprintId) throw new Error("Blueprint insert returned no row");
      for (const column of input.columns) {
        await client.query(
          `INSERT INTO schema_columns (
            blueprint_id, ordinal, column_name, sql_type, source_kind,
            source_uid, stage_uid, repeat_policy, nullable, is_filterable, label, mapping
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            blueprintId, column.ordinal, column.columnName, column.sqlType,
            column.sourceKind, column.sourceUid, column.stageUid, column.repeatPolicy,
            column.nullable, column.isFilterable, column.label, JSON.stringify(column.mapping)
          ]
        );
      }
      return blueprintId;
    });
    const created = await this.findById(id);
    if (!created) throw new Error("Created blueprint could not be loaded");
    return created;
  }

  async apply(id: string): Promise<SchemaBlueprintSummary> {
    const blueprint = await this.findById(id);
    if (!blueprint) throw new Error("Blueprint not found");
    await this.database.transaction(async (client) => {
      await client.query(blueprint.sqlPreview ?? createTableSql(blueprint.schemaName, blueprint.tableName, blueprint.columns));
      for (const statement of reconcileTableColumnsSql(blueprint.schemaName, blueprint.tableName, blueprint.columns)) {
        await client.query(statement);
      }
      await client.query(
        `UPDATE schema_blueprints SET status = 'applied', applied_at = now(), updated_at = now() WHERE id = $1`,
        [id]
      );
    });
    const applied = await this.findById(id);
    if (!applied) throw new Error("Applied blueprint could not be loaded");
    return applied;
  }

  async updateColumns(id: string, columns: { columnName: string; label: string; isFilterable: boolean }[]): Promise<SchemaBlueprintSummary> {
    await this.database.transaction(async (client) => {
      for (const column of columns) {
        await client.query(
          `UPDATE schema_columns SET label=$3, is_filterable=$4 WHERE blueprint_id=$1 AND column_name=$2`,
          [id, column.columnName, column.label.trim(), column.isFilterable]
        );
      }
      await client.query(`UPDATE schema_blueprints SET updated_at=now() WHERE id=$1`, [id]);
    });
    const updated = await this.findById(id);
    if (!updated) throw new Error("Updated blueprint could not be loaded");
    return updated;
  }

  /**
   * Drops the data table and everything the blueprint's identity implies.
   *
   * The dependency check lives inside the transaction that does the dropping:
   * checking first and dropping afterwards leaves a window in which a new sync
   * definition is created and then silently destroyed by a cascade nobody
   * consented to.
   *
   * Dependants are matched on schema_name/table_name rather than blueprint id
   * because every version of a blueprint describes the same physical table, and
   * that table is what is about to disappear.
   */
  async dropTable(id: string, options: { cascade: boolean; runningDefinitionIds: readonly string[] }): Promise<DropTableOutcome> {
    return this.database.transaction(async (client) => {
      const target = await client.query<{ schema_name: string; table_name: string }>(
        `SELECT schema_name, table_name FROM schema_blueprints WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const blueprint = target.rows[0];
      if (!blueprint) return { outcome: "not_found" as const, dependencies: [], cascaded: {}, retiredBlueprints: 0 };
      assertSafeIdentifiers(blueprint.schema_name, blueprint.table_name);

      const dependants = await client.query<{ id: string; name: string }>(
        `SELECT d.id, d.name FROM sync_definitions d
         JOIN schema_blueprints b ON b.id = d.blueprint_id
         WHERE b.schema_name = $1 AND b.table_name = $2
         ORDER BY d.name
         FOR UPDATE OF d`,
        [blueprint.schema_name, blueprint.table_name]
      );
      const names = dependants.rows.map((row) => row.name);
      if (names.length && !options.cascade) {
        return { outcome: "blocked_by_dependencies" as const, dependencies: names, cascaded: {}, retiredBlueprints: 0 };
      }
      const running = dependants.rows.filter((row) => options.runningDefinitionIds.includes(row.id));
      if (running.length) {
        return { outcome: "blocked_by_running" as const, dependencies: running.map((row) => row.name), cascaded: {}, retiredBlueprints: 0 };
      }

      const definitionIds = dependants.rows.map((row) => row.id);
      // counted before the delete: sync_schedules, sync_runs and sync_cursors
      // all cascade from sync_definitions, so afterwards there is nothing to count
      const collateral = await client.query<{ schedules: number; runs: number; cursors: number }>(
        `SELECT
          (SELECT count(*)::int FROM sync_schedules WHERE sync_definition_id = ANY($1::uuid[])) AS schedules,
          (SELECT count(*)::int FROM sync_runs WHERE sync_definition_id = ANY($1::uuid[])) AS runs,
          (SELECT count(*)::int FROM sync_cursors WHERE sync_definition_id = ANY($1::uuid[])) AS cursors`,
        [definitionIds]
      );
      const counts = collateral.rows[0];
      const deletedDefinitions = definitionIds.length
        ? (await client.query(`DELETE FROM sync_definitions WHERE id = ANY($1::uuid[])`, [definitionIds])).rowCount ?? 0
        : 0;
      // ACCESS EXCLUSIVE: a run that slipped past the check above blocks here and
      // then fails on the missing table rather than committing into a dropped one
      await client.query(`DROP TABLE IF EXISTS "${blueprint.schema_name}"."${blueprint.table_name}"`);
      const retired = await client.query(
        `UPDATE schema_blueprints SET status = 'retired', updated_at = now()
         WHERE schema_name = $1 AND table_name = $2 AND status <> 'retired'`,
        [blueprint.schema_name, blueprint.table_name]
      );
      return {
        outcome: "dropped" as const,
        dependencies: names,
        cascaded: {
          "sync definitions": deletedDefinitions,
          schedules: counts?.schedules ?? 0,
          "run history": counts?.runs ?? 0,
          cursors: counts?.cursors ?? 0
        },
        retiredBlueprints: retired.rowCount ?? 0
      };
    });
  }

  /** The sync definitions that would go if this blueprint's table were dropped. */
  async dependentSyncDefinitions(id: string): Promise<{ id: string; name: string }[]> {
    const result = await this.database.query<{ id: string; name: string }>(
      `SELECT d.id, d.name FROM sync_definitions d
       JOIN schema_blueprints dependency ON dependency.id = d.blueprint_id
       JOIN schema_blueprints target
         ON target.schema_name = dependency.schema_name AND target.table_name = dependency.table_name
       WHERE target.id = $1
       ORDER BY d.name`,
      [id]
    );
    return result.rows;
  }

  /**
   * Removes a blueprint that was never applied. The metadata snapshot goes too,
   * but only once no other blueprint version is still generated from it — the
   * returned count says whether that happened.
   */
  async deleteBlueprint(id: string): Promise<{ deleted: boolean; deletedSnapshots: number; deletedColumns: number }> {
    return this.database.transaction(async (client) => {
      const found = await client.query<{ snapshot_id: string }>(
        `SELECT snapshot_id FROM schema_blueprints WHERE id = $1 FOR UPDATE`,
        [id]
      );
      const snapshotId = found.rows[0]?.snapshot_id;
      if (!snapshotId) return { deleted: false, deletedSnapshots: 0, deletedColumns: 0 };
      const columns = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM schema_columns WHERE blueprint_id = $1`,
        [id]
      );
      await client.query(`DELETE FROM schema_blueprints WHERE id = $1`, [id]);
      const snapshots = await client.query(
        `DELETE FROM metadata_snapshots s WHERE s.id = $1
         AND NOT EXISTS (SELECT 1 FROM schema_blueprints b WHERE b.snapshot_id = s.id)`,
        [snapshotId]
      );
      return {
        deleted: true,
        deletedSnapshots: snapshots.rowCount ?? 0,
        deletedColumns: columns.rows[0]?.count ?? 0
      };
    });
  }
}
