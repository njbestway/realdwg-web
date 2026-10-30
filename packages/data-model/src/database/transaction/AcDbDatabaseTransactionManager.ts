import { AcDbObject } from '../../base/index.js'
import { AcDbEntity } from '../../entity/AcDbEntity.js'
import { AcDbDatabase, AcDbLayerModifiedEventArgs } from '../AcDbDatabase.js'
import { AcDbSysVarManager, AcDbSysVarType } from '../AcDbSysVarManager.js'
import {
  AcDbChangeApplier,
  acdbCollectChangeEntities,
  acdbCollectDictionaryChanges,
  acdbCollectLayerModifications
} from './AcDbChangeApplier.js'
import { AcDbChangeContainer } from './AcDbDatabaseChange.js'
import { AcDbDatabaseTransaction } from './AcDbDatabaseTransaction.js'
import {
  AcDbSnapshotIntegrityMetrics,
  AcDbSnapshotIntegrityProbe
} from './AcDbSnapshotSharingIntegrity.js'
import {
  acdbCreateSnapshotSharingMetrics,
  AcDbSnapshotSharingMetrics,
  AcDbSnapshotSizeEstimator
} from './AcDbSnapshotSharingMetrics.js'
import { AcDbUndoStack } from './AcDbUndoStack.js'

/**
 * Pending undo-record payload collected between {@link startUndoMark} and {@link endUndoMark}.
 */
interface AcDbUndoMarkState {
  /** Optional label shown in undo UI */
  label?: string
  /** Changes committed while this undo mark was active */
  pendingChanges: import('./AcDbDatabaseChange.js').AcDbDatabaseChange[]
}

/**
 * Manages database transactions and undo/redo history for one {@link AcDbDatabase}.
 *
 * Aligns with ObjectARX {@code AcDbTransactionManager} semantics and provides
 * undo mark grouping for editor commands.
 */
export class AcDbDatabaseTransactionManager {
  private readonly transactionStack: AcDbDatabaseTransaction[] = []
  private readonly undoStack = new AcDbUndoStack()
  private readonly changeApplier: AcDbChangeApplier
  private readonly undoMarkStack: AcDbUndoMarkState[] = []
  private _applyingUndoRedo = false
  private readonly _pendingEntityModified = new Set<AcDbEntity>()
  private readonly _pendingLayerModified = new Map<
    string,
    AcDbLayerModifiedEventArgs
  >()

  /**
   * When true, mutations outside an active transaction throw an error.
   *
   * Undo/redo replay is exempt so {@link AcDbChangeApplier} can restore state.
   */
  strictMode = false

  /**
   * Phase 2.10 experiment switch: reuse the rollback snapshot as the undo
   * `before` snapshot.
   *
   * While false (the default) a first write clones twice, exactly as in
   * `1.15.16-perf.3`. The A/B harness flips it per session so both arms run the
   * same build. It is read once, when a transaction is created, so flipping it
   * never changes a transaction that is already open.
   */
  snapshotSharing = false

  /**
   * Optional per-snapshot byte estimate, forwarded to every new transaction.
   *
   * Undefined by default so the production path does no estimation work.
   */
  snapshotSizeEstimator: AcDbSnapshotSizeEstimator | undefined

  /** Accumulated phase 2.10 counters; see {@link getSnapshotSharingMetrics}. */
  private readonly _snapshotMetrics = acdbCreateSnapshotSharingMetrics()

  /**
   * Optional shared-snapshot integrity probe (phase 2.11, task A2).
   *
   * Attach one in development and test builds to prove that a snapshot shared
   * between the rollback map and the undo record is never written. Undefined by
   * default, which is what keeps the production performance path free of
   * fingerprinting: the kernel only reads this field.
   */
  snapshotIntegrityProbe: AcDbSnapshotIntegrityProbe | undefined

  /**
   * Creates a transaction manager for one database.
   *
   * @param database - Database whose mutations and undo history are managed
   */
  constructor(private readonly database: AcDbDatabase) {
    this.changeApplier = new AcDbChangeApplier(database)
  }

  /**
   * Starts a new database transaction and pushes it onto the stack.
   *
   * Equivalent to ObjectARX `AcDbTransactionManager::startTransaction()`.
   *
   * @returns The newly created transaction
   */
  startTransaction(): AcDbDatabaseTransaction {
    const tr = new AcDbDatabaseTransaction(this.database, {
      shareBeforeSnapshot: this.snapshotSharing,
      estimateSnapshotBytes: this.snapshotSizeEstimator,
      integrityProbe: this.snapshotIntegrityProbe
    })
    this.transactionStack.push(tr)
    return tr
  }

  /**
   * Returns the top-most active transaction, if any.
   */
  currentTransaction(): AcDbDatabaseTransaction | undefined {
    return this.transactionStack[this.transactionStack.length - 1]
  }

  /**
   * Returns true when at least one transaction is active.
   */
  hasTransaction(): boolean {
    return this.transactionStack.length > 0
  }

  /**
   * Returns true when mutations should be recorded into the current transaction.
   *
   * Recording is disabled while undo/redo is being applied.
   */
  isRecording(): boolean {
    return this.hasTransaction() && !this._applyingUndoRedo
  }

  /**
   * Returns true while {@link AcDbChangeApplier} is replaying undo or redo changes.
   */
  isApplyingUndoRedo(): boolean {
    return this._applyingUndoRedo
  }

  /**
   * Returns true when the object was opened for write in an active transaction.
   *
   * Used by {@link AcDbSymbolTableRecord.assertOpenForWrite} to enforce ObjectARX
   * write semantics. A modify entry in a transaction recorder indicates the object
   * was opened with {@link AcDbOpenMode.kForWrite}, including entries merged from
   * nested transactions.
   *
   * @param objectId - Object identifier to check
   */
  isOpenedForWriteInTransaction(objectId: string): boolean {
    for (const tr of this.transactionStack) {
      if (tr.recorder.hasModify(objectId)) {
        return true
      }
    }
    return false
  }

  /**
   * Commits the current transaction.
   *
   * Nested transactions merge their recorder into the parent. The outermost
   * commit finalizes changes, dispatches events, and enqueues undo history
   * when an undo mark is active.
   *
   * @throws Error if no transaction is active
   */
  commitTransaction(): void {
    const startedAt = performance.now()
    const tr = this.transactionStack.pop()
    if (!tr) {
      throw new Error('No active transaction to commit.')
    }

    if (this.transactionStack.length > 0) {
      const parent = this.transactionStack[this.transactionStack.length - 1]
      parent.recorder.mergeFrom(tr.recorder)
      // The child's recorder counters just rolled up into the parent, so only
      // the transaction-level counters are absorbed here; absorbing the
      // recorder's too would count the merged entries twice.
      this.absorbTransactionCounters(tr, false)
      tr.commit()
      this._snapshotMetrics.commitMs += performance.now() - startedAt
      return
    }

    const finalizeStartedAt = performance.now()
    tr.recorder.finalize(this.database)
    this._snapshotMetrics.finalizeMs += performance.now() - finalizeStartedAt

    // A2: the shared snapshot is about to become undo history, so this is the
    // last moment where a write to it could still be caught before it is read.
    tr.verifySharedSnapshots('commit')

    const changes = tr.recorder.getChanges()
    this.absorbTransactionCounters(tr, true)
    tr.commit()

    if (changes.length > 0) {
      this.dispatchCommitEvents(changes)
      this.enqueueUndoChanges(changes)
    }
    this._snapshotMetrics.commitMs += performance.now() - startedAt
  }

  /**
   * Aborts the current transaction and rolls back all recorded changes.
   *
   * @throws Error if no transaction is active
   */
  abortTransaction(): void {
    const startedAt = performance.now()
    const tr = this.transactionStack.pop()
    if (!tr) {
      throw new Error('No active transaction to abort.')
    }

    const changes = [...tr.recorder.getChanges()]
    // Read the counters before `tr.abort()`, which clears the recorder.
    this.absorbTransactionCounters(tr, true)

    // A2: rollback reads every `originalStates` snapshot, so any write to a
    // shared one has to be reported before `restoreFrom` consumes it.
    tr.verifySharedSnapshots('abort')

    this.database.beginEventBatch()
    this._applyingUndoRedo = true
    try {
      tr.abort()
      if (changes.length > 0) {
        this.changeApplier.applyInverse(changes)
      }
    } finally {
      this._applyingUndoRedo = false
      this.database.endEventBatch()
    }
    this._snapshotMetrics.abortMs += performance.now() - startedAt
  }

  /**
   * Opens an undo-mark group.
   *
   * Commits performed before {@link endUndoMark} are merged into one
   * {@link AcDbUndoRecord}.
   *
   * @param label - Optional label for undo UI (for example, `"Move"`)
   */
  startUndoMark(label?: string): void {
    this.undoMarkStack.push({ label, pendingChanges: [] })
  }

  /**
   * Closes the current undo mark and pushes a record when changes were committed.
   *
   * @throws Error if no undo mark is active
   */
  endUndoMark(): void {
    const mark = this.undoMarkStack.pop()
    if (!mark) {
      throw new Error('No active undo mark to end.')
    }

    if (mark.pendingChanges.length === 0) {
      return
    }

    this.undoStack.push({
      label: mark.label,
      changes: mark.pendingChanges
    })
  }

  /**
   * Discards the current undo mark without creating an undo record.
   */
  cancelUndoMark(): void {
    if (this.undoMarkStack.length > 0) {
      this.undoMarkStack.pop()
    }
  }

  /**
   * Undoes the most recent undo record.
   *
   * @returns True when an undo record was applied; false when the stack is empty
   */
  undo(): boolean {
    const record = this.undoStack.popUndo()
    if (!record) {
      return false
    }

    const startedAt = performance.now()
    this.verifyUndoPayload(record.changes, 'undo')
    this.database.beginEventBatch()
    this._applyingUndoRedo = true
    try {
      this.changeApplier.applyInverse(record.changes)
      this.dispatchUndoRedoEvents(record.changes, true)
    } finally {
      this._applyingUndoRedo = false
      this.database.endEventBatch()
    }
    this._snapshotMetrics.undoMs += performance.now() - startedAt

    this.undoStack.pushRedo(record)
    return true
  }

  /**
   * Redoes the most recently undone record.
   *
   * @returns True when a redo record was applied; false when the redo stack is empty
   */
  redo(): boolean {
    const record = this.undoStack.popRedo()
    if (!record) {
      return false
    }

    const startedAt = performance.now()
    this.verifyUndoPayload(record.changes, 'redo')
    this.database.beginEventBatch()
    this._applyingUndoRedo = true
    try {
      this.changeApplier.applyForward(record.changes)
      this.dispatchUndoRedoEvents(record.changes, false)
    } finally {
      this._applyingUndoRedo = false
      this.database.endEventBatch()
    }
    this._snapshotMetrics.redoMs += performance.now() - startedAt

    this.undoStack.pushUndo(record)
    return true
  }

  /**
   * Returns true when at least one undo record is available.
   */
  canUndo(): boolean {
    return this.undoStack.canUndo()
  }

  /**
   * Returns true when at least one redo record is available.
   */
  canRedo(): boolean {
    return this.undoStack.canRedo()
  }

  /**
   * Clears both undo and redo history for this database.
   */
  clearUndoStack(): void {
    this.undoStack.clear()
  }

  /**
   * Phase 2.10 counters accumulated since {@link resetSnapshotSharingMetrics}.
   *
   * The retained fields are sampled at call time rather than accumulated, so a
   * caller can watch the undo history's own footprint separately from the
   * clone counts. Byte estimates stay 0 unless
   * {@link snapshotSizeEstimator} is set.
   *
   * @returns A copy; mutating it does not affect the manager
   */
  getSnapshotSharingMetrics(): AcDbSnapshotSharingMetrics {
    const metrics = this._snapshotMetrics
    metrics.retainedUndoChanges = this.undoStack.retainedChangeCount
    metrics.retainedSnapshotBytesEstimated = this.estimateRetainedSnapshotBytes()
    return { ...metrics }
  }

  /** Zeroes every counter without touching the undo history. */
  resetSnapshotSharingMetrics(): void {
    Object.assign(this._snapshotMetrics, acdbCreateSnapshotSharingMetrics())
  }

  /**
   * Shared-snapshot integrity counters (phase 2.11, task A2).
   *
   * `enabled: false` when no probe is attached, which is the production
   * default. `copyOnWriteCount === 0` from
   * {@link getSnapshotSharingMetrics} is not evidence that a shared snapshot
   * stayed unchanged; `checks` and `violations` are.
   *
   * @returns A copy; mutating it does not affect the probe
   */
  getSnapshotIntegrityMetrics(): AcDbSnapshotIntegrityMetrics {
    if (!this.snapshotIntegrityProbe) {
      return {
        enabled: false,
        watchedSnapshots: 0,
        checks: 0,
        checkedBoundaries: 0,
        violations: 0,
        evictedSnapshots: 0,
        lastBoundary: null,
        lastPassViolations: 0,
        recentViolations: []
      }
    }
    return this.snapshotIntegrityProbe.getMetrics()
  }

  /**
   * Re-fingerprints the `before` snapshots of one undo record.
   *
   * Undo and redo both read `change.before` through `restoreFrom`, so a write
   * to a shared snapshot shows up here before it can corrupt the replay. Only
   * object changes carry an `AcDbObject` payload; attribute changes are
   * skipped.
   *
   * @param changes - Changes of the record about to be replayed
   * @param boundary - `undo` or `redo`
   */
  private verifyUndoPayload(
    changes: readonly import('./AcDbDatabaseChange.js').AcDbDatabaseChange[],
    boundary: 'undo' | 'redo'
  ): void {
    const probe = this.snapshotIntegrityProbe
    if (!probe || !this.snapshotSharing) return

    let violations = 0
    for (const change of changes) {
      if (change.kind !== 'modify') continue
      const before = change.before
      if (!(before instanceof AcDbObject)) continue
      if (!probe.check(change.objectId, before, boundary)) violations++
    }
    probe.noteBoundary(boundary, violations)
  }

  /**
   * Adds caller-measured transform time to the metrics.
   *
   * The kernel never sees the transform itself — a caller mutates the opened
   * object — so the harness reports its own measurement here instead of the
   * kernel inventing one.
   *
   * @param ms - Milliseconds spent transforming in the measured window
   */
  addSnapshotTransformMs(ms: number): void {
    this._snapshotMetrics.transformMs += ms
  }

  /**
   * Folds one transaction's counters into the accumulated metrics.
   *
   * @param tr - Transaction that is leaving the stack
   * @param includeRecorder - False for a nested commit, whose recorder counters
   *   have already rolled up into the parent via `mergeFrom`
   */
  private absorbTransactionCounters(
    tr: AcDbDatabaseTransaction,
    includeRecorder: boolean
  ): void {
    const metrics = this._snapshotMetrics
    metrics.openedForWrite += tr.openedForWrite
    metrics.uniqueModifiedObjects += tr.uniqueModifiedObjects
    metrics.rollbackSnapshotClones += tr.rollbackSnapshotClones
    metrics.snapshotBytesEstimated += tr.snapshotBytes
    metrics.openForWriteMs += tr.snapshotCloneMs
    metrics.recordModifyMs += tr.recordModifyMs

    if (!includeRecorder) return
    metrics.beforeSnapshotClones += tr.recorder.beforeSnapshotClones
    metrics.afterSnapshotClones += tr.recorder.afterSnapshotClones
    metrics.sharedBeforeSnapshotCount += tr.recorder.sharedBeforeSnapshotCount
  }

  /** Estimated bytes of every snapshot the undo/redo stacks currently hold. */
  private estimateRetainedSnapshotBytes(): number {
    const estimate = this.snapshotSizeEstimator
    if (!estimate) return 0

    let total = 0
    this.undoStack.forEachChange(change => {
      if (change.kind === 'modify') {
        if (change.before) total += estimate(change.before)
        if (change.after) total += estimate(change.after)
      } else if (change.kind !== 'sysvar') {
        total += estimate(change.object)
      }
    })
    return total
  }

  /**
   * Records append of an object into a container during the active transaction.
   *
   * No-op when {@link isRecording} is false.
   *
   * @param container - Container that received the object
   * @param object - Object that was appended
   */
  recordAppend(container: AcDbChangeContainer, object: AcDbObject): void {
    if (!this.isRecording()) {
      return
    }
    this.currentTransaction()?.recorder.recordAppend(container, object)
  }

  /**
   * Records removal of an object from a container during the active transaction.
   *
   * No-op when {@link isRecording} is false.
   *
   * @param container - Container that owned the removed object
   * @param object - Object that was removed
   */
  recordRemove(container: AcDbChangeContainer, object: AcDbObject): void {
    if (!this.isRecording()) {
      return
    }
    this.currentTransaction()?.recorder.recordRemove(container, object)
  }

  /**
   * Records the pre-change value of a system variable.
   *
   * No-op when {@link isRecording} is false.
   *
   * @param name - System variable name
   * @param before - Value observed before mutation
   */
  recordSysvar(name: string, before: unknown): void {
    if (!this.isRecording()) {
      return
    }
    this.currentTransaction()?.recorder.recordSysvar(name, before)
  }

  /**
   * Maps a symbol table instance to the stable name stored in undo records.
   *
   * @param table - Symbol table whose logical name is needed
   * @returns Known table name, or the table's object ID as a fallback
   */
  resolveSymbolTableName(table: { objectId: string }): string {
    const tables = this.database.tables
    if (table === tables.appIdTable) return 'appIdTable'
    if (table === tables.blockTable) return 'blockTable'
    if (table === tables.dimStyleTable) return 'dimStyleTable'
    if (table === tables.linetypeTable) return 'linetypeTable'
    if (table === tables.textStyleTable) return 'textStyleTable'
    if (table === tables.viewTable) return 'viewTable'
    if (table === tables.layerTable) return 'layerTable'
    if (table === tables.viewportTable) return 'viewportTable'
    return table.objectId
  }

  /**
   * Runs one undoable editor command inside a transaction and undo mark.
   *
   * On success the transaction is committed and the undo mark is closed.
   * On failure the transaction is aborted and the undo mark is cancelled.
   *
   * @param label - Label stored on the resulting undo record
   * @param fn - Callback that performs the command using the active transaction
   * @returns The value returned by `fn`
   */
  runUndoable<T>(label: string, fn: (tr: AcDbDatabaseTransaction) => T): T {
    this.startUndoMark(label)
    this.startTransaction()
    try {
      const result = fn(this.currentTransaction()!)
      this.commitTransaction()
      this.endUndoMark()
      return result
    } catch (error) {
      if (this.hasTransaction()) {
        this.abortTransaction()
      }
      this.cancelUndoMark()
      throw error
    }
  }

  /**
   * Appends committed changes to the active undo mark, if any.
   *
   * Called after the outermost transaction commit so multiple commits within
   * one {@link startUndoMark} group merge into a single {@link AcDbUndoRecord}.
   *
   * @param changes - Finalized changes from the committed transaction
   */
  private enqueueUndoChanges(
    changes: import('./AcDbDatabaseChange.js').AcDbDatabaseChange[]
  ): void {
    const activeMark = this.undoMarkStack[this.undoMarkStack.length - 1]
    if (!activeMark) {
      return
    }

    for (const change of changes) {
      activeMark.pendingChanges.push(change)
    }
  }

  /**
   * Dispatches entity, dictionary, and sysvar events after a successful commit.
   *
   * @param changes - Finalized changes from the committed outermost transaction
   */
  private dispatchCommitEvents(
    changes: import('./AcDbDatabaseChange.js').AcDbDatabaseChange[]
  ): void {
    const { modified, appended, erased } = acdbCollectChangeEntities(
      this.database,
      changes
    )

    for (const entity of modified) {
      this.dispatchEntityModified(entity)
    }
    if (appended.length > 0) {
      this.database.notifyEntityAppended(appended)
    }
    if (erased.length > 0) {
      this.database.notifyEntityErased(erased)
    }

    const { set: dictSet, erased: dictErased } = acdbCollectDictionaryChanges(
      this.database,
      changes
    )
    for (const { object, key } of dictSet) {
      this.database.notifyDictObjectSet(object, key)
    }
    for (const { object, key } of dictErased) {
      this.database.notifyDictObjectErased(object, key)
    }

    for (const change of changes) {
      if (change.kind === 'sysvar' && change.after !== undefined) {
        AcDbSysVarManager.instance().events.sysVarChanged.dispatch({
          database: this.database,
          name: change.name,
          oldVal: change.before as AcDbSysVarType,
          newVal: change.after as AcDbSysVarType
        })
      }
    }

    for (const args of acdbCollectLayerModifications(this.database, changes)) {
      this.dispatchLayerModified(args)
    }
  }

  /**
   * Dispatches entity, dictionary, and sysvar events after undo or redo replay.
   *
   * Append/remove and dictionary notifications are swapped when `inverse` is
   * true so listeners observe the same semantics as the user-facing operation.
   *
   * @param changes - Changes from the undo record being applied
   * @param inverse - True when undoing (inverse replay); false when redoing
   */
  private dispatchUndoRedoEvents(
    changes: import('./AcDbDatabaseChange.js').AcDbDatabaseChange[],
    inverse: boolean
  ): void {
    const { modified, appended, erased } = acdbCollectChangeEntities(
      this.database,
      changes
    )

    const { set: dictSet, erased: dictErased } = acdbCollectDictionaryChanges(
      this.database,
      changes
    )

    if (inverse) {
      for (const entity of modified) {
        this.dispatchEntityModified(entity)
      }
      if (erased.length > 0) {
        this.database.notifyEntityAppended(erased)
      }
      if (appended.length > 0) {
        this.database.notifyEntityErased(appended)
      }
      for (const { object, key } of dictErased) {
        this.database.notifyDictObjectSet(object, key)
      }
      for (const { object, key } of dictSet) {
        this.database.notifyDictObjectErased(object, key)
      }
    } else {
      for (const entity of modified) {
        this.dispatchEntityModified(entity)
      }
      if (appended.length > 0) {
        this.database.notifyEntityAppended(appended)
      }
      if (erased.length > 0) {
        this.database.notifyEntityErased(erased)
      }
      for (const { object, key } of dictSet) {
        this.database.notifyDictObjectSet(object, key)
      }
      for (const { object, key } of dictErased) {
        this.database.notifyDictObjectErased(object, key)
      }
    }

    for (const change of changes) {
      if (change.kind === 'sysvar') {
        const oldVal = inverse ? change.after : change.before
        const newVal = inverse ? change.before : change.after
        if (newVal !== undefined) {
          AcDbSysVarManager.instance().events.sysVarChanged.dispatch({
            database: this.database,
            name: change.name,
            oldVal: oldVal as AcDbSysVarType,
            newVal: newVal as AcDbSysVarType
          })
        }
      }
    }

    for (const args of acdbCollectLayerModifications(
      this.database,
      changes,
      inverse
    )) {
      this.dispatchLayerModified(args)
    }
  }

  /**
   * Dispatches or queues a layer-modified notification after commit or undo/redo.
   */
  private dispatchLayerModified(args: AcDbLayerModifiedEventArgs): void {
    if (this.database.isEventBatched()) {
      const existing = this._pendingLayerModified.get(args.layer.objectId)
      if (existing) {
        existing.changes = { ...existing.changes, ...args.changes }
        return
      }
      this._pendingLayerModified.set(args.layer.objectId, {
        database: args.database,
        layer: args.layer,
        changes: { ...args.changes }
      })
      return
    }
    this.database.events.layerModified.dispatch(args)
  }

  /**
   * Dispatches or queues an entity-modified notification after commit or undo/redo.
   */
  private dispatchEntityModified(entity: AcDbEntity): void {
    if (this.database.isEventBatched()) {
      this._pendingEntityModified.add(entity)
      return
    }
    this.database.events.entityModified.dispatch({
      database: this.database,
      entity
    })
  }

  /**
   * Dispatches layer-modified notifications accumulated during event batching.
   *
   * Called from {@link AcDbDatabase.endEventBatch} when the outermost batch closes.
   */
  flushPendingLayerModifiedEvents(): void {
    if (this._pendingLayerModified.size === 0) {
      return
    }

    const pending = [...this._pendingLayerModified.values()]
    this._pendingLayerModified.clear()
    for (const args of pending) {
      this.database.events.layerModified.dispatch(args)
    }
  }

  /**
   * Dispatches entity-modified notifications accumulated during event batching.
   *
   * Called from {@link AcDbDatabase.endEventBatch} when the outermost batch closes.
   */
  flushPendingEntityModifiedEvents(): void {
    if (this._pendingEntityModified.size === 0) {
      return
    }

    const modified = [...this._pendingEntityModified]
    this._pendingEntityModified.clear()
    for (const entity of modified) {
      this.database.events.entityModified.dispatch({
        database: this.database,
        entity
      })
    }
  }
}
