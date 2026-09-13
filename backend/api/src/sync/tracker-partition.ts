/**
 * Work partitioning for large tracker downloads.
 *
 * A tracker program can hold far more records than one offset-paged walk can
 * survive: deep pages get slower as DHIS2 scans past the offset, and a single
 * timeout used to discard the whole download. Splitting the run into bounded
 * partitions keeps every page shallow and makes a failure cost one partition
 * instead of the entire program.
 *
 * Partitions tile the update timeline, so their union is always the complete
 * record set no matter how often a partition is subdivided.
 */

export interface TrackerPartition {
  /** Inclusive lower bound on the record update time. */
  updatedAfter: string;
  /** Exclusive upper bound on the record update time. */
  updatedBefore: string;
  /**
   * Organisation units this partition is restricted to. Undefined keeps the
   * whole accessible scope, which is the default because narrowing the scope
   * to the program's assigned units can change which records DHIS2 returns.
   */
  orgUnitUids?: string[];
}

/** DHIS2 update filters are calendar-precise, so a day is the smallest useful window. */
export const MINIMUM_WINDOW_MS = 86_400_000;

/**
 * The earliest update time any DHIS2 record can carry. Matches the aggregate
 * path's full-history floor so both sync types describe "everything" the same way.
 */
export const HISTORY_FLOOR = "1900-01-01T00:00:00.000Z";

/**
 * The upper bound is our clock, but the update times come from the DHIS2
 * server's. If that server runs ahead, records saved during the run would carry
 * a timestamp past our bound and be dropped from every window. Overshooting the
 * bound costs nothing on a full replace, so absorb the skew instead.
 */
export const CLOCK_SKEW_BUFFER_MS = 86_400_000;

function toInstant(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`Invalid tracker partition boundary: ${value}`);
  return parsed;
}

export function initialTrackerPartition(
  now: Date,
  options: { historyStartDate?: string; orgUnitUids?: string[] } = {}
): TrackerPartition {
  const orgUnitUids = options.orgUnitUids?.length ? [...options.orgUnitUids] : undefined;
  return {
    updatedAfter: options.historyStartDate
      ? new Date(toInstant(options.historyStartDate)).toISOString()
      : HISTORY_FLOOR,
    // Pinned at run start so partitions stay stable while the download runs and
    // a record cannot drift between two windows.
    updatedBefore: new Date(now.getTime() + CLOCK_SKEW_BUFFER_MS).toISOString(),
    ...(orgUnitUids ? { orgUnitUids } : {})
  };
}

/**
 * Halve a partition. The update window is split first because it never changes
 * the query scope; the organisation-unit list is only halved once the window is
 * already down to a single day. Returns null when the partition cannot be
 * divided any further and the caller must fall back to a smaller page size.
 */
export function splitTrackerPartition(partition: TrackerPartition): [TrackerPartition, TrackerPartition] | null {
  const after = toInstant(partition.updatedAfter);
  const before = toInstant(partition.updatedBefore);
  const span = before - after;
  if (span > MINIMUM_WINDOW_MS) {
    const midpoint = new Date(after + Math.floor(span / 2)).toISOString();
    return [
      { ...partition, updatedAfter: partition.updatedAfter, updatedBefore: midpoint },
      { ...partition, updatedAfter: midpoint, updatedBefore: partition.updatedBefore }
    ];
  }
  const orgUnitUids = partition.orgUnitUids ?? [];
  if (orgUnitUids.length > 1) {
    const middle = Math.ceil(orgUnitUids.length / 2);
    return [
      { ...partition, orgUnitUids: orgUnitUids.slice(0, middle) },
      { ...partition, orgUnitUids: orgUnitUids.slice(middle) }
    ];
  }
  return null;
}

export function describeTrackerPartition(partition: TrackerPartition): string {
  const window = `${partition.updatedAfter.slice(0, 10)}..${partition.updatedBefore.slice(0, 10)}`;
  return partition.orgUnitUids?.length
    ? `${window} across ${partition.orgUnitUids.length} organisation unit(s)`
    : window;
}

/**
 * Page size that adapts to what the server actually tolerates.
 *
 * The metadata-derived ceiling only estimates payload width; it cannot know how
 * loaded the DHIS2 instance is. Shrinking on failure keeps a struggling server
 * reachable, and growing again after a run of fast pages stops one early
 * timeout from throttling the rest of a multi-hour download.
 */
export class AdaptivePageSize {
  private readonly ceiling: number;
  private size: number;
  private fastPageStreak = 0;

  constructor(
    ceiling: number,
    private readonly fastPageMs = 15_000,
    private readonly growAfterFastPages = 3
  ) {
    this.ceiling = Math.max(1, Math.trunc(ceiling));
    this.size = this.ceiling;
  }

  get current(): number {
    return this.size;
  }

  recordSuccess(durationMs: number): void {
    if (durationMs >= this.fastPageMs) {
      this.fastPageStreak = 0;
      return;
    }
    this.fastPageStreak += 1;
    if (this.fastPageStreak < this.growAfterFastPages || this.size >= this.ceiling) return;
    this.size = Math.min(this.ceiling, Math.max(this.size + 1, Math.floor(this.size * 1.5)));
    this.fastPageStreak = 0;
  }

  /** Halve the page size. Returns false when it is already at the floor of one record. */
  recordFailure(): boolean {
    this.fastPageStreak = 0;
    if (this.size <= 1) return false;
    this.size = Math.max(1, Math.floor(this.size / 2));
    return true;
  }
}
