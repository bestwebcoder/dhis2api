import { describe, expect, it, vi } from "vitest";
import type { AuthUser, SchemaBlueprintSummary } from "@dhis-sync/contracts";
import type { AuditService } from "../common/audit.service.js";
import { AccessScope } from "../common/access-scope.js";
import { RunRegistry } from "../common/run-registry.service.js";
import type { MetadataService } from "../metadata/metadata.service.js";
import type { DropTableOutcome, SchemaRepository } from "./schema.repository.js";
import { SchemaService } from "./schema.service.js";

const BLUEPRINT_ID = "33333333-3333-4333-8333-333333333333";
const SYNC_ID = "44444444-4444-4444-8444-444444444444";

const adminUser: AuthUser = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Amina Yusuf",
  email: "amina@ministry.gov",
  organisation: "HMIS Unit",
  role: "admin",
  lastLoginAt: null,
  createdAt: "2026-09-01T00:00:00.000Z"
};

/** An administrator: unrestricted, so these tests exercise the delete rules alone. */
const actor = AccessScope.for(adminUser);

const blueprint = (overrides: Partial<SchemaBlueprintSummary> = {}): SchemaBlueprintSummary => ({
  id: BLUEPRINT_ID,
  snapshotId: "55555555-5555-4555-8555-555555555555",
  resourceName: "Antenatal care",
  resourceType: "program",
  schemaName: "dhis_data",
  tableName: "tracker_antenatal_care",
  strategy: "flattened_latest",
  status: "applied",
  version: 1,
  generatedBy: "rules",
  appliedAt: "2026-09-03T00:00:00.000Z",
  createdAt: "2026-09-02T00:00:00.000Z",
  columns: [],
  sqlPreview: null,
  ...overrides
} as SchemaBlueprintSummary);

const dropped = (overrides: Partial<DropTableOutcome> = {}): DropTableOutcome => ({
  outcome: "dropped",
  dependencies: [],
  cascaded: { "sync definitions": 0, schedules: 0, "run history": 0, cursors: 0 },
  retiredBlueprints: 1,
  ...overrides
});

function harness(repository: Partial<SchemaRepository>, runs = new RunRegistry()) {
  const record = vi.fn(async () => undefined);
  const repo = {
    findById: async () => blueprint(),
    dropTable: async () => dropped(),
    dependentSyncDefinitions: async () => [],
    deleteBlueprint: async () => ({ deleted: true, deletedSnapshots: 0, deletedColumns: 0 }),
    ...repository
  } as unknown as SchemaRepository;
  const service = new SchemaService({} as MetadataService, repo, { record } as unknown as AuditService, runs);
  return { service, record, runs };
}

describe("dropping a data table", () => {
  it("will not drop anything until the table name is typed back", async () => {
    const dropTable = vi.fn();
    const { service } = harness({ dropTable });
    await expect(service.dropTable(BLUEPRINT_ID, "tracker_antenatal", false, actor))
      .rejects.toThrow("Type tracker_antenatal_care to confirm deleting this data table. This cannot be undone.");
    expect(dropTable).not.toHaveBeenCalled();
  });

  it("names the syncs in the way and asks for an explicit cascade", async () => {
    const { service } = harness({
      dropTable: async () => dropped({ outcome: "blocked_by_dependencies", dependencies: ["ANC weekly", "ANC monthly"] })
    });
    await expect(service.dropTable(BLUEPRINT_ID, "tracker_antenatal_care", false, actor))
      .rejects.toThrow(/2 sync definition\(s\) write into this table \(ANC weekly, ANC monthly\).*cascade=true/s);
  });

  it("refuses while a run is writing into the table", async () => {
    const runs = new RunRegistry();
    runs.begin(SYNC_ID);
    const { service } = harness({
      dropTable: async (_id, options) => {
        // the repository is handed the live set and matches it inside its transaction
        expect(options.runningDefinitionIds).toContain(SYNC_ID);
        return dropped({ outcome: "blocked_by_running", dependencies: ["ANC weekly"] });
      }
    }, runs);
    await expect(service.dropTable(BLUEPRINT_ID, "tracker_antenatal_care", true, actor))
      .rejects.toThrow(/ANC weekly is running right now/);
  });

  it("reports only what the cascade actually removed, and records the drop", async () => {
    const { service, record } = harness({
      dropTable: async () => dropped({
        dependencies: ["ANC weekly"],
        cascaded: { "sync definitions": 1, schedules: 1, "run history": 12, cursors: 0 }
      })
    });
    const result = await service.dropTable(BLUEPRINT_ID, "tracker_antenatal_care", true, actor);
    expect(result).toEqual({
      dropped: true,
      deletedSyncDefinitions: 1,
      cascaded: { "sync definitions": 1, schedules: 1, "run history": 12 }
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "schema.drop_table", entityId: BLUEPRINT_ID }));
  });

  it("reports a blueprint that disappeared mid-request as not found", async () => {
    const { service } = harness({ dropTable: async () => dropped({ outcome: "not_found" }) });
    await expect(service.dropTable(BLUEPRINT_ID, "tracker_antenatal_care", true, actor)).rejects.toThrow(/not found/);
  });
});

describe("deleting a blueprint", () => {
  it("will not delete the description of a table that still exists", async () => {
    const deleteBlueprint = vi.fn();
    const { service } = harness({ deleteBlueprint });
    await expect(service.deleteBlueprint(BLUEPRINT_ID, "tracker_antenatal_care", actor))
      .rejects.toThrow(/Drop the applied data table before deleting its blueprint/);
    expect(deleteBlueprint).not.toHaveBeenCalled();
  });

  it("names the syncs that must go first", async () => {
    const { service } = harness({
      findById: async () => blueprint({ status: "draft" }),
      dependentSyncDefinitions: async () => [{ id: SYNC_ID, name: "ANC weekly" }]
    });
    await expect(service.deleteBlueprint(BLUEPRINT_ID, "tracker_antenatal_care", actor))
      .rejects.toThrow(/Delete the sync definition\(s\) using this blueprint first: ANC weekly/);
  });

  it("says when the metadata snapshot went with it", async () => {
    const { service } = harness({
      findById: async () => blueprint({ status: "draft" }),
      deleteBlueprint: async () => ({ deleted: true, deletedSnapshots: 1, deletedColumns: 24 })
    });
    await expect(service.deleteBlueprint(BLUEPRINT_ID, "tracker_antenatal_care", actor)).resolves.toEqual({
      deleted: true,
      cascaded: { "schema columns": 24, "metadata snapshots": 1 },
      orphaned: {}
    });
  });

  it("keeps a snapshot another blueprint version still points at", async () => {
    const { service } = harness({
      findById: async () => blueprint({ status: "draft" }),
      deleteBlueprint: async () => ({ deleted: true, deletedSnapshots: 0, deletedColumns: 24 })
    });
    const result = await service.deleteBlueprint(BLUEPRINT_ID, "tracker_antenatal_care", actor);
    expect(result.cascaded).toEqual({ "schema columns": 24 });
  });
});
