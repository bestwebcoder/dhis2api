import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { GoogleAuthInput } from "@dhis-sync/contracts";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { getConfig } from "../config.js";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"] as const;
const EXCHANGE_TIMEOUT_MS = 10_000;
/** Tolerated clock drift between this host and Google when checking expiry. */
const CLOCK_SKEW_SECONDS = 60;

const TokenResponseSchema = z.object({ id_token: z.string().min(1) });

const IdTokenClaimsSchema = z.object({
  iss: z.enum(GOOGLE_ISSUERS),
  aud: z.string(),
  azp: z.string().optional(),
  sub: z.string().min(1).max(255),
  exp: z.number(),
  email: z.string().optional(),
  email_verified: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
  name: z.string().optional()
});

/** Who Google says completed the sign-in. Only ever built from a checked ID token. */
export interface GoogleIdentity {
  /** The stable OpenID subject; what an account is linked by. */
  subject: string;
  /** Lower-cased, and always verified by Google. */
  email: string;
  name: string;
}

const REJECTED = "Google did not accept that sign-in. Start again from the sign-in button.";

/**
 * The server half of Google's authorization-code flow. The browser obtains a
 * one-time code bound to its PKCE verifier; this exchanges it with the client
 * secret — which never leaves the API — and turns the ID token into an identity.
 *
 * Google's access and refresh tokens are discarded: the hub only needs to know
 * who signed in, and then issues its own session exactly as password sign-in does.
 */
@Injectable()
export class GoogleOAuthService {
  private readonly logger = new Logger(GoogleOAuthService.name);

  get enabled(): boolean {
    return Boolean(getConfig().GOOGLE_CLIENT_ID);
  }

  async exchange(input: GoogleAuthInput): Promise<GoogleIdentity> {
    const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret } = getConfig();
    if (!clientId || !clientSecret) {
      throw new NotFoundException("Google sign-in is not enabled on this deployment.");
    }

    let response: Response;
    try {
      response = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: input.code,
          code_verifier: input.codeVerifier,
          // Google refuses the exchange unless this matches the authorization
          // request and is registered on the OAuth client, so it cannot be
          // pointed anywhere the Cloud Console does not already allow
          redirect_uri: input.redirectUri,
          client_id: clientId,
          client_secret: clientSecret
        }),
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS)
      });
    } catch (cause) {
      this.logger.warn(`Google token endpoint unreachable: ${(cause as Error).message}`);
      throw new ServiceUnavailableException("Could not reach Google to finish signing in. Try again in a moment.");
    }

    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      // log Google's error code only; the request carried the code and the secret
      const reason = (payload as { error?: unknown } | null)?.error;
      this.logger.warn(`Google rejected a code exchange (HTTP ${response.status}, ${typeof reason === "string" ? reason : "no error code"})`);
      throw new BadRequestException(REJECTED);
    }
    const tokens = TokenResponseSchema.safeParse(payload);
    if (!tokens.success) throw new BadRequestException(REJECTED);
    return this.identityFrom(tokens.data.id_token, clientId);
  }

  /**
   * Checks the ID token's claims. Its signature is not re-verified against
   * Google's JWKS: OpenID Connect Core §3.1.3.7 lets TLS server authentication
   * stand in for it when the token comes straight from the token endpoint in
   * exchange for our own client secret, which is the only way this method is
   * reached. Audience, issuer and expiry are still enforced.
   */
  private identityFrom(idToken: string, clientId: string): GoogleIdentity {
    const decoded = jwt.decode(idToken, { json: true });
    const claims = IdTokenClaimsSchema.safeParse(decoded);
    if (!claims.success) throw new BadRequestException(REJECTED);
    const { aud, azp, sub, exp, email, email_verified: emailVerified, name } = claims.data;
    if (aud !== clientId || (azp !== undefined && azp !== clientId)) throw new BadRequestException(REJECTED);
    if (exp + CLOCK_SKEW_SECONDS < Date.now() / 1000) throw new BadRequestException(REJECTED);

    const normalised = email?.trim().toLowerCase();
    if (!normalised || (emailVerified !== true && emailVerified !== "true")) {
      // the email is how an account is named and matched; an unverified one proves nothing
      throw new BadRequestException("Your Google account has no verified email address, so it cannot be used to sign in.");
    }
    const displayName = name?.trim().slice(0, 120);
    return {
      subject: sub,
      email: normalised,
      name: displayName && displayName.length >= 2 ? displayName : normalised.split("@")[0] ?? normalised
    };
  }
}
