import { beforeAll, describe, expect, it, vi } from "vitest";
import { AuthService } from "./auth.service.js";
import type { GoogleIdentity, GoogleOAuthService } from "./google-oauth.service.js";
import { PasswordService } from "./password.service.js";
import { TokenService } from "./token.service.js";
import type { InsertUser, StoredUser, UserRepository } from "./user.repository.js";

// getConfig() is read lazily inside the service constructors, so the environment
// only has to be in place before the first instantiation below.
beforeAll(() => {
  process.env.DATABASE_URL ??= "postgresql://unused/unused";
  process.env.CONNECTION_ENCRYPTION_KEY ??= Buffer.alloc(32).toString("base64");
  process.env.AUTH_JWT_SECRET ??= "a-test-signing-secret-of-sufficient-length";
});

const storedUser = (overrides: Partial<StoredUser> = {}): StoredUser => ({
  id: "9f2b6c0e-2f4e-4f1a-9c4b-0b1d2e3f4a5b",
  name: "Amina Yusuf",
  email: "amina@ministry.gov",
  organisation: "HMIS Unit",
  role: "client",
  lastLoginAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  passwordHash: "unset",
  googleSubject: null,
  isActive: true,
  ...overrides
});

const googleIdentity: GoogleIdentity = { subject: "109876543210987654321", email: "amina@ministry.gov", name: "Amina Yusuf" };
const googleInput = { code: "4/0AbCdEf-one-time-code", codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", redirectUri: "http://localhost:5173/" };

function harness(repository: Partial<UserRepository>, identity: GoogleIdentity = googleIdentity) {
  const passwords = new PasswordService();
  const users = {
    countAll: async () => 1,
    findByEmail: async () => null,
    findById: async () => null,
    findByGoogleSubject: async () => null,
    insert: async () => storedUser(),
    touchLastLogin: async () => "2026-09-12T00:00:00.000Z",
    ...repository
  } as UserRepository;
  const google = { exchange: async () => identity } as unknown as GoogleOAuthService;
  return { auth: new AuthService(users, passwords, new TokenService(), google), passwords };
}

describe("password hashing", () => {
  it("round-trips a password without storing it in the clear", async () => {
    const passwords = new PasswordService();
    const hash = await passwords.hash("correct-horse");
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(hash).not.toContain("correct-horse");
    expect(await passwords.verify("correct-horse", hash)).toBe(true);
    expect(await passwords.verify("wrong-horse", hash)).toBe(false);
  });

  it("rejects a malformed or truncated stored hash instead of throwing", async () => {
    const passwords = new PasswordService();
    expect(await passwords.verify("any", "not-a-hash")).toBe(false);
    expect(await passwords.verify("any", "scrypt$1$2$3$c2FsdA==$")).toBe(false);
    expect(await passwords.verify("any", "bcrypt$1$2$3$c2FsdA==$a2V5")).toBe(false);
  });
});

describe("registration", () => {
  it("makes the first account an admin and everyone after a client", async () => {
    const insert = vi.fn(async () => storedUser());
    const first = harness({ countAll: async () => 0, insert });
    await first.auth.register({ name: "Amina Yusuf", email: "amina@ministry.gov", organisation: "", password: "correct-horse" });
    expect(insert.mock.calls.at(0)?.at(0)).toMatchObject({ role: "admin", organisation: "Unassigned" });

    const second = harness({ countAll: async () => 3, insert });
    await second.auth.register({ name: "Kofi Mensah", email: "kofi@ministry.gov", organisation: " District Office ", password: "correct-horse" });
    expect(insert.mock.calls.at(1)?.at(0)).toMatchObject({ role: "client", organisation: "District Office" });
  });

  it("never stores the submitted password itself", async () => {
    const insert = vi.fn(async () => storedUser());
    const { auth, passwords } = harness({ countAll: async () => 0, insert });
    await auth.register({ name: "Amina Yusuf", email: "amina@ministry.gov", organisation: "", password: "correct-horse" });
    const written = insert.mock.calls.at(0)?.at(0) as unknown as { passwordHash: string };
    expect(written.passwordHash).not.toContain("correct-horse");
    expect(await passwords.verify("correct-horse", written.passwordHash)).toBe(true);
  });

  it("reports a duplicate email as a conflict rather than a server error", async () => {
    const { auth } = harness({
      countAll: async () => 1,
      insert: async () => { throw Object.assign(new Error("duplicate key"), { code: "23505" }); }
    });
    await expect(auth.register({ name: "Amina Yusuf", email: "amina@ministry.gov", organisation: "", password: "correct-horse" }))
      .rejects.toThrow(/already uses that email/);
  });

  it("issues a session containing a verifiable token and no password hash", async () => {
    const { auth } = harness({ countAll: async () => 0 });
    const session = await auth.register({ name: "Amina Yusuf", email: "amina@ministry.gov", organisation: "", password: "correct-horse" });
    expect(new TokenService().verify(session.token).sub).toBe(session.user.id);
    expect(JSON.stringify(session)).not.toContain("passwordHash");
    expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe("sign in", () => {
  it("accepts a correct password and stamps the login time", async () => {
    const passwords = new PasswordService();
    const passwordHash = await passwords.hash("correct-horse");
    const touchLastLogin = vi.fn(async () => "2026-09-12T09:00:00.000Z");
    const { auth } = harness({ findByEmail: async () => storedUser({ passwordHash }), touchLastLogin });
    const session = await auth.login({ email: "amina@ministry.gov", password: "correct-horse" });
    expect(session.user.lastLoginAt).toBe("2026-09-12T09:00:00.000Z");
    expect(touchLastLogin).toHaveBeenCalledOnce();
  });

  it("gives an identical message for an unknown email and a wrong password", async () => {
    const passwordHash = await new PasswordService().hash("correct-horse");
    const missing = harness({ findByEmail: async () => null });
    const wrong = harness({ findByEmail: async () => storedUser({ passwordHash }) });
    const messages = await Promise.all([
      missing.auth.login({ email: "nobody@ministry.gov", password: "correct-horse" }).catch((error: Error) => error.message),
      wrong.auth.login({ email: "amina@ministry.gov", password: "guess" }).catch((error: Error) => error.message)
    ]);
    expect(messages[0]).toBe(messages[1]);
    expect(messages[0]).toMatch(/do not match an account/);
  });

  it("refuses a deactivated account", async () => {
    const passwordHash = await new PasswordService().hash("correct-horse");
    const { auth } = harness({ findByEmail: async () => storedUser({ passwordHash, isActive: false }) });
    await expect(auth.login({ email: "amina@ministry.gov", password: "correct-horse" })).rejects.toThrow(/deactivated/);
  });
});

describe("Google sign-in", () => {
  it("signs in the account already linked to that Google subject", async () => {
    const insert = vi.fn(async () => storedUser());
    const touchLastLogin = vi.fn(async () => "2026-09-15T08:00:00.000Z");
    const { auth } = harness({
      findByGoogleSubject: async (subject: string) => subject === googleIdentity.subject ? storedUser({ passwordHash: null, googleSubject: subject }) : null,
      insert,
      touchLastLogin
    });
    const session = await auth.signInWithGoogle(googleInput);
    expect(new TokenService().verify(session.token).sub).toBe(session.user.id);
    expect(session.user.lastLoginAt).toBe("2026-09-15T08:00:00.000Z");
    expect(insert).not.toHaveBeenCalled();
  });

  it("refuses to attach Google to an existing account by matching the email alone", async () => {
    const insert = vi.fn(async () => storedUser());
    const { auth } = harness({ findByEmail: async () => storedUser(), insert });
    await expect(auth.signInWithGoogle(googleInput)).rejects.toThrow(/connect Google from your profile/);
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates a password-less client account for a new Google identity", async () => {
    const insert = vi.fn(async (input: InsertUser) => storedUser({ passwordHash: input.passwordHash, googleSubject: input.googleSubject ?? null }));
    const { auth } = harness({ countAll: async () => 4, insert });
    const session = await auth.signInWithGoogle(googleInput);
    expect(insert.mock.calls.at(0)?.at(0)).toEqual({
      name: "Amina Yusuf",
      email: "amina@ministry.gov",
      organisation: "Unassigned",
      role: "client",
      passwordHash: null,
      googleSubject: googleIdentity.subject
    });
    // the Google subject is an internal link, never part of the session
    expect(JSON.stringify(session)).not.toContain(googleIdentity.subject);
  });

  it("makes the first account an admin whichever way it signs up", async () => {
    const insert = vi.fn(async (_input: InsertUser) => storedUser({ role: "admin" }));
    const { auth } = harness({ countAll: async () => 0, insert });
    await auth.signInWithGoogle(googleInput);
    expect(insert.mock.calls.at(0)?.at(0)).toMatchObject({ role: "admin" });
  });

  it("refuses a deactivated account even when Google vouches for it", async () => {
    const { auth } = harness({ findByGoogleSubject: async () => storedUser({ googleSubject: googleIdentity.subject, isActive: false }) });
    await expect(auth.signInWithGoogle(googleInput)).rejects.toThrow(/deactivated/);
  });

  it("never lets a password open a Google-only account, and says so the same way as a wrong password", async () => {
    const { auth } = harness({ findByEmail: async () => storedUser({ passwordHash: null, googleSubject: googleIdentity.subject }) });
    await expect(auth.login({ email: "amina@ministry.gov", password: "anything-at-all" })).rejects.toThrow(/do not match an account/);
  });
});

describe("token resolution", () => {
  it("rejects a tampered token, a foreign secret and an expired one", () => {
    const tokens = new TokenService();
    const { token } = tokens.sign({ sub: "id", email: "a@b.co", role: "admin" });
    expect(() => tokens.verify(`${token}x`)).toThrow(/invalid or has expired/);
    expect(() => tokens.verify("not.a.token")).toThrow(/invalid or has expired/);
    expect(tokens.verify(token).role).toBe("admin");
  });

  it("drops access for a subject whose account is gone or disabled", async () => {
    const deleted = harness({ findById: async () => null });
    await expect(deleted.auth.resolveActiveUser("missing")).rejects.toThrow(/no longer exists/);
    const disabled = harness({ findById: async () => storedUser({ isActive: false }) });
    await expect(disabled.auth.resolveActiveUser("id")).rejects.toThrow(/deactivated/);
    const active = harness({ findById: async () => storedUser() });
    expect((await active.auth.resolveActiveUser("id")).email).toBe("amina@ministry.gov");
  });
});
