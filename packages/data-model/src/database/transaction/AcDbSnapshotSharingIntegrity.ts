import { AcDbObject } from '../../base/index.js'

/**
 * Boundary at which a shared snapshot is re-fingerprinted.
 *
 * The four boundaries are the only places where snapshot sharing can turn from
 * a saved clone into a correctness bug: a transaction ending (`commit`,
 * `abort`) or a change being replayed (`undo`, `redo`).
 */
export type AcDbSnapshotIntegrityBoundary = 'commit' | 'abort' | 'undo' | 'redo'

/**
 * One detected mutation of a snapshot that was supposed to be immutable.
 */
export interface AcDbSnapshotIntegrityViolation {
  /** Boundary at which the difference was seen. */
  boundary: AcDbSnapshotIntegrityBoundary
  /** Object whose snapshot changed. */
  objectId: string
  /**
   * Snapshot side-keys whose fingerprint moved.
   *
   * `_attrs` is reported when an attribute value or attribute-set changed,
   * `_xDataMap` when extended data changed; every other entry is an own
   * property name that participates in `copySnapshotStateTo`.
   */
  changedKeys: string[]
}

/**
 * Result of one integrity pass.
 *
 * `copyOnWriteCount === 0` is not evidence on its own: it only says the sharing
 * layer never asked for a copy, not that nobody wrote to the snapshot. The
 * counts below are what the acceptance criteria read.
 */
export interface AcDbSnapshotIntegrityMetrics {
  /** True when a probe is attached to the transaction manager. */
  enabled: boolean
  /** Snapshots currently fingerprinted and watched. */
  watchedSnapshots: number
  /** Successful re-fingerprints (one per watched snapshot per boundary). */
  checks: number
  /** Boundaries for which at least one pass ran. */
  checkedBoundaries: number
  /** Snapshots that differed from their recorded fingerprint. */
  violations: number
  /** Watches dropped because `maxWatched` was reached. */
  evictedSnapshots: number
  /** Last boundary that ran a pass, or null. */
  lastBoundary: AcDbSnapshotIntegrityBoundary | null
  /** Violations found by the last pass. */
  lastPassViolations: number
  /** Most recent violations, capped at {@link AcDbSnapshotIntegrityProbeOptions.maxViolationLog}. */
  recentViolations: AcDbSnapshotIntegrityViolation[]
}

/** Options for {@link AcDbSnapshotIntegrityProbe}. */
export interface AcDbSnapshotIntegrityProbeOptions {
  /**
   * Maximum number of watched snapshots.
   *
   * Watches are dropped oldest-first when the cap is reached, so a long
   * session pays a bounded amount of bookkeeping. Default `20000`.
   */
  maxWatched?: number
  /** Maximum violations retained for reporting. Default `32`. */
  maxViolationLog?: number
}

/** Own properties that never participate in a snapshot (database back-references). */
const SNAPSHOT_SIDE_KEYS = ['_attrs', '_xDataMap'] as const

/**
 * Own keys that are never fingerprinted.
 *
 * Mirrors `AcDbObject.SNAPSHOT_EXCLUDED_KEYS`, which is private. The list is
 * duplicated here deliberately: this module is a test instrument and must not
 * widen the kernel's public surface to read it.
 */
const SKIPPED_KEYS = new Set(['_database', 'transactionManager'])

/** Maximum array elements / map entries walked per value. */
const VALUE_BUDGET = 64

/**
 * Maximum object nesting walked per value.
 *
 * Four levels is what a geometric snapshot needs (`_geoData` → `startPoint` →
 * `x`), plus two for the attribute container and the entity wrapper.
 */
const MAX_VALUE_DEPTH = 6

/**
 * Serialises one snapshot value into a canonical, bounded string.
 *
 * Bounded on purpose: a snapshot can hold a block reference to a 50 k-entity
 * block, and hashing all of it at every boundary would cost more than the
 * clone it is meant to protect.
 */
function canonicalValue(value: unknown, depth: number): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'

  const type = typeof value
  if (type === 'number') return Number.isFinite(value as number) ? String(value) : `num:${String(value)}`
  if (type === 'string') return JSON.stringify(value)
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'bigint') return `${String(value)}n`
  if (type === 'function') return 'fn'
  if (type === 'symbol') return 'sym'

  // Real arrays and typed arrays: length plus the first VALUE_BUDGET entries.
  //
  // The test must be `Array.isArray` / `ArrayBuffer.isView`, not "has a numeric
  // `length`": `AcGeVector3d` and `AcGeLine3d` expose a `length` getter, and a
  // length-keyed walk of them hashes only the magnitude — a MOVE along X would
  // be invisible.
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const len = (value as ArrayLike<unknown>).length
    const step = len > VALUE_BUDGET ? Math.ceil(len / VALUE_BUDGET) : 1
    const parts: string[] = [`len:${len}`]
    for (let i = 0; i < len; i += step) {
      const element = (value as ArrayLike<unknown>)[i]
      parts.push(
        typeof element === 'number'
          ? String(element)
          : canonicalValue(element, depth + 1)
      )
    }
    return `[${parts.join(',')}]`
  }

  if (value instanceof Map) {
    const entries: string[] = [`size:${value.size}`]
    let seen = 0
    for (const [key, entry] of value) {
      if (seen++ >= VALUE_BUDGET) break
      entries.push(`${String(key)}=${canonicalValue(entry, depth + 1)}`)
    }
    entries.sort()
    return `map{${entries.join(',')}}`
  }

  if (value instanceof Set) {
    const entries: string[] = [`size:${value.size}`]
    let seen = 0
    for (const entry of value) {
      if (seen++ >= VALUE_BUDGET) break
      entries.push(canonicalValue(entry, depth + 1))
    }
    entries.sort()
    return `set{${entries.join(',')}}`
  }

  if (type === 'object') {
    // Deep enough to reach the numbers of a point stored as
    // `entity._geoData -> {startPoint: {x,y,z}}`; bounded so a block
    // reference to a 50 k-entity block never gets walked to the end.
    if (depth >= MAX_VALUE_DEPTH) return 'obj'
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const parts: string[] = []
    let seen = 0
    for (const key of keys) {
      if (seen++ >= VALUE_BUDGET) break
      parts.push(`${key}:${canonicalValue(record[key], depth + 1)}`)
    }
    return `{${parts.join(',')}}`
  }

  return String(value)
}

/** FNV-1a over the canonical string; short, stable, allocation-free per char. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * Returns `attributes` without the identity entry.
 *
 * `objectId` is not state: `restoreFrom` re-applies the live id after the copy,
 * and every detached clone carries a random temporary handle. Hashing it would
 * make two entities with identical geometry look different, which buries the
 * signal in the probe's report.
 */
function withoutIdentityKeys(
  attributes: unknown
): Record<string, unknown> | undefined {
  if (!attributes || typeof attributes !== 'object') return undefined
  const record = attributes as Record<string, unknown>
  if (!('objectId' in record)) return record
  const { objectId: _ignored, ...rest } = record
  return rest
}

/**
 * Per-side-key fingerprints of one snapshot.
 *
 * `_attrs` and `_xDataMap` are fingerprinted separately from the own
 * properties because they are the two containers `restoreFrom` treats
 * specially, and a violation is far easier to read when it names the side
 * instead of "something changed".
 */
export function acdbFingerprintSnapshot(
  snapshot: AcDbObject
): Record<string, string> {
  const source = snapshot as unknown as Record<string, unknown>
  const fingerprints: Record<string, string> = {}

  for (const sideKey of SNAPSHOT_SIDE_KEYS) {
    const holder = source[sideKey] as { attributes?: unknown } | undefined
    const value =
      sideKey === '_attrs' ? withoutIdentityKeys(holder?.attributes) : holder
    fingerprints[sideKey] = fnv1a(canonicalValue(value, 1))
  }

  for (const key of Reflect.ownKeys(snapshot)) {
    if (typeof key !== 'string' || SKIPPED_KEYS.has(key)) continue
    if ((SNAPSHOT_SIDE_KEYS as readonly string[]).includes(key)) continue
    fingerprints[key] = fnv1a(canonicalValue(source[key], 1))
  }

  return fingerprints
}

/**
 * Development/test-only integrity probe for shared snapshots.
 *
 * Attach one to `AcDbDatabaseTransactionManager.snapshotIntegrityProbe` and
 * every snapshot that is shared between the rollback map and the undo record is
 * fingerprinted when it is created and re-fingerprinted at commit, abort, undo
 * and redo. Snapshot sharing is safe exactly as long as nothing ever writes to
 * a snapshot; this class turns that assumption into an assertion.
 *
 * Cost is confined to the probe: when the manager field is `undefined` the
 * kernel performs one property read per snapshot and no hashing at all, so the
 * production performance path is untouched.
 */
export class AcDbSnapshotIntegrityProbe {
  private readonly maxWatched: number
  private readonly maxViolationLog: number
  /** objectId → recorded fingerprints, in insertion order for FIFO eviction. */
  private readonly watched = new Map<string, Record<string, string>>()
  private readonly violations: AcDbSnapshotIntegrityViolation[] = []
  private _checks = 0
  private _checkedBoundaries = 0
  private _violations = 0
  private _evicted = 0
  private _lastBoundary: AcDbSnapshotIntegrityBoundary | null = null
  private _lastPassViolations = 0

  constructor(options?: AcDbSnapshotIntegrityProbeOptions) {
    this.maxWatched = options?.maxWatched ?? 20000
    this.maxViolationLog = options?.maxViolationLog ?? 32
  }

  /** Number of snapshots currently watched. */
  get watchedSnapshots(): number {
    return this.watched.size
  }

  /**
   * Records the state of a snapshot that is about to be shared.
   *
   * @param objectId - Owner of the snapshot; later passes report it verbatim.
   * @param snapshot - The clone that both the rollback map and the undo record hold.
   */
  watch(objectId: string, snapshot: AcDbObject): void {
    if (this.watched.size >= this.maxWatched) {
      const oldest = this.watched.keys().next()
      if (!oldest.done) {
        this.watched.delete(oldest.value)
        this._evicted++
      }
    }
    this.watched.set(objectId, acdbFingerprintSnapshot(snapshot))
  }

  /** Stops watching one object, for example once its undo record is discarded. */
  release(objectId: string): void {
    this.watched.delete(objectId)
  }

  /** Drops every watch and every counted violation. */
  clear(): void {
    this.watched.clear()
    this.violations.length = 0
    this._checks = 0
    this._checkedBoundaries = 0
    this._violations = 0
    this._evicted = 0
    this._lastBoundary = null
    this._lastPassViolations = 0
  }

  /**
   * Compares one snapshot with its recorded fingerprint.
   *
   * @param objectId - Owner of the snapshot.
   * @param snapshot - Snapshot to re-fingerprint; must be the same object that was watched.
   * @param boundary - Boundary being crossed, for the report.
   * @returns True when the snapshot is unchanged.
   */
  check(
    objectId: string,
    snapshot: AcDbObject,
    boundary: AcDbSnapshotIntegrityBoundary
  ): boolean {
    const recorded = this.watched.get(objectId)
    if (!recorded) return true

    this._checks++
    const current = acdbFingerprintSnapshot(snapshot)
    const changedKeys: string[] = []
    for (const key of Object.keys(recorded)) {
      if (current[key] !== recorded[key]) changedKeys.push(key)
    }
    for (const key of Object.keys(current)) {
      if (!(key in recorded)) changedKeys.push(key)
    }
    if (changedKeys.length === 0) return true

    this._violations++
    const violation: AcDbSnapshotIntegrityViolation = {
      boundary,
      objectId,
      changedKeys
    }
    if (this.violations.length >= this.maxViolationLog) this.violations.shift()
    this.violations.push(violation)
    return false
  }

  /**
   * Re-fingerprints every watched snapshot.
   *
   * The caller is responsible for passing the boundary; `undo` and `redo` are
   * separate entries because the same record is replayed in both directions and
   * a violation should name the direction that saw it.
   *
   * @param boundary - Boundary being crossed.
   * @param resolve - Optional snapshot lookup; without it the pass cannot
   *   re-read the object and only counts the boundary.
   * @returns Number of violations found by this pass.
   */
  checkAll(
    boundary: AcDbSnapshotIntegrityBoundary,
    resolve?: (objectId: string) => AcDbObject | undefined
  ): number {
    this._lastBoundary = boundary
    this._checkedBoundaries++

    const before = this._violations
    if (resolve) {
      for (const objectId of this.watched.keys()) {
        const snapshot = resolve(objectId)
        if (snapshot) this.check(objectId, snapshot, boundary)
      }
    }

    this._lastPassViolations = this._violations - before
    return this._lastPassViolations
  }

  /**
   * Counts a boundary even when the caller holds its own snapshot references.
   *
   * Used by the commit path, which verifies the transaction's `originalStates`
   * map directly instead of resolving through the database.
   */
  noteBoundary(
    boundary: AcDbSnapshotIntegrityBoundary,
    violations: number
  ): void {
    this._lastBoundary = boundary
    this._checkedBoundaries++
    this._lastPassViolations = violations
  }

  /** Snapshot of the probe's counters; see {@link AcDbSnapshotIntegrityMetrics}. */
  getMetrics(): AcDbSnapshotIntegrityMetrics {
    return {
      enabled: true,
      watchedSnapshots: this.watched.size,
      checks: this._checks,
      checkedBoundaries: this._checkedBoundaries,
      violations: this._violations,
      evictedSnapshots: this._evicted,
      lastBoundary: this._lastBoundary,
      lastPassViolations: this._lastPassViolations,
      recentViolations: [...this.violations]
    }
  }
}
