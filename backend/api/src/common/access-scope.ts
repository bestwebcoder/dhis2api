import { NotFoundException } from "@nestjs/common";
import type { AuthUser } from "@dhis-sync/contracts";

/**
 * Which rows this caller is allowed to see.
 *
 * An administrator is unrestricted. A client sees only rows they own, which is
 * every read and every write: the same object is invisible, unreadable and
 * unmodifiable to them, with no way to tell those apart.
 *
 * `ownerFilter` is the single value repositories bind: null means "no filter",
 * so one query shape serves both roles and there is no second, unfiltered code
 * path that could be reached by mistake.
 */
export class AccessScope {
  private constructor(readonly user: AuthUser) {}

  static for(user: AuthUser): AccessScope {
    return new AccessScope(user);
  }

  get userId(): string {
    return this.user.id;
  }

  get isAdmin(): boolean {
    return this.user.role === "admin";
  }

  /** Bind this into `(owner IS NOT DISTINCT FROM $n OR $n IS NULL)`-shaped predicates. */
  get ownerFilter(): string | null {
    return this.isAdmin ? null : this.user.id;
  }

  /**
   * Guards a row that has already been loaded by id.
   *
   * Deliberately a 404 and never a 403: a client who guesses another client's
   * UUID must not be able to tell an object that exists from one that does not,
   * or the API becomes an oracle for enumerating other accounts' data. A row
   * with no owner at all is equally invisible to a client.
   */
  assertOwns(ownerId: string | null | undefined, notFoundMessage: string): void {
    if (this.isAdmin) return;
    if (!ownerId || ownerId !== this.user.id) throw new NotFoundException(notFoundMessage);
  }

  /** True when the caller may see a row with this owner; for filtering in memory. */
  canSee(ownerId: string | null | undefined): boolean {
    return this.isAdmin || (Boolean(ownerId) && ownerId === this.user.id);
  }
}
