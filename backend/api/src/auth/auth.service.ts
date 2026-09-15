import { ConflictException, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import type { AuthSession, AuthUser, GoogleAuthInput, SignInInput, SignUpInput } from "@dhis-sync/contracts";
import { getConfig } from "../config.js";
import { GoogleOAuthService } from "./google-oauth.service.js";
import { PasswordService } from "./password.service.js";
import { TokenService } from "./token.service.js";
import { UserRepository, type InsertUser, type StoredUser } from "./user.repository.js";

const UNIQUE_VIOLATION = "23505";
/** Verified against when no account matches, so a wrong email costs the same as a wrong password. */
const DECOY_HASH = "scrypt$32768$8$1$Z0ZBTEtFU0FMVEZBS0VTQQ==$0000000000000000000000000000000000000000000000000000000000000000000000000000000000000A==";

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

function isUniqueViolation(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && (cause as { code?: string }).code === UNIQUE_VIOLATION;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(UserRepository) private readonly users: UserRepository,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(TokenService) private readonly tokens: TokenService,
    @Inject(GoogleOAuthService) private readonly google: GoogleOAuthService
  ) {}

  async register(input: SignUpInput): Promise<AuthSession> {
    const passwordHash = await this.passwords.hash(input.password);
    let created: StoredUser;
    try {
      created = await this.createSelfServiceAccount({
        name: input.name,
        email: input.email,
        organisation: input.organisation.trim() || "Unassigned",
        passwordHash
      });
    } catch (cause) {
      if (isUniqueViolation(cause)) throw new ConflictException("An account already uses that email. Sign in instead.");
      throw cause;
    }
    return this.issue(created);
  }

  async login(input: SignInInput): Promise<AuthSession> {
    const user = await this.users.findByEmail(input.email);
    // a Google-only account has no hash: it fails like a wrong password, at the same cost
    const matches = await this.passwords.verify(input.password, user?.passwordHash ?? DECOY_HASH);
    if (!user || !matches) {
      throw new UnauthorizedException("That email and password do not match an account.");
    }
    return this.admit(user);
  }

  /**
   * Sign-in and sign-up through Google are one call: a linked identity signs in,
   * an unknown one becomes a new account under the same rules as register.
   *
   * An existing account with the same email is refused rather than linked. The
   * hub never verifies the email behind a password account, so linking on a
   * matching address would let whoever registered victim@example.org first keep
   * a password into the account its real owner later opens with Google. Linking
   * happens only from a signed-in session (UsersService.linkGoogle). Naming the
   * address in the refusal is no enumeration oracle: the caller has just proved
   * to Google that they own it.
   */
  async signInWithGoogle(input: GoogleAuthInput): Promise<AuthSession> {
    const identity = await this.google.exchange(input);
    const linked = await this.users.findByGoogleSubject(identity.subject);
    if (linked) return this.admit(linked);

    if (await this.users.findByEmail(identity.email)) {
      throw new ConflictException(
        `An account already uses ${identity.email}. Sign in with your password, then connect Google from your profile.`
      );
    }
    let created: StoredUser;
    try {
      created = await this.createSelfServiceAccount({
        name: identity.name,
        email: identity.email,
        organisation: "Unassigned",
        passwordHash: null,
        googleSubject: identity.subject
      });
    } catch (cause) {
      // a concurrent sign-up took the email or the subject between the checks and the insert
      if (isUniqueViolation(cause)) throw new ConflictException("That account was just created. Sign in again.");
      throw cause;
    }
    const lastLoginAt = await this.users.touchLastLogin(created.id);
    return this.issue({ ...created, lastLoginAt });
  }

  /** Resolves the bearer token's subject, so a deleted or deactivated account loses access before its token expires. */
  async resolveActiveUser(id: string): Promise<AuthUser> {
    const user = await this.users.findById(id);
    if (!user) throw new UnauthorizedException("Your account no longer exists. Sign in again.");
    if (!user.isActive) throw new ForbiddenException("This account has been deactivated.");
    return publicUser(user);
  }

  /** Every self-service creation path, password or Google, obeys the same sign-up rules. */
  private async createSelfServiceAccount(account: Omit<InsertUser, "role" | "createdBy">): Promise<StoredUser> {
    const isFirstUser = (await this.users.countAll()) === 0;
    if (!isFirstUser && !getConfig().AUTH_ALLOW_SIGNUP) {
      throw new ForbiddenException("Self-service sign-up is disabled on this deployment. Ask an administrator for an account.");
    }
    // whoever bootstraps the control plane owns it; everyone after is a client
    return this.users.insert({ ...account, role: isFirstUser ? "admin" : "client" });
  }

  private async admit(user: StoredUser): Promise<AuthSession> {
    if (!user.isActive) {
      throw new ForbiddenException("This account has been deactivated. Ask an administrator to restore it.");
    }
    const lastLoginAt = await this.users.touchLastLogin(user.id);
    return this.issue({ ...user, lastLoginAt });
  }

  private issue(user: StoredUser): AuthSession {
    const { token, expiresAt } = this.tokens.sign({ sub: user.id, email: user.email, role: user.role });
    return { token, expiresAt, user: publicUser(user) };
  }
}
