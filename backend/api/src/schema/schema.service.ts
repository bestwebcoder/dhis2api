import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  DeletionResult,
  GenerateBlueprintInput,
  SchemaBlueprintSummary,
  TableDropResult,
  UpdateBlueprintInput
} from "@dhis-sync/contracts";
import type { AccessScope } from "../common/access-scope.js";
import { AuditService } from "../common/audit.service.js";
import { rejectDanglingReferences, requireConfirmation, summarise } from "../common/deletion.js";
import { RunRegistry } from "../common/run-registry.service.js";
import { MetadataService } from "../metadata/metadata.service.js";
import { generateColumns, tableNameFor } from "./schema-generator.js";
import { SchemaRepository } from "./schema.repository.js";

const list = (names: string[]) => names.join(", ");
const NOT_FOUND = "Schema blueprint not found";

@Injectable()
export class SchemaService {
  constructor(
    @Inject(MetadataService) private readonly metadata: MetadataService,
    @Inject(SchemaRepository) private readonly repository: SchemaRepository,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(RunRegistry) private readonly runs: RunRegistry
  ) {}

  list(scope: AccessScope): Promise<SchemaBlueprintSummary[]> {
    return this.repository.list(scope.ownerFilter);
  }

  /** Loads a blueprint the caller is allowed to see, or reports it as missing. */
  private async owned(id: string, scope: AccessScope): Promise<SchemaBlueprintSummary> {
    const existing = await this.repository.findById(id);
    if (!existing) throw new NotFoundException(NOT_FOUND);
    scope.assertOwns(existing.ownerId, NOT_FOUND);
    return existing;
  }

  async generate(input: GenerateBlueprintInput, scope: AccessScope): Promise<SchemaBlueprintSummary> {
    // discover() re-checks that the caller owns the endpoint this metadata comes from
    const snapshot = await this.metadata.discover(input, scope);
    const columns = generateColumns(input.resourceType, snapshot.metadata, input.strategy);
    if (columns.length <= 1) throw new BadRequestException("No schema fields were found in the DHIS2 metadata");
    const tableName = tableNameFor(snapshot.resourceName, snapshot.resourceUid);
    const conflicts = await this.repository.conflictingOwners("dhis_data", tableName, scope.userId);
    if (conflicts.length) {
      // table names are derived from the DHIS2 resource, so two accounts pointed
      // at the same server would otherwise share one physical table
      throw new ConflictException(
        `${list(conflicts)} already owns the table ${tableName} for this DHIS2 resource. ` +
        "Two accounts cannot share one data table; ask an administrator to give you that blueprint instead."
      );
    }
    return this.repository.create({
      snapshotId: snapshot.id,
      tableName,
      strategy: input.strategy,
      columns,
      createdBy: scope.userId
    });
  }

  async apply(id: string, scope: AccessScope): Promise<SchemaBlueprintSummary> {
    const existing = await this.owned(id, scope);
    if (existing.status === "retired") throw new BadRequestException("A retired blueprint cannot be applied");
    return this.repository.apply(id);
  }

  async update(id: string, input: UpdateBlueprintInput, scope: AccessScope): Promise<SchemaBlueprintSummary> {
    const existing = await this.owned(id, scope);
    const existingNames = new Set(existing.columns.map((column) => column.columnName));
    if (input.columns.some((column) => !existingNames.has(column.columnName))) {
      throw new BadRequestException("The update contains a column that does not belong to this blueprint");
    }
    return this.repository.updateColumns(id, input.columns);
  }

  /**
   * Drops the generated data table. Everything downstream of it goes too, which
   * is why it needs an explicit cascade: a sync definition without its table is
   * not something the rest of the system can run.
   */
  async dropTable(id: string, confirmation: unknown, cascadeDependencies: boolean, scope: AccessScope): Promise<TableDropResult> {
    const existing = await this.owned(id, scope);
    requireConfirmation(confirmation, existing.tableName, "data table");
    const result = await this.repository.dropTable(id, {
      cascade: cascadeDependencies,
      runningDefinitionIds: this.runs.snapshot()
    });
    if (result.outcome === "not_found") throw new NotFoundException(NOT_FOUND);
    if (result.outcome === "blocked_by_dependencies") {
      throw new ConflictException(
        `${result.dependencies.length} sync definition(s) write into this table (${list(result.dependencies)}). ` +
        "Re-send with cascade=true to remove them along with their schedules and run history."
      );
    }
    if (result.outcome === "blocked_by_running") {
      throw new ConflictException(
        `${list(result.dependencies)} is running right now. Wait for the run to finish before dropping the table it writes into.`
      );
    }
    await this.audit.record({
      actor: scope.user,
      action: "schema.drop_table",
      entityType: "schema_blueprint",
      entityId: id,
      before: { table: `${existing.schemaName}.${existing.tableName}`, dependencies: result.dependencies },
      after: { cascaded: result.cascaded, retiredBlueprints: result.retiredBlueprints }
    });
    return {
      dropped: true,
      deletedSyncDefinitions: result.cascaded["sync definitions"] ?? 0,
      cascaded: summarise(result.cascaded)
    };
  }

  /**
   * Removes a blueprint that has no table of its own. The applied table is not
   * dropped as a side effect of deleting the description of it — that is the
   * explicit, separately confirmed action above.
   */
  async deleteBlueprint(id: string, confirmation: unknown, scope: AccessScope): Promise<DeletionResult> {
    const existing = await this.owned(id, scope);
    requireConfirmation(confirmation, existing.tableName, "schema blueprint");
    if (existing.status === "applied") {
      throw new BadRequestException("Drop the applied data table before deleting its blueprint");
    }
    const dependents = await this.repository.dependentSyncDefinitions(id);
    if (dependents.length) {
      throw new ConflictException(
        `Delete the sync definition(s) using this blueprint first: ${list(dependents.map((dependent) => dependent.name))}.`
      );
    }
    const result = await rejectDanglingReferences("schema blueprint", () => this.repository.deleteBlueprint(id));
    if (!result.deleted) throw new NotFoundException(NOT_FOUND);
    await this.audit.record({
      actor: scope.user,
      action: "schema.delete_blueprint",
      entityType: "schema_blueprint",
      entityId: id,
      before: { table: `${existing.schemaName}.${existing.tableName}`, status: existing.status, version: existing.version }
    });
    return {
      deleted: true,
      cascaded: summarise({
        "schema columns": result.deletedColumns,
        // only when no other version of the blueprint still points at it
        "metadata snapshots": result.deletedSnapshots
      }),
      orphaned: {}
    };
  }
}
