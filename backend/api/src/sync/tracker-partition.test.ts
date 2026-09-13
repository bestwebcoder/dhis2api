import { describe, expect, it } from "vitest";
import {
  AdaptivePageSize,
  CLOCK_SKEW_BUFFER_MS,
  HISTORY_FLOOR,
  initialTrackerPartition,
  MINIMUM_WINDOW_MS,
  splitTrackerPartition,
  type TrackerPartition
} from "./tracker-partition.js";

const at = (iso: string) => new Date(iso);

describe("tracker partition planning", () => {
  it("starts from the full history and overshoots run start to absorb clock skew", () => {
    const partition = initialTrackerPartition(at("2026-09-07T10:00:00.000Z"));
    expect(partition).toEqual({
      updatedAfter: HISTORY_FLOOR,
      updatedBefore: "2026-09-08T10:00:00.000Z"
    });
    expect(Date.parse(partition.updatedBefore) - Date.parse("2026-09-07T10:00:00.000Z"))
      .toBe(CLOCK_SKEW_BUFFER_MS);
  });

  it("honours a configured history floor and organisation-unit scope", () => {
    expect(initialTrackerPartition(at("2026-09-07T10:00:00.000Z"), {
      historyStartDate: "2020-01-01",
      orgUnitUids: ["DiszpKrYNg8"]
    })).toEqual({
      updatedAfter: "2020-01-01T00:00:00.000Z",
      updatedBefore: "2026-09-08T10:00:00.000Z",
      orgUnitUids: ["DiszpKrYNg8"]
    });
  });

  it("halves the update window without leaving a gap or an overlap", () => {
    const partition: TrackerPartition = {
      updatedAfter: "2026-01-01T00:00:00.000Z",
      updatedBefore: "2026-01-11T00:00:00.000Z"
    };
    const halves = splitTrackerPartition(partition);

    expect(halves).not.toBeNull();
    const [left, right] = halves!;
    expect(left.updatedAfter).toBe(partition.updatedAfter);
    expect(left.updatedBefore).toBe(right.updatedAfter);
    expect(right.updatedBefore).toBe(partition.updatedBefore);
  });

  it("repeated splitting still tiles the original range exactly once", () => {
    const root: TrackerPartition = {
      updatedAfter: "2020-01-01T00:00:00.000Z",
      updatedBefore: "2026-01-01T00:00:00.000Z"
    };
    let leaves = [root];
    for (let round = 0; round < 6; round += 1) {
      leaves = leaves.flatMap((leaf) => splitTrackerPartition(leaf) ?? [leaf]);
    }

    expect(leaves.length).toBe(64);
    expect(leaves[0]!.updatedAfter).toBe(root.updatedAfter);
    expect(leaves.at(-1)!.updatedBefore).toBe(root.updatedBefore);
    for (let index = 1; index < leaves.length; index += 1) {
      expect(leaves[index]!.updatedAfter).toBe(leaves[index - 1]!.updatedBefore);
    }
  });

  it("falls back to halving organisation units once the window is a single day", () => {
    const day: TrackerPartition = {
      updatedAfter: "2026-01-01T00:00:00.000Z",
      updatedBefore: new Date(Date.parse("2026-01-01T00:00:00.000Z") + MINIMUM_WINDOW_MS).toISOString(),
      orgUnitUids: ["DiszpKrYNg8", "g8upMTyEZGZ", "kJq2mPyFEHo"]
    };

    expect(splitTrackerPartition(day)).toEqual([
      { ...day, orgUnitUids: ["DiszpKrYNg8", "g8upMTyEZGZ"] },
      { ...day, orgUnitUids: ["kJq2mPyFEHo"] }
    ]);
  });

  it("reports an indivisible partition so the caller can shrink the page instead", () => {
    expect(splitTrackerPartition({
      updatedAfter: "2026-01-01T00:00:00.000Z",
      updatedBefore: "2026-01-02T00:00:00.000Z",
      orgUnitUids: ["DiszpKrYNg8"]
    })).toBeNull();
  });
});

describe("AdaptivePageSize", () => {
  it("halves on failure and stops at a single record", () => {
    const pageSize = new AdaptivePageSize(100);
    expect(pageSize.recordFailure()).toBe(true);
    expect(pageSize.current).toBe(50);
    for (let attempt = 0; attempt < 10; attempt += 1) pageSize.recordFailure();
    expect(pageSize.current).toBe(1);
    expect(pageSize.recordFailure()).toBe(false);
  });

  it("recovers toward the ceiling after a run of fast pages", () => {
    const pageSize = new AdaptivePageSize(100, 15_000, 3);
    pageSize.recordFailure();
    expect(pageSize.current).toBe(50);

    for (let page = 0; page < 3; page += 1) pageSize.recordSuccess(1_000);
    expect(pageSize.current).toBe(75);
  });

  it("never grows past the metadata-derived ceiling", () => {
    const pageSize = new AdaptivePageSize(20, 15_000, 1);
    for (let page = 0; page < 10; page += 1) pageSize.recordSuccess(10);
    expect(pageSize.current).toBe(20);
  });

  it("treats a slow page as a reason not to grow", () => {
    const pageSize = new AdaptivePageSize(100, 15_000, 3);
    pageSize.recordFailure();
    pageSize.recordSuccess(1_000);
    pageSize.recordSuccess(20_000);
    pageSize.recordSuccess(1_000);
    pageSize.recordSuccess(1_000);
    expect(pageSize.current).toBe(50);
  });
});
