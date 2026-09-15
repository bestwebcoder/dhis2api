import { describe, expect, it } from "vitest";
import { authorizationUrl, codeChallengeFor, parseCallback, type PendingGoogleFlow } from "./google-auth.js";

const pending: PendingGoogleFlow = {
  state: "b1TsWvq3oFJ0Gm1JmQ3M1p2kDk3qS8rUuEo0vS7yQyE",
  codeVerifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
  redirectUri: "http://localhost:5173/",
  intent: "signin"
};

describe("Google PKCE", () => {
  it("derives the S256 challenge from RFC 7636's worked example", async () => {
    expect(await codeChallengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("asks Google for a code bound to the challenge, never for a token in the URL", () => {
    const url = new URL(authorizationUrl("client.apps.googleusercontent.com", pending, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      state: pending.state,
      redirect_uri: "http://localhost:5173/",
      scope: "openid email profile"
    });
    expect(url.searchParams.has("code_verifier")).toBe(false);
  });
});

describe("Google redirect handling", () => {
  it("ignores an ordinary page load", () => {
    expect(parseCallback("", pending)).toBeNull();
  });

  it("pairs the returned code with the verifier this tab kept", () => {
    expect(parseCallback(`?code=4%2F0Ab&state=${pending.state}&scope=email`, pending)).toEqual({
      kind: "code",
      intent: "signin",
      input: { code: "4/0Ab", codeVerifier: pending.codeVerifier, redirectUri: pending.redirectUri }
    });
  });

  it("refuses a code whose state this tab did not create", () => {
    expect(parseCallback("?code=4%2F0Ab&state=forged", pending)).toMatchObject({ kind: "error", message: /could not be verified/ });
    expect(parseCallback(`?code=4%2F0Ab&state=${pending.state}`, null)).toMatchObject({ kind: "error" });
  });

  it("explains a cancelled consent screen and keeps the intent it started with", () => {
    expect(parseCallback(`?error=access_denied&state=${pending.state}`, { ...pending, intent: "link" }))
      .toEqual({ kind: "error", intent: "link", message: "Google sign-in was cancelled." });
  });
});
