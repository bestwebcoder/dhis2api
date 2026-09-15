import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import jwt from "jsonwebtoken";
import { GoogleOAuthService } from "./google-oauth.service.js";

const CLIENT_ID = "1234-test.apps.googleusercontent.com";

beforeAll(() => {
  process.env.DATABASE_URL ??= "postgresql://unused/unused";
  process.env.CONNECTION_ENCRYPTION_KEY ??= Buffer.alloc(32).toString("base64");
  process.env.AUTH_JWT_SECRET ??= "a-test-signing-secret-of-sufficient-length";
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = "a-test-client-secret";
});

const input = {
  code: "4/0AbCdEf-one-time-code",
  codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  redirectUri: "http://localhost:5173/"
};

/** The service only reads claims from a token it fetched itself, so any signature will do here. */
function idToken(overrides: Record<string, unknown> = {}): string {
  return jwt.sign({
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: "109876543210987654321",
    email: "Amina@Ministry.gov",
    email_verified: true,
    name: "Amina Yusuf",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...overrides
  }, "irrelevant", { algorithm: "HS256", noTimestamp: true });
}

function googleReplies(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Google code exchange", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the code, the PKCE verifier and the client secret as a form, and returns the identity", async () => {
    const fetchMock = googleReplies(200, { id_token: idToken(), access_token: "discarded" });
    const identity = await new GoogleOAuthService().exchange(input);

    const [url, init] = fetchMock.mock.calls.at(0) as unknown as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const form = init.body as URLSearchParams;
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
      client_id: CLIENT_ID,
      client_secret: "a-test-client-secret"
    });
    expect(identity).toEqual({ subject: "109876543210987654321", email: "amina@ministry.gov", name: "Amina Yusuf" });
  });

  it.each([
    ["another client's audience", { aud: "someone-else.apps.googleusercontent.com" }],
    ["another authorised party", { azp: "someone-else.apps.googleusercontent.com" }],
    ["a foreign issuer", { iss: "https://evil.example" }],
    ["an expired token", { exp: Math.floor(Date.now() / 1000) - 3600 }],
    ["a missing subject", { sub: "" }]
  ])("rejects %s", async (_label, claims) => {
    googleReplies(200, { id_token: idToken(claims) });
    await expect(new GoogleOAuthService().exchange(input)).rejects.toThrow(/did not accept that sign-in/);
  });

  it("refuses a Google account whose email is unverified", async () => {
    googleReplies(200, { id_token: idToken({ email_verified: false }) });
    await expect(new GoogleOAuthService().exchange(input)).rejects.toThrow(/no verified email/);
  });

  it("reports a refused code as a 400 without echoing Google's response", async () => {
    googleReplies(400, { error: "invalid_grant", error_description: "Bad Request" });
    const failure = await new GoogleOAuthService().exchange(input).catch((error: unknown) => error);
    // not 401: api.ts treats any 401 as an expired session and would sign the user out
    expect((failure as { getStatus(): number }).getStatus()).toBe(400);
    expect((failure as Error).message).not.toContain("invalid_grant");
  });

  it("reports an unreachable Google as unavailable rather than as bad credentials", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    const failure = await new GoogleOAuthService().exchange(input).catch((error: unknown) => error);
    expect((failure as { getStatus(): number }).getStatus()).toBe(503);
  });

  it("falls back to the mailbox name when Google sends no usable display name", async () => {
    googleReplies(200, { id_token: idToken({ name: " " }) });
    expect((await new GoogleOAuthService().exchange(input)).name).toBe("amina");
  });
});
