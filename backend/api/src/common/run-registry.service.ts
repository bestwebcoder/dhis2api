import { Injectable } from "@nestjs/common";

/**
 * The sync definitions running right now in this process.
 *
 * SyncService owns the lifecycle; other modules read it so they can refuse to
 * destroy something a run is in the middle of using — dropping a data table
 * while a run holds its staging swap would leave both in an unknown state.
 *
 * In-memory on purpose, and therefore accurate only for a single API replica —
 * the same constraint the scheduler already carries (see sync.service.ts).
 */
@Injectable()
export class RunRegistry {
  private readonly running = new Set<string>();

  /** Claims the definition, or returns false when a run already holds it. */
  begin(definitionId: string): boolean {
    if (this.running.has(definitionId)) return false;
    this.running.add(definitionId);
    return true;
  }

  end(definitionId: string): void {
    this.running.delete(definitionId);
  }

  isRunning(definitionId: string): boolean {
    return this.running.has(definitionId);
  }

  /** Of the given definitions, the ones a run currently holds. */
  runningAmong(definitionIds: readonly string[]): string[] {
    return definitionIds.filter((id) => this.running.has(id));
  }

  snapshot(): string[] {
    return [...this.running];
  }
}
