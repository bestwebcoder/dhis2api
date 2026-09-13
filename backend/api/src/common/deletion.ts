import { BadRequestException, ConflictException } from "@nestjs/common";

/** Postgres raised a FK violation: something still references the row being removed. */
const FOREIGN_KEY_VIOLATION = "23503";

export function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Every destructive endpoint takes ?confirm=<name>. One helper so the rule and
 * the message are identical wherever it is enforced, and so a blank or repeated
 * query parameter (`?confirm=&confirm=x`, which Fastify hands over as an array)
 * can never be mistaken for a match.
 */
export function requireConfirmation(provided: unknown, expected: string, noun: string): void {
  const value = typeof provided === "string" ? provided.trim() : undefined;
  if (value !== expected) {
    throw new BadRequestException(`Type ${expected} to confirm deleting this ${noun}. This cannot be undone.`);
  }
}

/**
 * Turns the FK violation from a row that gained a dependant between the
 * dependency check and the delete into the 409 the caller would have got a
 * moment earlier, rather than a 500.
 */
export async function rejectDanglingReferences<T>(noun: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (databaseErrorCode(error) === FOREIGN_KEY_VIOLATION) {
      throw new ConflictException(`Something started using this ${noun} while it was being deleted. Review its dependencies and try again.`);
    }
    throw error;
  }
}

/** Drops the zero counts, so a response only names what a delete actually touched. */
export function summarise(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).filter(([, value]) => value > 0));
}
