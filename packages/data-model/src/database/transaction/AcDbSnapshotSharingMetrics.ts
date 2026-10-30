import type { AcDbObject } from '../../base/index.js'

/**
 * Phase 2.10 snapshot-sharing counters, accumulated per transaction manager.
 *
 * The interface is the measurement contract: every field either counts an
 * operation that the transaction kernel performs (`*Clones`, `*Ms`) or a value
 * it can observe (`retained*`). Fields that this layer cannot know — a caller's
 * transform time, the byte size of a snapshot — are fed in through
 * {@link AcDbDatabaseTransactionManager.addSnapshotTransformMs} and
 * `snapshotSizeEstimator` instead of being invented here.
 *
 * `copyOnWriteCount` exists to be falsifiable: sharing needs no copy-on-write
 * because no code path ever writes a snapshot, so the counter must stay at
 * zero. If it ever moves, the ownership audit's premise is wrong.
 */
export interface AcDbSnapshotSharingMetrics {
  /** Open-for-write calls, repeated opens of the same object included. */
  openedForWrite: number
  /** Distinct objects that received a rollback snapshot. */
  uniqueModifiedObjects: number
  /** Rollback snapshots taken (`originalStates`). */
  rollbackSnapshotClones: number
  /** `before` snapshots the recorder had to clone itself. */
  beforeSnapshotClones: number
  /** `after` snapshots taken by `finalize` (redo payload). */
  afterSnapshotClones: number
  /** `before` snapshots reused from the rollback snapshot. */
  sharedBeforeSnapshotCount: number
  /** Must stay 0: no copy-on-write layer exists. */
  copyOnWriteCount: number
  /** Estimated bytes of the `before` snapshots, when an estimator is set. */
  snapshotBytesEstimated: number
  /** Milliseconds spent taking rollback snapshots. */
  openForWriteMs: number
  /** Milliseconds spent inside `recordModify`. */
  recordModifyMs: number
  /** Milliseconds the caller reported as transform time. */
  transformMs: number
  /** Milliseconds spent finalizing changes at commit. */
  finalizeMs: number
  /** Milliseconds spent in `commitTransaction`, finalize included. */
  commitMs: number
  /** Milliseconds spent in `undo`. */
  undoMs: number
  /** Milliseconds spent in `redo`. */
  redoMs: number
  /** Milliseconds spent in `abortTransaction`. */
  abortMs: number
  /** Modify entries currently retained by the undo and redo stacks. */
  retainedUndoChanges: number
  /** Estimated bytes of the retained undo/redo changes. */
  retainedSnapshotBytesEstimated: number
}

/**
 * Per-snapshot size estimate used for the byte metrics.
 *
 * Supplied by the benchmark harness (for example from `AcDbMemoryEstimator`)
 * so the kernel never has to guess how big an entity snapshot is.
 */
export type AcDbSnapshotSizeEstimator = (object: AcDbObject) => number

/** Fresh zeroed counters; exported so the manager and tests agree on the shape. */
export function acdbCreateSnapshotSharingMetrics(): AcDbSnapshotSharingMetrics {
  return {
    openedForWrite: 0,
    uniqueModifiedObjects: 0,
    rollbackSnapshotClones: 0,
    beforeSnapshotClones: 0,
    afterSnapshotClones: 0,
    sharedBeforeSnapshotCount: 0,
    copyOnWriteCount: 0,
    snapshotBytesEstimated: 0,
    openForWriteMs: 0,
    recordModifyMs: 0,
    transformMs: 0,
    finalizeMs: 0,
    commitMs: 0,
    undoMs: 0,
    redoMs: 0,
    abortMs: 0,
    retainedUndoChanges: 0,
    retainedSnapshotBytesEstimated: 0
  }
}
