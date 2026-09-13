import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { UserRole } from "@dhis-sync/contracts";
import type { AuthenticatedRequest } from "./auth.guard.js";
import { REQUIRED_ROLES } from "./roles.decorator.js";

const ARTICLE: Record<UserRole, string> = { admin: "an administrator", client: "a client" };

/**
 * Runs after AuthGuard has put the resolved account on the request, so it can
 * trust request.user. Registered globally but inert on routes with no @Roles.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[]>(REQUIRED_ROLES, [context.getHandler(), context.getClass()]);
    if (!required?.length) return true;
    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) {
      // @Roles on a @Public route: fail closed rather than let it through unchecked
      throw new ForbiddenException("This endpoint requires a signed-in account.");
    }
    if (!required.includes(user.role)) {
      const allowed = required.map((role) => ARTICLE[role]).join(" or ");
      throw new ForbiddenException(`This action requires ${allowed} account. You are signed in as ${ARTICLE[user.role]}.`);
    }
    return true;
  }
}
