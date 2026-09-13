import { describe, expect, it } from "vitest";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { databaseErrorCode, rejectDanglingReferences, requireConfirmation, summarise } from "./deletion.js";

describe("delete confirmation", () => {
  it("accepts the exact name, ignoring surrounding whitespace", () => {
    expect(() => requireConfirmation("tracker_anc", "tracker_anc", "data table")).not.toThrow();
    expect(() => requireConfirmation("  tracker_anc  ", "tracker_anc", "data table")).not.toThrow();
  });

  it("names what has to be typed and warns that it is final", () => {
    expect(() => requireConfirmation("wrong", "tracker_anc", "data table"))
      .toThrow("Type tracker_anc to confirm deleting this data table. This cannot be undone.");
  });

  it("refuses a missing, blank or repeated confirmation", () => {
    // Fastify hands ?confirm=a&confirm=b over as an array; it must never match
    for (const value of [undefined, null, "", "   ", ["tracker_anc"], 0]) {
      expect(() => requireConfirmation(value, "tracker_anc", "data table")).toThrow(BadRequestException);
    }
  });

  it("does not accept a prefix or a differently cased name", () => {
    expect(() => requireConfirmation("tracker", "tracker_anc", "data table")).toThrow(BadRequestException);
    expect(() => requireConfirmation("TRACKER_ANC", "tracker_anc", "data table")).toThrow(BadRequestException);
  });
});

describe("late dependency handling", () => {
  it("turns a foreign key violation into the conflict the caller would have seen", async () => {
    const violation = Object.assign(new Error("update or delete violates foreign key"), { code: "23503" });
    await expect(rejectDanglingReferences("connection", () => Promise.reject(violation)))
      .rejects.toThrow(ConflictException);
  });

  it("lets every other failure through untouched", async () => {
    const other = Object.assign(new Error("connection terminated"), { code: "57P01" });
    await expect(rejectDanglingReferences("connection", () => Promise.reject(other))).rejects.toThrow("connection terminated");
    expect(databaseErrorCode(other)).toBe("57P01");
    expect(databaseErrorCode("not an error")).toBeUndefined();
  });

  it("returns the value when nothing goes wrong", async () => {
    await expect(rejectDanglingReferences("connection", () => Promise.resolve(true))).resolves.toBe(true);
  });
});

describe("cascade reporting", () => {
  it("reports only what was actually removed", () => {
    expect(summarise({ "sync definitions": 2, schedules: 0, "run history": 41, cursors: 0 }))
      .toEqual({ "sync definitions": 2, "run history": 41 });
    expect(summarise({ schedules: 0 })).toEqual({});
  });
});
