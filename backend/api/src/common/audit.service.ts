import { Inject, Injectable, Logger } from "@nestjs/common";
import type { AuthUser, DashboardActivity } from "@dhis-sync/contracts";
import type { PoolClient } from "pg";
import { DatabaseService } from "../database/database.service.js";

export interface AuditEntry {
  /** Null for the scheduler and other work no signed-in account triggered. */
  actor: AuthUser | null;
  action: string;
  entityType: string;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
}

interface ActivityRow {
  action: string;
  entity_type: string;
  entity_id: string | null;
  created_at: Date;
}

/**
 * The write path for audit_log. Destructive routes record what they removed and
 * who asked, so a dropped table can be traced back to an account after the fact.
 *
 * Pass the transaction client when the entry must live or die with the change
 * itself; without one the entry is written after the change has committed, and a
 * failure to write it is logged rather than rethrown — the deletion already
 * happened, and reporting it as failed would be a lie.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async record(entry: AuditEntry, client?: PoolClient): Promise<void> {
    const sql = `INSERT INTO audit_log (actor, actor_id, action, entity_type, entity_id, before_state, after_state)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`;
    const values = [
      entry.actor ? `${entry.actor.name} <${entry.actor.email}>` : "system",
      entry.actor?.id ?? null,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after)
    ];
    if (client) {
      await client.query(sql, values);
      return;
    }
    try {
      await this.database.query(sql, values);
    } catch (error) {
      this.logger.error(`Could not record ${entry.action} on ${entry.entityType} ${entry.entityId ?? "-"}`, error as Error);
    }
  }

  /** One account's own recent actions, for their dashboard. */
  async recentFor(actorId: string, limit = 8): Promise<DashboardActivity[]> {
    const result = await this.database.query<ActivityRow>(
      `SELECT action, entity_type, entity_id, created_at
       FROM audit_log WHERE actor_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [actorId, limit]
    );
    return result.rows.map((row) => ({
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      at: row.created_at.toISOString()
    }));
  }
}
