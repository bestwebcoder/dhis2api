import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthUser } from "@dhis-sync/contracts";
import type { AuthenticatedRequest } from "./auth.guard.js";

/** The account the AuthGuard resolved for this request. */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext): AuthUser => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.user) throw new Error("CurrentUser used on a route the AuthGuard did not protect");
  return request.user;
});
