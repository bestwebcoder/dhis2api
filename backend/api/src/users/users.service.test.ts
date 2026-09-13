import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthUser, UserRole, UserSummary } from "@dhis-sync/contracts";
import type { AuditService } from "../common/audit.service.js";
import { PasswordService } from "../auth/password.service.js";
import type { StoredUser, UserRepository } from "../auth/user.repository.js";
import { UsersService } from "./users.service.js";

beforeAll(() => {
  process.env.DATABASE_URL ??= "postgresql://unused/unused";
  process.env.CONNECTION_ENCRYPTION_KEY ??= Buffer.alloc(32).toString("base64");
  process.env.AUTH_JWT_SECRET ??= "a-test-signing-secret-of-sufficient-length";
});

const ADMIN_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const actor: AuthUser = {
  id: ADMIN_ID,
  name: "Amina Yusuf",
  email: "amina@ministry.gov",
  organisation: "HMIS Unit",
  role: "admin",
  lastLoginAt: null,
  createdAt: "2026-09-01T00:00:00.000Z"
};

const stored = (overrides: Partial<StoredUser> = {}): StoredUser => ({
  id: OTHER_ID,
  name: "Kofi Mensah",
  email: "kofi@ministry.gov",
  organisation: "District Office",
  role: "client",
  lastLoginAt: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  passwordHash: "scrypt$32768$8$1$c2FsdA==$a2V5",
  isActive: true,
  ...overrides
});

const summary = (role: UserRole = "client"): UserSummary => ({
  id: OTHER_ID,
  name: "Kofi Mensah",
  email: "kofi@ministry.gov",
  organisation: "District Office",
  role,
  lastLoginAt: null,
  createdAt: "2026-09-02T00:00:00.000Z",
  isActive: true,
  createdByName: "Amina Yusuf",
  owns: { connections: 0, blueprints: 0, syncDefinitions: 0 }
});

/** A password service that does not pay scrypt's 160ms for tests that are not about hashing. */
const fastPasswords = {
  hash: async (password: string) => `hashed:${password}`,
  verify: async (password: string, hash: string) => hash === `hashed:${password}`
} as unknown as PasswordService;

function harness(repository: Partial<UserRepository>, passwords: PasswordService = fastPasswords) {
  const record = vi.fn(async () => undefined);
  const users = {
    list: async () => [],
    summaryById: async () => summary(),
    findById: async () => stored(),
    ownershipFor: async () => ({ connections: 0, blueprints: 0, syncDefinitions: 0 }),
    insert: async () => stored(),
    updateProfile: async () => stored(),
    updatePassword: async () => true,
    updateAsAdmin: async () => ({ outcome: "ok" as const, user: stored() }),
    remove: async () => ({ outcome: "ok" as const, user: stored(), orphaned: { connections: 0, blueprints: 0, syncDefinitions: 0 } }),
    ...repository
  } as unknown as UserRepository;
  const service = new UsersService(users, passwords, { record } as unknown as AuditService);
  return { service, record };
}

describe("provisioning accounts", () => {
  it("creates the account with the role the administrator chose and records who provisioned it", async () => {
    const insert = vi.fn(async () => stored({ role: "admin" }));
    const { service, record } = harness({ insert });
    await service.create(
      { name: "Kofi Mensah", email: "kofi@ministry.gov", organisation: " District Office ", role: "admin", password: "correct-horse" },
      actor
    );
    expect(insert.mock.calls.at(0)?.at(0)).toMatchObject({ role: "admin", organisation: "District Office", createdBy: ADMIN_ID });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "user.create", entityId: OTHER_ID }));
  });

  it("never writes the submitted password", async () => {
    const insert = vi.fn(async () => stored());
    const passwords = new PasswordService();
    const { service } = harness({ insert }, passwords);
    await service.create(
      { name: "Kofi Mensah", email: "kofi@ministry.gov", organisation: "", role: "client", password: "correct-horse" },
      actor
    );
    const written = insert.mock.calls.at(0)?.at(0) as unknown as { passwordHash: string };
    expect(written.passwordHash).not.toContain("correct-horse");
    expect(await passwords.verify("correct-horse", written.passwordHash)).toBe(true);
  });

  it("reports a duplicate email as a conflict", async () => {
    const { service } = harness({
      insert: async () => { throw Object.assign(new Error("duplicate key"), { code: "23505" }); }
    });
    await expect(service.create(
      { name: "Kofi Mensah", email: "kofi@ministry.gov", organisation: "", role: "client", password: "correct-horse" },
      actor
    )).rejects.toThrow(/already uses that email/);
  });
});

describe("changing someone's access", () => {
  it("refuses to let an administrator demote or disable themselves", async () => {
    const updateAsAdmin = vi.fn();
    const { service } = harness({ findById: async () => stored({ id: ADMIN_ID, role: "admin" }), updateAsAdmin });
    await expect(service.update(ADMIN_ID, { name: "Amina Yusuf", organisation: "HMIS Unit", role: "client", isActive: true }, actor))
      .rejects.toThrow(/cannot change your own role/);
    await expect(service.update(ADMIN_ID, { name: "Amina Yusuf", organisation: "HMIS Unit", role: "admin", isActive: false }, actor))
      .rejects.toThrow(/cannot change your own role or deactivate/);
    expect(updateAsAdmin).not.toHaveBeenCalled();
  });

  it("allows an administrator to edit their own name and organisation", async () => {
    const updateAsAdmin = vi.fn(async () => ({ outcome: "ok" as const, user: stored({ id: ADMIN_ID, role: "admin" }) }));
    const { service } = harness({
      findById: async () => stored({ id: ADMIN_ID, role: "admin" }),
      summaryById: async () => ({ ...summary("admin"), id: ADMIN_ID }),
      updateAsAdmin
    });
    await service.update(ADMIN_ID, { name: "A. Yusuf", organisation: "HMIS", role: "admin", isActive: true }, actor);
    expect(updateAsAdmin).toHaveBeenCalledOnce();
  });

  it("refuses a change that would leave nobody able to administer the control plane", async () => {
    const { service } = harness({ updateAsAdmin: async () => ({ outcome: "last_admin" as const, user: stored({ role: "admin" }) }) });
    await expect(service.update(OTHER_ID, { name: "Kofi Mensah", organisation: "", role: "client", isActive: true }, actor))
      .rejects.toThrow(/only active administrator/);
  });

  it("reports an unknown account as not found", async () => {
    const { service } = harness({ findById: async () => null });
    await expect(service.update(OTHER_ID, { name: "Kofi Mensah", organisation: "", role: "client", isActive: true }, actor))
      .rejects.toThrow(/Account not found/);
  });
});

describe("deleting an account", () => {
  it("is confirmed with the email, which names exactly one row", async () => {
    const remove = vi.fn();
    const { service } = harness({ remove });
    await expect(service.remove(OTHER_ID, "Kofi Mensah", actor)).rejects.toThrow("Type kofi@ministry.gov to confirm deleting this account. This cannot be undone.");
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses to delete the account making the request", async () => {
    const { service } = harness({ findById: async () => stored({ id: ADMIN_ID, email: actor.email, role: "admin" }) });
    await expect(service.remove(ADMIN_ID, actor.email, actor)).rejects.toThrow(/cannot delete the account you are signed in with/);
  });

  it("refuses to delete the last administrator", async () => {
    const { service } = harness({
      remove: async () => ({ outcome: "last_admin" as const, user: stored({ role: "admin" }), orphaned: { connections: 0, blueprints: 0, syncDefinitions: 0 } })
    });
    await expect(service.remove(OTHER_ID, "kofi@ministry.gov", actor)).rejects.toThrow(/only active administrator/);
  });

  it("keeps the work the account created and says what it let go", async () => {
    const { service, record } = harness({
      remove: async () => ({
        outcome: "ok" as const,
        user: stored(),
        orphaned: { connections: 2, blueprints: 0, syncDefinitions: 3 }
      })
    });
    const result = await service.remove(OTHER_ID, "kofi@ministry.gov", actor);
    expect(result).toEqual({ deleted: true, cascaded: {}, orphaned: { connections: 2, "sync definitions": 3 } });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: "user.delete", entityId: OTHER_ID }));
  });
});

describe("self service", () => {
  it("changes a password only when the current one is right and the new one differs", async () => {
    const updatePassword = vi.fn(async () => true);
    const { service } = harness({ findById: async () => stored({ id: ADMIN_ID, passwordHash: "hashed:correct-horse" }), updatePassword });
    await expect(service.changeOwnPassword(actor, { currentPassword: "guess", newPassword: "new-password" }))
      .rejects.toThrow(/current password is not correct/);
    await expect(service.changeOwnPassword(actor, { currentPassword: "correct-horse", newPassword: "correct-horse" }))
      .rejects.toThrow(/not already using/);
    await expect(service.changeOwnPassword(actor, { currentPassword: "correct-horse", newPassword: "new-password" }))
      .resolves.toEqual({ updated: true });
    expect(updatePassword).toHaveBeenCalledWith(ADMIN_ID, "hashed:new-password");
  });

  it("edits the caller's own row only, whatever id the body might carry", async () => {
    const updateProfile = vi.fn(async () => stored({ id: ADMIN_ID }));
    const { service } = harness({ updateProfile, summaryById: async () => ({ ...summary(), id: ADMIN_ID }) });
    await service.updateOwnProfile(actor, { name: "A. Yusuf", organisation: "" });
    expect(updateProfile).toHaveBeenCalledWith(ADMIN_ID, { name: "A. Yusuf", organisation: "Unassigned" });
  });
});
