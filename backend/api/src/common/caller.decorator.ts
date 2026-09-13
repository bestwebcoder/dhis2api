import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { AuthenticatedRequest } from "../auth/auth.guard.js";
import { AccessScope } from "./access-scope.js";

/**
 * The caller as an AccessScope: who they are, and which rows they may touch.
 * Built from the account AuthGuard resolved, so it cannot be spoofed by a body
 * or query parameter.
 */
export const Caller = createParamDecorator((_data: unknown, context: ExecutionContext): AccessScope => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (!request.user) throw new Error("Caller used on a route the AuthGuard did not protect");
  return AccessScope.for(request.user);
});
