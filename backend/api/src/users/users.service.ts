import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type {
  AuthUser,
  ChangePasswordInput,
  CreateUserInput,
  DeletionResult,
  GoogleAuthInput,
  UpdateProfileInput,
  UpdateUserInput,
  UserSummary
} from "@dhis-sync/contracts";
import { GoogleOAuthService } from "../auth/google-oauth.service.js";
import { PasswordService } from "../auth/password.service.js";
import { UserRepository, type StoredUser, type UserWriteOutcome } from "../auth/user.repository.js";
import { AuditService } from "../common/audit.service.js";
import { requireConfirmation, summarise } from "../common/deletion.js";

const UNIQUE_VIOLATION = "23505";

/**
 * The control plane cannot be left without an administrator, and an
 * administrator cannot remove their own access by accident. Both rules produce
 * the same advice: ask someone else, or deactivate instead of deleting.
 */
const LAST_ADMIN = "This is the only active administrator. Promote another account first, or the control plane would be left with nobody who can manage it.";

@Injectable()
export class UsersService {
  constructor(
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(GoogleOAuthService) private readonly google: GoogleOAuthService
  ) {}

  list(): Promise<UserSummary[]> {
    return this.users.list();
  }

  async find(id: string): Promise<UserSummary> {
    const user = await this.users.summaryById(id);
    if (!user) throw new NotFoundException("Account not found");
    return user;
  }

  /**
   * Provisioning by an administrator, which is deliberately not subject to
   * AUTH_ALLOW_SIGNUP: closing self-service sign-up is what makes this the way
   * accounts are created, and the role is chosen here rather than inferred.
   */
  async create(input: CreateUserInput, actor: AuthUser): Promise<UserSummary> {
    const passwordHash = await this.passwords.hash(input.password);
    let created: StoredUser;
    try {
      created = await this.users.insert({
        name: input.name,
        email: input.email,
        organisation: input.organisation.trim() || "Unassigned",
        role: input.role,
        passwordHash,
        createdBy: actor.id
      });
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && (cause as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictException("An account already uses that email.");
      }
      throw cause;
    }
    await this.audit.record({
      actor,
      action: "user.create",
      entityType: "user",
      entityId: created.id,
      after: { email: created.email, role: created.role, organisation: created.organisation }
    });
    return this.find(created.id);
  }

  async update(id: string, input: UpdateUserInput, actor: AuthUser): Promise<UserSummary> {
    const before = await this.users.findById(id);
    if (!before) throw new NotFoundException("Account not found");
    if (id === actor.id && (input.role !== before.role || !input.isActive)) {
      // an admin demoting or disabling themselves locks the door behind them
      throw new ForbiddenException("You cannot change your own role or deactivate your own account. Ask another administrator.");
    }
    const result = await this.users.updateAsAdmin(id, {
      name: input.name,
      organisation: input.organisation.trim() || "Unassigned",
      role: input.role,
      isActive: input.isActive
    });
    this.assertWritten(result.outcome);
    await this.audit.record({
      actor,
      action: "user.update",
      entityType: "user",
      entityId: id,
      before: { role: before.role, isActive: before.isActive, organisation: before.organisation },
      after: { role: input.role, isActive: input.isActive, organisation: input.organisation }
    });
    return this.find(id);
  }

  /**
   * Deleting an account is confirmed with its email rather than its name: two
   * people can share a name, and the confirmation has to name exactly one row.
   */
  async remove(id: string, confirmation: unknown, actor: AuthUser): Promise<DeletionResult> {
    const before = await this.users.findById(id);
    if (!before) throw new NotFoundException("Account not found");
    requireConfirmation(confirmation, before.email, "account");
    if (id === actor.id) {
      throw new ForbiddenException("You cannot delete the account you are signed in with. Ask another administrator.");
    }
    const result = await this.users.remove(id);
    this.assertWritten(result.outcome);
    await this.audit.record({
      actor,
      action: "user.delete",
      entityType: "user",
      entityId: id,
      before: { email: before.email, name: before.name, role: before.role, organisation: before.organisation }
    });
    return {
      deleted: true,
      cascaded: {},
      // the account's work outlives it; created_by simply becomes null
      orphaned: summarise({
        connections: result.orphaned.connections,
        "schema blueprints": result.orphaned.blueprints,
        "sync definitions": result.orphaned.syncDefinitions
      })
    };
  }

  /** The caller's own profile, including what they own. Never another account's. */
  readOwnProfile(actor: AuthUser): Promise<UserSummary> {
    return this.find(actor.id);
  }

  /**
   * Editing your own profile. Name and organisation are free to change; the
   * email is the credential you sign in with, so changing it costs the current
   * password — otherwise an unattended session could quietly move the account
   * to an address its owner does not control.
   *
   * The session survives a change of email: tokens carry the account id, and
   * AuthGuard resolves the subject by id on every request.
   */
  async updateOwnProfile(actor: AuthUser, input: UpdateProfileInput): Promise<UserSummary> {
    const stored = await this.users.findById(actor.id);
    if (!stored) throw new NotFoundException("Your account no longer exists. Sign in again.");

    const emailChanged = input.email !== stored.email;
    if (emailChanged) {
      if (stored.passwordHash === null) {
        throw new BadRequestException("Your account signs in with Google and has no password to confirm a new email with. Ask an administrator to change it.");
      }
      if (!input.currentPassword) {
        throw new BadRequestException("Enter your current password to change the email you sign in with.");
      }
      if (!await this.passwords.verify(input.currentPassword, stored.passwordHash)) {
        throw new BadRequestException("Your current password is not correct.");
      }
    }

    let updated: StoredUser | null;
    try {
      updated = await this.users.updateProfile(actor.id, {
        name: input.name,
        organisation: input.organisation.trim() || "Unassigned",
        email: input.email
      });
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && (cause as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictException("An account already uses that email.");
      }
      throw cause;
    }
    if (!updated) throw new NotFoundException("Your account no longer exists. Sign in again.");

    // only worth an audit entry when the sign-in identity moved
    if (emailChanged) {
      await this.audit.record({
        actor,
        action: "user.change_email",
        entityType: "user",
        entityId: actor.id,
        before: { email: stored.email },
        after: { email: updated.email }
      });
    }
    return this.find(actor.id);
  }

  async changeOwnPassword(actor: AuthUser, input: ChangePasswordInput): Promise<{ updated: true }> {
    const stored = await this.users.findById(actor.id);
    if (!stored) throw new NotFoundException("Your account no longer exists. Sign in again.");
    if (stored.passwordHash === null) {
      throw new BadRequestException("Your account signs in with Google and has no password to change.");
    }
    if (!await this.passwords.verify(input.currentPassword, stored.passwordHash)) {
      throw new BadRequestException("Your current password is not correct.");
    }
    if (input.newPassword === input.currentPassword) {
      throw new BadRequestException("Choose a password you are not already using.");
    }
    await this.users.updatePassword(actor.id, await this.passwords.hash(input.newPassword));
    await this.audit.record({ actor, action: "user.password_change", entityType: "user", entityId: actor.id });
    return { updated: true };
  }

  /**
   * Adds Google as a way into the caller's own account. The Google account's
   * verified email must be the account's email: a signed-in session alone is
   * not enough, or anyone at an unattended desk could attach their own Google
   * account and keep a way in after the owner changes their password. Matching
   * the address means only the owner of that mailbox can ever link it.
   */
  async linkGoogle(actor: AuthUser, input: GoogleAuthInput): Promise<UserSummary> {
    const identity = await this.google.exchange(input);
    const stored = await this.users.findById(actor.id);
    if (!stored) throw new NotFoundException("Your account no longer exists. Sign in again.");
    if (stored.googleSubject === identity.subject) return this.find(actor.id);
    if (stored.googleSubject !== null) {
      throw new ConflictException("Your account is already connected to a different Google account. Disconnect it first.");
    }
    if (identity.email !== stored.email) {
      throw new BadRequestException(
        `That Google account is ${identity.email}, but you sign in here as ${stored.email}. Choose the Google account with the same address.`
      );
    }
    let linked: boolean;
    try {
      linked = await this.users.linkGoogle(actor.id, identity.subject);
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && (cause as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictException("That Google account is already connected to another account on this hub.");
      }
      throw cause;
    }
    if (!linked) {
      throw new ConflictException("Your account is already connected to a different Google account. Disconnect it first.");
    }
    await this.audit.record({ actor, action: "user.google_link", entityType: "user", entityId: actor.id, after: { googleEmail: identity.email } });
    return this.find(actor.id);
  }

  async unlinkGoogle(actor: AuthUser): Promise<UserSummary> {
    const stored = await this.users.findById(actor.id);
    if (!stored) throw new NotFoundException("Your account no longer exists. Sign in again.");
    if (stored.googleSubject === null) return this.find(actor.id);
    // the repository re-checks the password in the UPDATE itself; this is the readable refusal
    if (stored.passwordHash === null || !await this.users.unlinkGoogle(actor.id)) {
      throw new BadRequestException("Google is the only way into this account, so it cannot be disconnected.");
    }
    await this.audit.record({ actor, action: "user.google_unlink", entityType: "user", entityId: actor.id });
    return this.find(actor.id);
  }

  private assertWritten(outcome: UserWriteOutcome): void {
    if (outcome === "not_found") throw new NotFoundException("Account not found");
    if (outcome === "last_admin") throw new ConflictException(LAST_ADMIN);
  }
}
