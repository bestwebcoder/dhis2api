import { Inject, Injectable } from "@nestjs/common";
import type { AuthUser, OwnershipCounts, UserRole, UserSummary } from "@dhis-sync/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service.js";

interface UserRow {
  id: string;
  email: string;
  name: string;
  organisation: string;
  role: UserRole;
  password_hash: string | null;
  google_subject: string | null;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
}

interface UserSummaryRow extends UserRow {
  created_by_name: string | null;
  owned_connections: number;
  owned_blueprints: number;
  owned_sync_definitions: number;
}

export interface StoredUser extends AuthUser {
  /** Null for an account that only signs in with Google. */
  passwordHash: string | null;
  /** The linked Google OpenID subject, or null when Google is not connected. */
  googleSubject: string | null;
  isActive: boolean;
}

export interface InsertUser {
  name: string;
  email: string;
  organisation: string;
  role: UserRole;
  /** Null only together with a googleSubject; the users_has_credential check enforces it. */
  passwordHash: string | null;
  googleSubject?: string | null;
  /** The administrator who provisioned this account; null for self sign-up. */
  createdBy?: string | null;
}

export interface AdminUpdate {
  name: string;
  organisation: string;
  role: UserRole;
  isActive: boolean;
}

/**
 * Why a write against the users table was refused. "last_admin" means the change
 * would have left the control plane with no active administrator, so nobody could
 * delete anything or manage accounts again.
 */
export type UserWriteOutcome = "ok" | "not_found" | "last_admin";

export interface UserWriteResult {
  outcome: UserWriteOutcome;
  user: StoredUser | null;
}

export interface UserDeleteResult {
  outcome: UserWriteOutcome;
  /** Rows that lost their created_by rather than being deleted with the account. */
  orphaned: OwnershipCounts;
  user: StoredUser | null;
}

const columnList = ["id", "email", "name", "organisation", "role", "password_hash", "google_subject", "is_active", "last_login_at", "created_at"] as const;
const columns = columnList.join(", ");
const aliased = (alias: string) => columnList.map((column) => `${alias}.${column}`).join(", ");

/**
 * Serialises every change that could affect the "at least one active admin"
 * invariant. Two administrators demoting each other at the same moment would
 * each see the other still standing without it; the lock is held to the end of
 * the transaction and only contends with other account writes.
 */
const ADMIN_FLOOR_LOCK = "7264150398412207";

function mapRow(row: UserRow): StoredUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    organisation: row.organisation,
    role: row.role,
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    passwordHash: row.password_hash,
    googleSubject: row.google_subject,
    isActive: row.is_active
  };
}

function mapSummary(row: UserSummaryRow): UserSummary {
  // neither the hash nor the Google subject leaves the API; only whether each exists
  const { passwordHash, googleSubject, ...user } = mapRow(row);
  return {
    ...user,
    signInMethods: { password: passwordHash !== null, google: googleSubject !== null },
    createdByName: row.created_by_name,
    owns: {
      connections: row.owned_connections,
      blueprints: row.owned_blueprints,
      syncDefinitions: row.owned_sync_definitions
    }
  };
}

const ownershipSelect = `
  (SELECT count(*)::int FROM dhis2_connections WHERE created_by = u.id) AS owned_connections,
  (SELECT count(*)::int FROM schema_blueprints WHERE created_by = u.id) AS owned_blueprints,
  (SELECT count(*)::int FROM sync_definitions WHERE created_by = u.id) AS owned_sync_definitions`;

@Injectable()
export class UserRepository {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async countAll(): Promise<number> {
    const result = await this.database.query<{ total: string }>("SELECT count(*)::text AS total FROM users");
    return Number(result.rows.at(0)?.total ?? 0);
  }

  async findByEmail(email: string): Promise<StoredUser | null> {
    const result = await this.database.query<UserRow>(`SELECT ${columns} FROM users WHERE email = $1`, [email]);
    const row = result.rows.at(0);
    return row ? mapRow(row) : null;
  }

  async findById(id: string): Promise<StoredUser | null> {
    const result = await this.database.query<UserRow>(`SELECT ${columns} FROM users WHERE id = $1`, [id]);
    const row = result.rows.at(0);
    return row ? mapRow(row) : null;
  }

  async list(): Promise<UserSummary[]> {
    const result = await this.database.query<UserSummaryRow>(
      `SELECT ${aliased("u")},
        creator.name AS created_by_name,
        ${ownershipSelect}
       FROM users u
       LEFT JOIN users creator ON creator.id = u.created_by
       ORDER BY u.created_at`
    );
    return result.rows.map(mapSummary);
  }

  async summaryById(id: string): Promise<UserSummary | null> {
    const result = await this.database.query<UserSummaryRow>(
      `SELECT ${aliased("u")},
        creator.name AS created_by_name,
        ${ownershipSelect}
       FROM users u
       LEFT JOIN users creator ON creator.id = u.created_by
       WHERE u.id = $1`,
      [id]
    );
    const row = result.rows.at(0);
    return row ? mapSummary(row) : null;
  }

  async ownershipFor(id: string): Promise<OwnershipCounts> {
    const result = await this.database.query<{ connections: number; blueprints: number; sync_definitions: number }>(
      `SELECT
        (SELECT count(*)::int FROM dhis2_connections WHERE created_by = $1) AS connections,
        (SELECT count(*)::int FROM schema_blueprints WHERE created_by = $1) AS blueprints,
        (SELECT count(*)::int FROM sync_definitions WHERE created_by = $1) AS sync_definitions`,
      [id]
    );
    const row = result.rows.at(0);
    return {
      connections: row?.connections ?? 0,
      blueprints: row?.blueprints ?? 0,
      syncDefinitions: row?.sync_definitions ?? 0
    };
  }

  async insert(input: InsertUser): Promise<StoredUser> {
    const result = await this.database.query<UserRow>(
      `INSERT INTO users (name, email, organisation, role, password_hash, google_subject, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${columns}`,
      [input.name, input.email, input.organisation, input.role, input.passwordHash, input.googleSubject ?? null, input.createdBy ?? null]
    );
    const row = result.rows.at(0);
    if (!row) throw new Error("Creating the user returned no row");
    return mapRow(row);
  }

  async findByGoogleSubject(subject: string): Promise<StoredUser | null> {
    const result = await this.database.query<UserRow>(`SELECT ${columns} FROM users WHERE google_subject = $1`, [subject]);
    const row = result.rows.at(0);
    return row ? mapRow(row) : null;
  }

  /**
   * Connects a Google identity to an account that has none, or already has this
   * one. False means a different Google identity was linked in the meantime; a
   * subject already linked to another account surfaces as a 23505.
   */
  async linkGoogle(id: string, subject: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE users SET google_subject = $2, updated_at = now()
       WHERE id = $1 AND (google_subject IS NULL OR google_subject = $2)`,
      [id, subject]
    );
    return Boolean(result.rowCount);
  }

  /**
   * Disconnects Google, but only from an account that still has a password —
   * checked in the same statement, so the account can never be left with no way in.
   */
  async unlinkGoogle(id: string): Promise<boolean> {
    const result = await this.database.query(
      "UPDATE users SET google_subject = NULL, updated_at = now() WHERE id = $1 AND password_hash IS NOT NULL",
      [id]
    );
    return Boolean(result.rowCount);
  }

  async touchLastLogin(id: string): Promise<string | null> {
    const result = await this.database.query<{ last_login_at: Date }>(
      "UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1 RETURNING last_login_at",
      [id]
    );
    return result.rows.at(0)?.last_login_at.toISOString() ?? null;
  }

  /**
   * The fields a user may change about themselves. Role and is_active are
   * absent on purpose: nobody promotes themselves or reopens their own account.
   * A duplicate email surfaces as a 23505 for the caller to translate.
   */
  async updateProfile(id: string, patch: { name: string; organisation: string; email: string }): Promise<StoredUser | null> {
    const result = await this.database.query<UserRow>(
      `UPDATE users SET name = $2, organisation = $3, email = $4, updated_at = now()
       WHERE id = $1 RETURNING ${columns}`,
      [id, patch.name, patch.organisation, patch.email]
    );
    const row = result.rows.at(0);
    return row ? mapRow(row) : null;
  }

  async updatePassword(id: string, passwordHash: string): Promise<boolean> {
    const result = await this.database.query(
      "UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1",
      [id, passwordHash]
    );
    return Boolean(result.rowCount);
  }

  /** Role and activation included, so it holds the admin-floor lock throughout. */
  async updateAsAdmin(id: string, patch: AdminUpdate): Promise<UserWriteResult> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_FLOOR_LOCK]);
      const existing = await client.query<UserRow>(`SELECT ${columns} FROM users WHERE id = $1 FOR UPDATE`, [id]);
      const before = existing.rows.at(0);
      if (!before) return { outcome: "not_found", user: null };
      const stillAdmin = patch.role === "admin" && patch.isActive;
      if (before.role === "admin" && before.is_active && !stillAdmin && !(await this.hasAnotherActiveAdmin(client, id))) {
        return { outcome: "last_admin", user: mapRow(before) };
      }
      const updated = await client.query<UserRow>(
        `UPDATE users SET name = $2, organisation = $3, role = $4, is_active = $5, updated_at = now()
         WHERE id = $1 RETURNING ${columns}`,
        [id, patch.name, patch.organisation, patch.role, patch.isActive]
      );
      const row = updated.rows.at(0);
      return { outcome: "ok", user: row ? mapRow(row) : null };
    });
  }

  /**
   * Removes the account. Everything it created survives with a null created_by
   * (the FKs are ON DELETE SET NULL), so deleting an operator never takes a
   * connection, blueprint or sync with it; the counts say what was let go.
   */
  async remove(id: string): Promise<UserDeleteResult> {
    return this.database.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock($1)", [ADMIN_FLOOR_LOCK]);
      const existing = await client.query<UserRow>(`SELECT ${columns} FROM users WHERE id = $1 FOR UPDATE`, [id]);
      const before = existing.rows.at(0);
      const empty: OwnershipCounts = { connections: 0, blueprints: 0, syncDefinitions: 0 };
      if (!before) return { outcome: "not_found", orphaned: empty, user: null };
      if (before.role === "admin" && before.is_active && !(await this.hasAnotherActiveAdmin(client, id))) {
        return { outcome: "last_admin", orphaned: empty, user: mapRow(before) };
      }
      // counted before the delete: afterwards the rows no longer point anywhere
      const owned = await client.query<{ connections: number; blueprints: number; sync_definitions: number }>(
        `SELECT
          (SELECT count(*)::int FROM dhis2_connections WHERE created_by = $1) AS connections,
          (SELECT count(*)::int FROM schema_blueprints WHERE created_by = $1) AS blueprints,
          (SELECT count(*)::int FROM sync_definitions WHERE created_by = $1) AS sync_definitions`,
        [id]
      );
      await client.query("DELETE FROM users WHERE id = $1", [id]);
      const counts = owned.rows.at(0);
      return {
        outcome: "ok",
        user: mapRow(before),
        orphaned: {
          connections: counts?.connections ?? 0,
          blueprints: counts?.blueprints ?? 0,
          syncDefinitions: counts?.sync_definitions ?? 0
        }
      };
    });
  }

  private async hasAnotherActiveAdmin(client: PoolClient, excludeId: string): Promise<boolean> {
    const result = await client.query<{ exists: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM users WHERE role = 'admin' AND is_active AND id <> $1) AS exists",
      [excludeId]
    );
    return result.rows.at(0)?.exists === true;
  }
}
