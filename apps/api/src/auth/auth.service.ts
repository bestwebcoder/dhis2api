import { ConflictException, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { AuthSession, AuthUser, SignInInput, SignUpInput } from "@dhis-sync/contracts";
import { getConfig } from "../config.js";
import { PasswordService } from "./password.service.js";
import { TokenService } from "./token.service.js";
import { UserRepository, type StoredUser } from "./user.repository.js";

const UNIQUE_VIOLATION = "23505";
/** Verified against when no account matches, so a wrong email costs the same as a wrong password. */
const DECOY_HASH = "scrypt$131072$8$1$Z0ZBTEtFU0FMVEZBS0VTQQ==$0000000000000000000000000000000000000000000000000000000000000000000000000000000000000A==";

function publicUser(user: StoredUser): AuthUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    organisation: user.organisation,
    role: user.role,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt
  };
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(TokenService) private readonly tokens: TokenService
  ) {}

  async register(input: SignUpInput): Promise<AuthSession> {
    const isFirstUser = (await this.users.countAll()) === 0;
    if (!isFirstUser && !getConfig().AUTH_ALLOW_SIGNUP) {
      throw new ForbiddenException("Self-service sign-up is disabled on this deployment. Ask an administrator for an account.");
    }
    const passwordHash = await this.passwords.hash(input.password);
    let created: StoredUser;
    try {
      created = await this.users.insert({
        name: input.name,
        email: input.email,
        organisation: input.organisation.trim() || "Unassigned",
        // whoever bootstraps the control plane owns it; everyone after is an analyst
        role: isFirstUser ? "admin" : "analyst",
        passwordHash
      });
    } catch (cause) {
      if (typeof cause === "object" && cause !== null && (cause as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictException("An account already uses that email. Sign in instead.");
      }
      throw cause;
    }
    return this.issue(created);
  }

  async login(input: SignInInput): Promise<AuthSession> {
    const user = await this.users.findByEmail(input.email);
    const matches = await this.passwords.verify(input.password, user?.passwordHash ?? DECOY_HASH);
    if (!user || !matches) {
      throw new UnauthorizedException("That email and password do not match an account.");
    }
    if (!user.isActive) {
      throw new ForbiddenException("This account has been deactivated. Ask an administrator to restore it.");
    }
    const lastLoginAt = await this.users.touchLastLogin(user.id);
    return this.issue({ ...user, lastLoginAt });
  }

  /** Resolves the bearer token's subject, so a deleted or deactivated account loses access before its token expires. */
  async resolveActiveUser(id: string): Promise<AuthUser> {
    const user = await this.users.findById(id);
    if (!user) throw new UnauthorizedException("Your account no longer exists. Sign in again.");
    if (!user.isActive) throw new ForbiddenException("This account has been deactivated.");
    return publicUser(user);
  }

  private issue(user: StoredUser): AuthSession {
    const { token, expiresAt } = this.tokens.sign({ sub: user.id, email: user.email, role: user.role });
    return { token, expiresAt, user: publicUser(user) };
  }
}
