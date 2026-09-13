import { Inject, Injectable } from "@nestjs/common";
import type {
  AuthType,
  ConnectionRole,
  ConnectionSummary,
  ConnectionTestResult,
  Dhis2Capabilities
} from "@dhis-sync/contracts";
import { DatabaseService } from "../database/database.service.js";
import type { EncryptedSecret } from "../security/secret-cipher.service.js";

interface ConnectionRow {
  id: string;
  name: string;
  role: ConnectionRole;
  base_url: string;
  auth_type: AuthType;
  encrypted_secret: Buffer;
  secret_iv: Buffer;
  secret_tag: Buffer;
  dhis2_version: string | null;
  system_name: string | null;
  capabilities: Dhis2Capabilities | Record<string, never>;
  last_test_status: "untested" | "healthy" | "failed";
  last_test_message: string | null;
  last_tested_at: Date | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  created_by: string | null;
  owner_name: string | null;
}

export interface StoredConnection extends ConnectionSummary, EncryptedSecret {}

export interface InsertConnection {
  name: string;
  role: ConnectionRole;
  baseUrl: string;
  authType: AuthType;
  encryptedSecret: EncryptedSecret;
  test: ConnectionTestResult | null;
  /** The account that added this connection; null once that account is deleted. */
  createdBy?: string | null;
}

export interface UpdateConnection extends InsertConnection { id: string; isActive: boolean; }

export interface ConnectionDependencies {
  syncDefinitions: string[];
  blueprints: string[];
}

const columns = `
  c.id, c.name, c.role, c.base_url, c.auth_type, c.encrypted_secret, c.secret_iv, c.secret_tag,
  c.dhis2_version, c.system_name, c.capabilities, c.last_test_status, c.last_test_message,
  c.last_tested_at, c.is_active, c.created_at, c.updated_at, c.created_by,
  owner.name AS owner_name`;

/** Every read goes through this, so a client cannot reach an endpoint they do not own. */
const from = "FROM dhis2_connections c LEFT JOIN users owner ON owner.id = c.created_by";

/** null lifts the restriction; anything else limits the result to that owner. */
const ownedBy = (parameter: string) => `(${parameter}::uuid IS NULL OR c.created_by = ${parameter}::uuid)`;

function mapRow(row: ConnectionRow): StoredConnection {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    baseUrl: row.base_url,
    authType: row.auth_type,
    dhis2Version: row.dhis2_version,
    systemName: row.system_name,
    capabilities: row.capabilities,
    lastTestStatus: row.last_test_status,
    lastTestMessage: row.last_test_message,
    lastTestedAt: row.last_tested_at?.toISOString() ?? null,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    ownerId: row.created_by,
    ownerName: row.owner_name,
    ciphertext: row.encrypted_secret,
    iv: row.secret_iv,
    tag: row.secret_tag
  };
}

@Injectable()
export class ConnectionRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(ownerId: string | null): Promise<StoredConnection[]> {
    const result = await this.database.query<ConnectionRow>(
      `SELECT ${columns} ${from} WHERE ${ownedBy("$1")} ORDER BY c.created_at DESC`,
      [ownerId]
    );
    return result.rows.map(mapRow);
  }

  /**
   * Unfiltered by design: callers load the row and then hand it to
   * AccessScope.assertOwns, which is also what lets the sync runner open a
   * connection on behalf of a schedule that no request is driving.
   */
  async findById(id: string): Promise<StoredConnection | null> {
    const result = await this.database.query<ConnectionRow>(
      `SELECT ${columns} ${from} WHERE c.id = $1`,
      [id]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  /** Admin-only: hand an endpoint to a client account, or take it back with null. */
  async setOwner(id: string, ownerId: string | null): Promise<StoredConnection | null> {
    const result = await this.database.query<ConnectionRow>(
      `WITH updated AS (
         UPDATE dhis2_connections SET created_by = $2, updated_at = now() WHERE id = $1 RETURNING id
       )
       SELECT ${columns} ${from} WHERE c.id IN (SELECT id FROM updated)`,
      [id, ownerId]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findByName(name: string): Promise<StoredConnection | null> {
    const result = await this.database.query<ConnectionRow>(
      `SELECT ${columns} ${from} WHERE lower(c.name) = lower($1) LIMIT 1`,
      [name.trim()]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async insert(input: InsertConnection): Promise<StoredConnection> {
    const test = input.test;
    const result = await this.database.query<ConnectionRow>(
      `INSERT INTO dhis2_connections (
        name, role, base_url, auth_type, encrypted_secret, secret_iv, secret_tag,
        dhis2_version, system_name, current_user_summary, capabilities,
        last_test_status, last_test_message, last_tested_at, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      RETURNING id`,
      [
        input.name,
        input.role,
        input.baseUrl,
        input.authType,
        input.encryptedSecret.ciphertext,
        input.encryptedSecret.iv,
        input.encryptedSecret.tag,
        test?.dhis2Version ?? null,
        test?.systemName ?? null,
        test?.currentUser ? JSON.stringify(test.currentUser) : null,
        JSON.stringify(test?.capabilities ?? {}),
        test ? "healthy" : "untested",
        test?.message ?? null,
        test?.testedAt ?? null,
        input.createdBy ?? null
      ]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Connection insert returned no row");
    return this.reload(id, "Connection insert returned no row");
  }

  async update(input: UpdateConnection): Promise<StoredConnection> {
    const test = input.test;
    const result = await this.database.query<ConnectionRow>(
      `UPDATE dhis2_connections SET name=$2, role=$3, base_url=$4, auth_type=$5,
       encrypted_secret=$6, secret_iv=$7, secret_tag=$8, is_active=$9,
       dhis2_version=$10, system_name=$11, current_user_summary=$12, capabilities=$13,
       last_test_status=$14, last_test_message=$15, last_tested_at=$16, updated_at=now()
       WHERE id=$1 RETURNING id`,
      [input.id, input.name, input.role, input.baseUrl, input.authType,
       input.encryptedSecret.ciphertext, input.encryptedSecret.iv, input.encryptedSecret.tag, input.isActive,
       test?.dhis2Version ?? null, test?.systemName ?? null,
       test?.currentUser ? JSON.stringify(test.currentUser) : null, JSON.stringify(test?.capabilities ?? {}),
       test ? "healthy" : "untested", test?.message ?? null, test?.testedAt ?? null]
    );
    const id = result.rows[0]?.id;
    if (!id) throw new Error("Connection not found");
    return this.reload(id, "Connection not found");
  }

  async recordTest(id: string, test: ConnectionTestResult): Promise<StoredConnection> {
    const result = await this.database.query<ConnectionRow>(
      `UPDATE dhis2_connections SET
        base_url = $2,
        dhis2_version = $3,
        system_name = $4,
        current_user_summary = $5,
        capabilities = $6,
        last_test_status = 'healthy',
        last_test_message = $7,
        last_tested_at = $8,
        updated_at = now()
      WHERE id = $1
      RETURNING id`,
      [
        id,
        test.normalizedBaseUrl,
        test.dhis2Version,
        test.systemName,
        test.currentUser ? JSON.stringify(test.currentUser) : null,
        JSON.stringify(test.capabilities),
        test.message,
        test.testedAt
      ]
    );
    const updatedId = result.rows[0]?.id;
    if (!updatedId) throw new Error("Connection not found");
    return this.reload(updatedId, "Connection not found");
  }

  /** Re-reads through the owner-joined select so every returned row is shaped alike. */
  private async reload(id: string, missing: string): Promise<StoredConnection> {
    const found = await this.findById(id);
    if (!found) throw new Error(missing);
    return found;
  }

  async recordFailure(id: string, message: string): Promise<void> {
    await this.database.query(
      `UPDATE dhis2_connections SET
        last_test_status = 'failed', last_test_message = $2,
        last_tested_at = now(), updated_at = now()
      WHERE id = $1`,
      [id, message]
    );
  }

  /**
   * What still points at this connection. Names rather than counts, because the
   * caller has to go and deal with each one before the connection can go.
   */
  async dependencies(id: string): Promise<ConnectionDependencies> {
    const result = await this.database.query<{ sync_definitions: string[]; blueprints: string[] }>(
      `SELECT
        (SELECT coalesce(array_agg(d.name ORDER BY d.name), '{}')
           FROM sync_definitions d
          WHERE d.source_connection_id = $1 OR d.destination_connection_id = $1) AS sync_definitions,
        (SELECT coalesce(array_agg(b.table_name ORDER BY b.table_name), '{}')
           FROM schema_blueprints b JOIN metadata_snapshots s ON s.id = b.snapshot_id
          WHERE s.connection_id = $1) AS blueprints`,
      [id]
    );
    const row = result.rows[0];
    return { syncDefinitions: row?.sync_definitions ?? [], blueprints: row?.blueprints ?? [] };
  }

  /**
   * Metadata snapshots cascade with the connection (they are a copy of its
   * metadata and mean nothing without it); everything else is refused upstream.
   */
  async snapshotCount(id: string): Promise<number> {
    const result = await this.database.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM metadata_snapshots WHERE connection_id = $1",
      [id]
    );
    return result.rows[0]?.count ?? 0;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.database.query(`DELETE FROM dhis2_connections WHERE id=$1`, [id]);
    return Boolean(result.rowCount);
  }
}
