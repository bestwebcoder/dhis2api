import { Inject, Injectable } from "@nestjs/common";
import type { AuthUser, UserRole } from "@dhis-sync/contracts";
import { DatabaseService } from "../database/database.service.js";

interface UserRow {
  id: string;
  email: string;
  name: string;
  organisation: string;
  role: UserRole;
  password_hash: string;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
}

export interface StoredUser extends AuthUser {
  passwordHash: string;
  isActive: boolean;
}

export interface InsertUser {
  name: string;
  email: string;
  organisation: string;
  role: UserRole;
  passwordHash: string;
}

const columns = "id, email, name, organisation, role, password_hash, is_active, last_login_at, created_at";

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
    isActive: row.is_active
  };
}

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

  async insert(input: InsertUser): Promise<StoredUser> {
    const result = await this.database.query<UserRow>(
      `INSERT INTO users (name, email, organisation, role, password_hash)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${columns}`,
      [input.name, input.email, input.organisation, input.role, input.passwordHash]
    );
    const row = result.rows.at(0);
    if (!row) throw new Error("Creating the user returned no row");
    return mapRow(row);
  }

  async touchLastLogin(id: string): Promise<string | null> {
    const result = await this.database.query<{ last_login_at: Date }>(
      "UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1 RETURNING last_login_at",
      [id]
    );
    return result.rows.at(0)?.last_login_at.toISOString() ?? null;
  }
}
