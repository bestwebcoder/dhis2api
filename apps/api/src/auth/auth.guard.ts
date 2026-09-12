import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AuthUser } from "@dhis-sync/contracts";
import { AuthService } from "./auth.service.js";
import { IS_PUBLIC } from "./public.decorator.js";
import { TokenService } from "./token.service.js";

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
}

/**
 * Registered as an APP_GUARD, so every controller is closed by default and a
 * new endpoint is protected without anyone remembering to protect it.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(AuthService) private readonly auth: AuthService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    const value = Array.isArray(header) ? header.at(0) : header;
    const [scheme, token] = value?.split(" ") ?? [];
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      throw new UnauthorizedException("Sign in to use this endpoint.");
    }
    const claims = this.tokens.verify(token);
    request.user = await this.auth.resolveActiveUser(claims.sub);
    return true;
  }
}
