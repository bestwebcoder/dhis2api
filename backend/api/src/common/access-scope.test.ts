import { describe, expect, it } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { AuthUser, UserRole } from "@dhis-sync/contracts";
import { AccessScope } from "./access-scope.js";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const account = (role: UserRole, id: string): AuthUser => ({
  id,
  name: role === "admin" ? "Amina Yusuf" : "Kofi Mensah",
  email: `${role}@ministry.gov`,
  organisation: "HMIS Unit",
  role,
  lastLoginAt: null,
  createdAt: "2026-09-01T00:00:00.000Z"
});

const admin = AccessScope.for(account("admin", OTHER_ID));
const client = AccessScope.for(account("client", CLIENT_ID));

describe("an administrator's scope", () => {
  it("lifts the owner filter entirely", () => {
    expect(admin.isAdmin).toBe(true);
    expect(admin.ownerFilter).toBeNull();
  });

  it("can see every row, including rows nobody owns", () => {
    expect(admin.canSee(CLIENT_ID)).toBe(true);
    expect(admin.canSee(null)).toBe(true);
    expect(() => admin.assertOwns(CLIENT_ID, "missing")).not.toThrow();
    expect(() => admin.assertOwns(null, "missing")).not.toThrow();
  });
});

describe("a client's scope", () => {
  it("binds their own id as the owner filter", () => {
    expect(client.isAdmin).toBe(false);
    expect(client.ownerFilter).toBe(CLIENT_ID);
  });

  it("sees their own rows and nothing else", () => {
    expect(client.canSee(CLIENT_ID)).toBe(true);
    expect(client.canSee(OTHER_ID)).toBe(false);
    expect(() => client.assertOwns(CLIENT_ID, "missing")).not.toThrow();
  });

  it("cannot see a row that belongs to nobody", () => {
    // an unowned row predates the boundary; only an administrator may reach it
    expect(client.canSee(null)).toBe(false);
    expect(() => client.assertOwns(null, "missing")).toThrow(NotFoundException);
    expect(() => client.assertOwns(undefined, "missing")).toThrow(NotFoundException);
  });

  it("reports another account's row as missing, never as forbidden", () => {
    // a 403 would confirm the row exists, turning the API into an oracle for
    // enumerating other accounts' data by guessing UUIDs
    let thrown: unknown;
    try {
      client.assertOwns(OTHER_ID, "Connection not found");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect((thrown as NotFoundException).getStatus()).toBe(404);
    expect((thrown as NotFoundException).message).toBe("Connection not found");
  });
});
