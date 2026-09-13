import { Injectable } from "@nestjs/common";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number }
) => Promise<Buffer>;

/**
 * scrypt N=2^15, r=8, p=1 — ~160ms and 32MB per hash on a dev laptop. Raising N
 * further makes the unauthenticated /auth/login path a CPU and memory lever
 * against the API; maxmem then bounds what an absurd stored N could ever claim.
 */
const COST = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/**
 * Hashes account passwords with scrypt into a self-describing string, so the
 * cost parameters travel with every stored hash and can be raised later
 * without invalidating existing rows.
 */
@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    const salt = randomBytes(SALT_LENGTH);
    const key = await derive(password, salt, KEY_LENGTH, COST);
    return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString("base64")}$${key.toString("base64")}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, rawN, rawR, rawP, rawSalt, rawKey] = parts as [string, string, string, string, string, string];
    const N = Number(rawN);
    const r = Number(rawR);
    const p = Number(rawP);
    if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
    const expected = Buffer.from(rawKey, "base64");
    if (expected.length === 0) return false;
    let candidate: Buffer;
    try {
      candidate = await derive(password, Buffer.from(rawSalt, "base64"), expected.length, { N, r, p, maxmem: COST.maxmem });
    } catch {
      return false;
    }
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }
}
