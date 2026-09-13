import { describe, expect, it, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { AuthUser } from "@dhis-sync/contracts";
import { AccessScope } from "./access-scope.js";
import type { AuditService } from "./audit.service.js";
import { RunRegistry } from "./run-registry.service.js";
import { ConnectionService } from "../connections/connection.service.js";
import type { ConnectionRepository } from "../connections/connection.repository.js";
import type { SecretCipherService } from "../security/secret-cipher.service.js";
import type { UserRepository } from "../auth/user.repository.js";
import { SchemaService } from "../schema/schema.service.js";
import type { SchemaRepository } from "../schema/schema.repository.js";
import type { MetadataService } from "../metadata/metadata.service.js";
import { SyncService } from "../sync/sync.service.js";
import type { SyncRepository } from "../sync/sync.repository.js";
import { ReportService } from "../reports/report.service.js";
import { BackupService } from "../backups/backup.service.js";
import type { DatabaseService } from "../database/database.service.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";
const ROW_ID = "33333333-3333-4333-8333-333333333333";

const client: AuthUser = {
  id: CLIENT_ID,
  name: "Kofi Mensah",
  email: "kofi@ministry.gov",
  organisation: "District Office",
  role: "client",
  lastLoginAt: null,
  createdAt: "2026-09-01T00:00:00.000Z"
};

const scope = AccessScope.for(client);
const noAudit = { record: async () => undefined } as unknown as AuditService;

/** Every row these fakes return belongs to somebody else. */
const foreign = { ownerId: OTHER_ID, created_by: OTHER_ID };

function connectionService() {
  const repository = {
    findById: async () => ({ ...foreign, id: ROW_ID, name: "Demo", baseUrl: "https://x", role: "source", authType: "pat" }),
    list: vi.fn(async () => []),
    delete: vi.fn(async () => true),
    dependencies: async () => ({ syncDefinitions: [], blueprints: [] }),
    snapshotCount: async () => 0
  } as unknown as ConnectionRepository;
  const service = new ConnectionService(
    repository, {} as SecretCipherService, noAudit, {} as UserRepository
  );
  return { service, repository };
}

function schemaService() {
  const repository = {
    findById: async () => ({ ...foreign, id: ROW_ID, tableName: "tracker_anc", schemaName: "dhis_data", status: "applied", columns: [] }),
    list: vi.fn(async () => []),
    dropTable: vi.fn(),
    deleteBlueprint: vi.fn(),
    dependentSyncDefinitions: async () => []
  } as unknown as SchemaRepository;
  const service = new SchemaService({} as MetadataService, repository, noAudit, new RunRegistry());
  return { service, repository };
}

function syncService() {
  const repository = {
    find: async () => ({ ...foreign, id: ROW_ID, name: "ANC weekly", schema_name: "dhis_data", table_name: "tracker_anc" }),
    list: vi.fn(async () => []),
    blueprintOwner: async () => ({ ownerId: OTHER_ID }),
    updateDefinition: vi.fn(),
    upsertSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    clearRuns: vi.fn(),
    deleteDefinition: vi.fn(),
    createRun: vi.fn(),
    create: vi.fn()
  } as unknown as SyncRepository;
  const connections = { getSummary: async () => { throw new NotFoundException("Connection not found"); } } as unknown as ConnectionService;
  const service = new SyncService(repository, connections, new RunRegistry(), noAudit);
  return { service, repository };
}

/** A database whose every query comes back empty, recording what was bound. */
function fakeDatabase() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const database = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0, fields: [] };
    })
  } as unknown as DatabaseService;
  return { database, calls };
}

describe("a client cannot reach another account's endpoint", () => {
  it("is told it does not exist on every single-row route", async () => {
    const { service, repository } = connectionService();
    await expect(service.getSummary(ROW_ID, scope)).rejects.toThrow(NotFoundException);
    await expect(service.testSaved(ROW_ID, scope)).rejects.toThrow(NotFoundException);
    await expect(service.delete(ROW_ID, "Demo", scope)).rejects.toThrow(NotFoundException);
    // the refusal happens before anything is written
    expect(repository.delete).not.toHaveBeenCalled();
  });

  it("lists with its own id as the owner filter", async () => {
    const { service, repository } = connectionService();
    await service.list(scope);
    expect(repository.list).toHaveBeenCalledWith(CLIENT_ID);
  });
});

describe("a client cannot reach another account's blueprint", () => {
  it("is told it does not exist, and nothing is dropped or deleted", async () => {
    const { service, repository } = schemaService();
    await expect(service.apply(ROW_ID, scope)).rejects.toThrow(NotFoundException);
    await expect(service.update(ROW_ID, { columns: [] }, scope)).rejects.toThrow(NotFoundException);
    await expect(service.dropTable(ROW_ID, "tracker_anc", true, scope)).rejects.toThrow(NotFoundException);
    await expect(service.deleteBlueprint(ROW_ID, "tracker_anc", scope)).rejects.toThrow(NotFoundException);
    expect(repository.dropTable).not.toHaveBeenCalled();
    expect(repository.deleteBlueprint).not.toHaveBeenCalled();
  });

  it("lists with its own id as the owner filter", async () => {
    const { service, repository } = schemaService();
    await service.list(scope);
    expect(repository.list).toHaveBeenCalledWith(CLIENT_ID);
  });
});

describe("a client cannot reach another account's sync", () => {
  it("is refused on every route, including the manual run", async () => {
    const { service, repository } = syncService();
    await expect(service.update(ROW_ID, { name: "x" } as never, scope)).rejects.toThrow(NotFoundException);
    await expect(service.schedule(ROW_ID, {} as never, scope)).rejects.toThrow(NotFoundException);
    await expect(service.deleteSchedule(ROW_ID, scope)).rejects.toThrow(NotFoundException);
    await expect(service.clearRuns(ROW_ID, scope)).rejects.toThrow(NotFoundException);
    await expect(service.delete(ROW_ID, "ANC weekly", scope)).rejects.toThrow(NotFoundException);
    await expect(service.run(ROW_ID, "manual", undefined, scope)).rejects.toThrow(NotFoundException);
    expect(repository.deleteDefinition).not.toHaveBeenCalled();
    expect(repository.createRun).not.toHaveBeenCalled();
  });

  it("cannot aim a new sync at a blueprint it does not own", async () => {
    const { service, repository } = syncService();
    await expect(service.create(
      { name: "Mine", blueprintId: ROW_ID, sourceConnectionId: ROW_ID } as never, scope
    )).rejects.toThrow(NotFoundException);
    expect(repository.create).not.toHaveBeenCalled();
  });
});

describe("a client's data reads are filtered in SQL, not in memory", () => {
  it("binds the owner filter on every report query", async () => {
    const { database, calls } = fakeDatabase();
    const reports = new ReportService(database);
    await reports.list(scope);
    await expect(reports.data(ROW_ID, {}, scope)).rejects.toThrow(NotFoundException);
    expect(calls).not.toHaveLength(0);
    for (const call of calls) {
      expect(call.sql).toContain("b.created_by");
      expect(call.values).toContain(CLIENT_ID);
    }
  });

  it("binds the owner filter before touching a backup's rows", async () => {
    const { database, calls } = fakeDatabase();
    const backups = new BackupService(database);
    await expect(backups.years(ROW_ID, scope)).rejects.toThrow(NotFoundException);
    await expect(backups.data(ROW_ID, scope)).rejects.toThrow(NotFoundException);
    expect(calls.every((call) => call.values.includes(CLIENT_ID))).toBe(true);
  });

  it("scopes every table in a configuration backup, not just the connections", async () => {
    const { database, calls } = fakeDatabase();
    const backups = new BackupService(database);
    await backups.configuration(scope);
    expect(calls).toHaveLength(6);
    for (const call of calls) expect(call.values).toEqual([CLIENT_ID]);
  });
});
