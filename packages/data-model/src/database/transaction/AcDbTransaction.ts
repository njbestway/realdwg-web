import { AcDbObject, AcDbObjectId, AcDbOpenMode } from '../../base/index.js'
import { AcDbChangeRecorder } from './AcDbChangeRecorder.js'
import {
  AcDbSnapshotIntegrityBoundary,
  AcDbSnapshotIntegrityProbe
} from './AcDbSnapshotSharingIntegrity.js'

/**
 * Options accepted by {@link AcDbTransaction}.
 *
 * Phase 2.10 adds exactly one knob so the snapshot-sharing experiment can be
 * measured against the previous behaviour in the same build. Production code
 * keeps the default; the A/B harness flips it.
 */
export interface AcDbTransactionOptions {
  /**
   * Reuse the rollback snapshot as the recorder's `before` snapshot.
   *
   * When enabled, opening an object for write takes **one** deep clone per
   * object instead of two: the same immutable object is held by
   * `originalStates` (for abort) and by `change.before` (for undo).
   *
   * Safe because a snapshot is never written after creation — `restoreFrom`
   * only reads it. See `PHASE210_SNAPSHOT_OWNERSHIP_AUDIT.md`.
   *
   * Default `false`: the phase 2.10 gate requires an A/B result before this
   * becomes the production behaviour.
   */
  shareBeforeSnapshot?: boolean

  /**
   * Optional per-snapshot size estimate, accumulated for the byte metrics.
   *
   * Left undefined by default: estimating every snapshot is work the kernel
   * must not do on the production path. The benchmark harness supplies one.
   */
  estimateSnapshotBytes?: (snapshot: AcDbObject) => number

  /**
   * Optional shared-snapshot integrity probe (phase 2.11, task A2).
   *
   * When supplied **and** {@link shareBeforeSnapshot} is on, every snapshot
   * that the rollback map and the undo record share is fingerprinted at
   * creation, so a later write to it is detected instead of silently corrupting
   * the undo payload. Undefined by default: the production path does no hashing.
   */
  integrityProbe?: AcDbSnapshotIntegrityProbe
}

/**
 * Represents a single database transaction.
 *
 * A transaction records the original state of opened objects so that
 * changes can be committed or rolled back.
 *
 * This class is normally not instantiated directly by users.
 */
export class AcDbTransaction {
  /** Objects opened in this transaction */
  private readonly openedObjects = new Map<AcDbObjectId, AcDbObject>()

  /** Snapshots of objects before modification */
  private readonly originalStates = new Map<AcDbObjectId, AcDbObject>()

  /** Structured changes recorded during this transaction for commit/undo integration */
  readonly recorder = new AcDbChangeRecorder()

  /** Whether the rollback snapshot doubles as the undo `before` snapshot. */
  private readonly shareBeforeSnapshot: boolean

  /** Optional snapshot size estimator; see {@link AcDbTransactionOptions}. */
  private readonly estimateSnapshotBytes:
    | ((snapshot: AcDbObject) => number)
    | undefined

  /** Optional shared-snapshot integrity probe; see {@link AcDbTransactionOptions}. */
  private readonly integrityProbe: AcDbSnapshotIntegrityProbe | undefined

  /** Open-for-write calls, including repeated opens of the same object. */
  private _openForWriteCalls = 0

  /** Distinct objects that received a rollback snapshot. */
  private _uniqueModified = 0

  /** Time spent taking the rollback snapshot (the deep clone). */
  private _snapshotCloneMs = 0

  /** Time spent in {@link AcDbChangeRecorder.recordModify}. */
  private _recordModifyMs = 0

  /** Estimated bytes of the rollback snapshots, when an estimator is supplied. */
  private _snapshotBytes = 0

  /**
   * @param options - Snapshot-sharing experiment knobs; see
   *   {@link AcDbTransactionOptions}
   */
  constructor(options?: AcDbTransactionOptions) {
    this.shareBeforeSnapshot = options?.shareBeforeSnapshot ?? false
    this.estimateSnapshotBytes = options?.estimateSnapshotBytes
    this.integrityProbe = options?.integrityProbe
  }

  /**
   * Re-fingerprints every shared snapshot held by this transaction.
   *
   * Called by the manager at the `commit` and `abort` boundaries, while
   * `originalStates` is still populated. A no-op unless a probe is attached.
   *
   * @param boundary - Boundary being crossed, for the violation report.
   * @returns Number of snapshots that no longer match their recorded state.
   */
  verifySharedSnapshots(boundary: AcDbSnapshotIntegrityBoundary): number {
    if (!this.integrityProbe || !this.shareBeforeSnapshot) return 0

    let violations = 0
    for (const [objectId, snapshot] of this.originalStates) {
      if (!this.integrityProbe.check(objectId, snapshot, boundary)) {
        violations++
      }
    }
    this.integrityProbe.noteBoundary(boundary, violations)
    return violations
  }

  /** Number of open-for-write calls, repeated opens included. */
  get openedForWrite(): number {
    return this._openForWriteCalls
  }

  /** Number of distinct objects that received a rollback snapshot. */
  get uniqueModifiedObjects(): number {
    return this._uniqueModified
  }

  /**
   * Number of rollback snapshots taken.
   *
   * Equals {@link uniqueModifiedObjects}: every first write takes exactly one.
   */
  get rollbackSnapshotClones(): number {
    return this._uniqueModified
  }

  /** Milliseconds spent inside {@link AcDbObject.clonePreservingIdentity}. */
  get snapshotCloneMs(): number {
    return this._snapshotCloneMs
  }

  /** Milliseconds spent inside {@link AcDbChangeRecorder.recordModify}. */
  get recordModifyMs(): number {
    return this._recordModifyMs
  }

  /** Estimated bytes of the rollback snapshots taken. */
  get snapshotBytes(): number {
    return this._snapshotBytes
  }

  /** True when the rollback and undo snapshots are the same object. */
  get isSnapshotSharingEnabled(): boolean {
    return this.shareBeforeSnapshot
  }

  /**
   * Records an object opening.
   *
   * When the object is opened for write, a pre-modification snapshot is stored
   * for abort rollback and a modify entry is added to {@link recorder}.
   *
   * @param objectId - Object identifier
   * @param mode - Open mode
   * @param openErased - Whether erased objects are allowed
   * @returns The opened object, or the cached instance if already opened in this transaction
   */
  getObject<T extends AcDbObject>(
    objectId: AcDbObjectId,
    mode: AcDbOpenMode,
    openErased = false
  ): T | undefined {
    const opened = this.openedObjects.get(objectId)
    if (opened) {
      if (
        mode === AcDbOpenMode.kForWrite &&
        !this.originalStates.has(objectId)
      ) {
        this._openForWriteCalls++
        this.captureOriginalState(opened)
      } else if (mode === AcDbOpenMode.kForWrite) {
        this._openForWriteCalls++
      }
      return opened as T
    }

    const obj = this.lookupObject<T>(objectId, openErased)
    this.openedObjects.set(objectId, obj)

    if (mode === AcDbOpenMode.kForWrite) {
      this._openForWriteCalls++
      this.captureOriginalState(obj)
    }
    return obj
  }

  /**
   * Commits this transaction.
   * After commit, rollback data is discarded.
   */
  commit(): void {
    this.originalStates.clear()
    this.openedObjects.clear()
  }

  /**
   * Aborts this transaction and restores all modified objects.
   */
  abort(): void {
    for (const [id, snapshot] of this.originalStates) {
      const obj = this.openedObjects.get(id)
      if (obj) {
        obj.restoreFrom(snapshot)
      }
    }

    this.originalStates.clear()
    this.openedObjects.clear()
    this.recorder.clear()
  }

  /**
   * Takes the single before-modification snapshot for one object and registers
   * it for both rollback and undo.
   *
   * This is the only place that owns both consumers, which is why the sharing
   * decision lives here and not in {@link AcDbChangeRecorder}: the recorder
   * cannot know whether its caller holds an equivalent snapshot.
   *
   * @param object - Live object opened for write
   */
  private captureOriginalState(object: AcDbObject): void {
    const cloneStart = performance.now()
    const snapshot = object.clonePreservingIdentity()
    this._snapshotCloneMs += performance.now() - cloneStart
    if (this.estimateSnapshotBytes) {
      this._snapshotBytes += this.estimateSnapshotBytes(snapshot)
    }

    this.originalStates.set(object.objectId, snapshot)
    this._uniqueModified++

    const recordStart = performance.now()
    this.recorder.recordModify(
      object,
      this.shareBeforeSnapshot ? snapshot : undefined
    )
    this._recordModifyMs += performance.now() - recordStart

    if (this.shareBeforeSnapshot && this.integrityProbe) {
      this.integrityProbe.watch(object.objectId, snapshot)
    }
  }

  /**
   * Internal object lookup hook.
   *
   * You should connect this to your database or object table.
   */
  protected lookupObject<T extends AcDbObject>(
    objectId: AcDbObjectId,
    _openErased: boolean
  ): T {
    throw new Error(`lookupObject(${objectId}) not implemented`)
  }
}
