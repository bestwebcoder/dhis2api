import { describe, expect, it } from "vitest";
import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import type { AuthUser, UserRole } from "@dhis-sync/contracts";
import { Roles } from "./roles.decorator.js";
import { RolesGuard } from "./roles.guard.js";

const user = (role: UserRole): AuthUser => ({
  id: "9f2b6c0e-2f4e-4f1a-9c4b-0b1d2e3f4a5b",
  name: "Amina Yusuf",
  email: "amina@ministry.gov",
  organisation: "HMIS Unit",
  role,
  lastLoginAt: null,
  createdAt: "2026-09-01T00:00:00.000Z"
});

/** Mirrors how Nest reads @Roles: metadata on the handler, the request from the HTTP context. */
function contextFor(handler: () => void, current: AuthUser | undefined): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => ({ headers: {}, user: current }) })
  } as unknown as ExecutionContext;
}

class Endpoints {
  @Roles("admin")
  adminOnly() {}

  @Roles("admin", "analyst")
  eitherRole() {}

  open() {}
}

const guard = new RolesGuard(new Reflector());
const endpoints = new Endpoints();

describe("role enforcement", () => {
  it("lets an admin through a route reserved for admins", () => {
    expect(guard.canActivate(contextFor(endpoints.adminOnly, user("admin")))).toBe(true);
  });

  it("refuses an analyst and says what the action needs", () => {
    expect(() => guard.canActivate(contextFor(endpoints.adminOnly, user("analyst"))))
      .toThrow("This action requires an administrator account. You are signed in as an analyst.");
  });

  it("stays inert on a route with no @Roles, whatever the role", () => {
    expect(guard.canActivate(contextFor(endpoints.open, user("analyst")))).toBe(true);
    expect(guard.canActivate(contextFor(endpoints.open, user("admin")))).toBe(true);
  });

  it("accepts any of several listed roles", () => {
    expect(guard.canActivate(contextFor(endpoints.eitherRole, user("analyst")))).toBe(true);
    expect(guard.canActivate(contextFor(endpoints.eitherRole, user("admin")))).toBe(true);
  });

  it("fails closed when a restricted route somehow has no resolved account", () => {
    expect(() => guard.canActivate(contextFor(endpoints.adminOnly, undefined)))
      .toThrow("This endpoint requires a signed-in account.");
  });
});
