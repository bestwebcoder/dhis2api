import { Injectable, UnauthorizedException } from "@nestjs/common";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { getConfig } from "../config.js";

export interface TokenClaims {
  sub: string;
  email: string;
  role: string;
}

export interface IssuedToken {
  token: string;
  expiresAt: string;
}

const ISSUER = "dhis-sync-api";

@Injectable()
export class TokenService {
  private readonly secret = getConfig().AUTH_JWT_SECRET;
  private readonly ttlHours = getConfig().AUTH_TOKEN_TTL_HOURS;

  sign(claims: TokenClaims): IssuedToken {
    const expiresIn = this.ttlHours * 3600;
    const token = jwt.sign(claims, this.secret, { algorithm: "HS256", issuer: ISSUER, expiresIn });
    return { token, expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString() };
  }

  verify(token: string): TokenClaims {
    let payload: string | JwtPayload;
    try {
      // algorithms is pinned so a token claiming "none" or an RS256 key confusion is rejected
      payload = jwt.verify(token, this.secret, { algorithms: ["HS256"], issuer: ISSUER });
    } catch {
      throw new UnauthorizedException("Your session is invalid or has expired. Sign in again.");
    }
    if (typeof payload === "string" || typeof payload.sub !== "string" || typeof payload.email !== "string" || typeof payload.role !== "string") {
      throw new UnauthorizedException("Your session is invalid or has expired. Sign in again.");
    }
    return { sub: payload.sub, email: payload.email, role: payload.role };
  }
}
