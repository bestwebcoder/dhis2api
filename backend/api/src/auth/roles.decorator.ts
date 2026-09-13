import { SetMetadata } from "@nestjs/common";
import type { UserRole } from "@dhis-sync/contracts";

export const REQUIRED_ROLES = "auth:requiredRoles";

/**
 * Restricts a route to the listed roles. Without it a route is open to every
 * signed-in account, so destructive endpoints must opt in explicitly.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(REQUIRED_ROLES, roles);
