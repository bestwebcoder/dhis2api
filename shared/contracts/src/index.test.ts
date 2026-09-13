import { describe, expect, it } from "vitest";
import { CreateConnectionSchema, SignInSchema, SignUpSchema } from "./index.js";

const common = {
  name: "Training server",
  role: "source" as const,
  baseUrl: "https://example.org/dhis",
  testBeforeSave: true
};

describe("CreateConnectionSchema", () => {
  it("ignores an empty token when basic authentication is selected", () => {
    const result = CreateConnectionSchema.safeParse({
      ...common,
      authType: "basic",
      username: "admin",
      password: "secret",
      apiToken: ""
    });
    expect(result.success).toBe(true);
  });

  it("ignores empty basic fields when token authentication is selected", () => {
    const result = CreateConnectionSchema.safeParse({
      ...common,
      authType: "pat",
      apiToken: "token",
      username: "",
      password: ""
    });
    expect(result.success).toBe(true);
  });

  it("requires credentials for the selected authentication method", () => {
    const result = CreateConnectionSchema.safeParse({
      ...common,
      authType: "basic",
      username: "",
      password: ""
    });
    expect(result.success).toBe(false);
  });
});

describe("SignUpSchema", () => {
  const common = { name: "Amina Yusuf", email: "Amina@Ministry.GOV ", password: "correct-horse" };

  it("normalises the email and defaults an absent organisation", () => {
    const result = SignUpSchema.safeParse(common);
    expect(result.success).toBe(true);
    expect(result.data?.email).toBe("amina@ministry.gov");
    expect(result.data?.organisation).toBe("");
  });

  it("rejects a malformed email and a short password", () => {
    expect(SignUpSchema.safeParse({ ...common, email: "not-an-email" }).success).toBe(false);
    expect(SignUpSchema.safeParse({ ...common, password: "short" }).success).toBe(false);
  });

  it("accepts any non-empty password on sign in so failures stay generic", () => {
    expect(SignInSchema.safeParse({ email: "a@b.co", password: "x" }).success).toBe(true);
    expect(SignInSchema.safeParse({ email: "a@b.co", password: "" }).success).toBe(false);
  });
});
