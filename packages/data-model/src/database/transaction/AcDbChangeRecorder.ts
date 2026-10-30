import { AcDbObject } from '../../base/index.js'
import { AcDbDatabase } from '../AcDbDatabase.js'
import { AcDbSysVarManager } from '../AcDbSysVarManager.js'
import {
  acdbAreChangeContainersEqual,
  AcDbChangeContainer,
  AcDbDatabaseChange} from './AcDbDatabaseChange.js'

/** Recorded `modify` entry. */
type AcDbModifyChange = Extract<AcDbDatabaseChange, { kind: 'modify' }>

/** Recorded `sysvar` entry. */
type AcDbSysvarChange = Extract<AcDbDatabaseChange, { kind: 'sysvar' }>

/** Recorded `append` / `remove` entry. */
type AcDbStructuralChange = Extract<
  AcDbDatabaseChange,
  { kind: 'append' | 'remove' }
>

/**
 * Separator used to build structural index keys.
 *
 * Neither object ids (hex handles), symbol table names, nor dictionary keys can
 * contain NUL, so joining with it is unambiguous for every container variant.
 */
const KEY_SEPARATOR = '\u0000'

/**
 * Accumulates structured database changes during an active transaction.
 *
 * Append/remove pairs that cancel within the same transaction are coalesced,
 * and duplicate modify/sysvar entries for the same target are ignored.
 *
 * `changes` stays the single source of truth for ordering and is what
 * {@link getChanges} hands to the transaction manager, the event dispatcher and
 * the undo record. Alongside it the recorder keeps three indexes so that a
 * bulk edit never rescans the change log:
 *
 * - `modifyById` - `objectId -> modify entry` (first write wins);
 * - `sysvarByName` - `normalized name -> sysvar entry` (first write wins);
 * - `structuralByKey` - `kind/container/objectId -> live append or remove`
 *   entries, in insertion order.
 *
 * Index updates are O(1). Cancelling an append/remove pair tombstones the
 * earlier entry and drops the new one, exactly like the previous
 * `splice(index, 1)`, but without shifting the array or invalidating the other
 * indexes; {@link compact} removes the tombstones in one linear pass the next
 * time the change log is read. A transaction that records N changes therefore
 * costs O(N) instead of O(N^2).
 */
export class AcDbChangeRecorder {
  private readonly changes: AcDbDatabaseChange[] = []

  /** First `modify` entry recorded per object id. */
  private readonly modifyById = new Map<string, AcDbModifyChange>()

  /** First `sysvar` entry recorded per normalized name. */
  private readonly sysvarByName = new Map<string, AcDbSysvarChange>()

  /**
   * Live append/remove entries per `kind/container/objectId`.
   *
   * A container can legitimately see the same object appended twice (for
   * example a re-append after a failed insert), and the previous linear scan
   * cancelled the *earliest* match, so the queue is kept in insertion order.
   */
  private readonly structuralByKey = new Map<string, AcDbStructuralChange[]>()

  /**
   * Structural entries that were cancelled by their opposite change.
   *
   * They are still referenced by `changes` until {@link compact} runs, which is
   * why they carry a membership test instead of being removed immediately.
   */
  private readonly cancelledStructurals = new Set<AcDbDatabaseChange>()

  /** Modify entries whose `before` was supplied by the caller (phase 2.10). */
  private _sharedBeforeSnapshotCount = 0

  /** Modify entries that cloned their own `before`. */
  private _beforeSnapshotClones = 0

  /** `after` snapshots taken by {@link finalize}. */
  private _afterSnapshotClones = 0

  /**
   * Returns the changes recorded so far in this transaction.
   *
   * The returned array is the internal store; callers should treat it as read-only.
   */
  getChanges(): AcDbDatabaseChange[] {
    this.compact()
    return this.changes
  }

  /**
   * Discards all recorded changes without applying them.
   */
  clear(): void {
    this.changes.length = 0
    this.modifyById.clear()
    this.sysvarByName.clear()
    this.structuralByKey.clear()
    this.cancelledStructurals.clear()
  }

  /**
   * Merges changes from a nested transaction into this recorder.
   *
   * Used when an inner transaction commits into its parent without touching
   * the undo stack.
   *
   * @param other - Recorder from a child transaction being committed
   */
  mergeFrom(other: AcDbChangeRecorder): void {
    for (const change of other.getChanges()) {
      this.mergeChange(change)
    }
    // A merged child no longer exists as a transaction, so its per-transaction
    // counters have to roll up here or the phase 2.10 metrics would lose them.
    this._sharedBeforeSnapshotCount += other.sharedBeforeSnapshotCount
    this._beforeSnapshotClones += other.beforeSnapshotClones
    this._afterSnapshotClones += other.afterSnapshotClones
  }

  /**
   * Records the pre-modification snapshot of an opened-for-write object.
   *
   * Only the first modify entry per {@link AcDbObject.objectId} is kept.
   *
   * @param object - Object whose state should be restorable on abort/undo
   * @param beforeSnapshot - Optional already-taken snapshot of `object` that the
   *   caller owns. `AcDbTransaction` passes the rollback snapshot here so the
   *   transaction keeps one before state instead of two; the recorder then never
   *   clones. Omitted by every other caller, which keeps the previous behaviour.
   */
  recordModify(object: AcDbObject, beforeSnapshot?: AcDbObject): void {
    const objectId = object.objectId
    if (this.modifyById.has(objectId)) {
      return
    }
    const change: AcDbModifyChange = {
      kind: 'modify',
      objectId,
      before: beforeSnapshot ?? object.clonePreservingIdentity()
    }
    if (beforeSnapshot) {
      this._sharedBeforeSnapshotCount++
    } else {
      this._beforeSnapshotClones++
    }
    this.modifyById.set(objectId, change)
    this.changes.push(change)
  }

  /**
   * Number of modify entries whose `before` was supplied by the caller.
   *
   * Phase 2.10 diagnostic: each of these is one deep clone the transaction did
   * not have to perform, because it reused the snapshot it already held for
   * rollback.
   */
  get sharedBeforeSnapshotCount(): number {
    return this._sharedBeforeSnapshotCount
  }

  /** Number of modify entries that had to clone their own `before`. */
  get beforeSnapshotClones(): number {
    return this._beforeSnapshotClones
  }

  /** Number of `after` snapshots taken by {@link finalize}. */
  get afterSnapshotClones(): number {
    return this._afterSnapshotClones
  }

  /**
   * Returns true when a modify entry exists for the given object ID.
   *
   * Used by {@link AcDbDatabaseTransactionManager.isOpenedForWriteInTransaction}
   * to determine whether a symbol table record was opened for write within the
   * active transaction stack.
   *
   * @param objectId - Object identifier to look up
   */
  hasModify(objectId: string): boolean {
    return this.modifyById.has(objectId)
  }

  /**
   * Records insertion of an object into a database container.
   *
   * If a matching remove was recorded earlier in the same transaction,
   * the pair cancels and neither change is retained.
   *
   * @param container - Container that received the object
   * @param object - Object that was appended; stored as an identity-preserving clone
   */
  recordAppend(container: AcDbChangeContainer, object: AcDbObject): void {
    this.recordStructuralChange({
      kind: 'append',
      container,
      object: object.clonePreservingIdentity()
    })
  }

  /**
   * Records removal of an object from a database container.
   *
   * If a matching append was recorded earlier in the same transaction,
   * the pair cancels and neither change is retained.
   *
   * @param container - Container that owned the removed object
   * @param object - Object that was removed; stored as an identity-preserving clone
   */
  recordRemove(container: AcDbChangeContainer, object: AcDbObject): void {
    this.recordStructuralChange({
      kind: 'remove',
      container,
      object: object.clonePreservingIdentity()
    })
  }

  /**
   * Records the value of a system variable before mutation.
   *
   * Only the first sysvar entry per normalized name is kept.
   *
   * @param name - System variable name (case-insensitive)
   * @param before - Value observed before the mutation
   */
  recordSysvar(name: string, before: unknown): void {
    const normalizedName = name.toLowerCase()
    if (this.sysvarByName.has(normalizedName)) {
      return
    }
    const change: AcDbSysvarChange = {
      kind: 'sysvar',
      name: normalizedName,
      before
    }
    this.sysvarByName.set(normalizedName, change)
    this.changes.push(change)
  }

  /**
   * Captures the post-change state for modify and sysvar entries at commit time.
   *
   * Append/remove entries are complete when recorded and do not require
   * finalization.
   *
   * @param database - Database used to read live post-commit values
   */
  finalize(database: AcDbDatabase): void {
    // Drop cancelled pairs first so finalize never clones an object whose
    // append/remove was cancelled (its state is unchanged by definition).
    this.compact()
    for (const change of this.changes) {
      if (change.kind === 'modify') {
        const object = database.getObjectById(change.objectId)
        if (object) {
          change.after = object.clonePreservingIdentity()
          this._afterSnapshotClones++
        }
      } else if (change.kind === 'sysvar') {
        change.after = this.getSysvarValue(database, change.name)
      }
    }
  }

  /**
   * Checks that every index agrees with the ordered change log.
   *
   * Intended for tests and for diagnosing a suspicious undo record: it walks
   * the whole log, so it is O(N) and must not be called on a hot path.
   *
   * @returns Human-readable problems; an empty array means the recorder is consistent
   */
  validateIndexes(): string[] {
    // Cancelled structural entries live in `changes` until the next read; fold
    // them away first so the check compares indexes against the live log only.
    this.compact()

    const problems: string[] = []

    if (this.cancelledStructurals.size > 0) {
      problems.push(
        `change log still holds ${this.cancelledStructurals.size} cancelled structural change(s)`
      )
    }

    const seen = new Set<AcDbDatabaseChange>()
    const expectedModify = new Map<string, AcDbDatabaseChange>()
    const expectedSysvar = new Map<string, AcDbDatabaseChange>()
    const expectedStructural = new Map<string, AcDbDatabaseChange[]>()
    const containersByKey = new Map<string, AcDbChangeContainer>()

    for (const change of this.changes) {
      if (seen.has(change)) {
        problems.push(`duplicate entry in change log (${describe(change)})`)
      }
      seen.add(change)

      if (change.kind === 'modify') {
        if (expectedModify.has(change.objectId)) {
          problems.push(`duplicate modify entry for ${change.objectId}`)
        }
        expectedModify.set(change.objectId, change)
        continue
      }

      if (change.kind === 'sysvar') {
        if (expectedSysvar.has(change.name)) {
          problems.push(`duplicate sysvar entry for ${change.name}`)
        }
        expectedSysvar.set(change.name, change)
        continue
      }

      const key = structuralKey(
        change.kind,
        change.container,
        change.object.objectId
      )
      const bucket = expectedStructural.get(key)
      if (bucket) {
        bucket.push(change)
      } else {
        expectedStructural.set(key, [change])
      }

      const container = containersByKey.get(key)
      if (!container) {
        containersByKey.set(key, change.container)
      } else if (!acdbAreChangeContainersEqual(container, change.container)) {
        problems.push(
          `structural key collision: ${describeContainer(container)} vs ${describeContainer(change.container)}`
        )
      }
    }

    compareMap('modify', expectedModify, this.modifyById, problems)
    compareMap('sysvar', expectedSysvar, this.sysvarByName, problems)

    for (const [key, expected] of expectedStructural) {
      const actual = this.structuralByKey.get(key)
      if (!actual) {
        problems.push(`structural index is missing key ${key}`)
        continue
      }
      if (actual.length !== expected.length) {
        problems.push(
          `structural index size mismatch for ${key}: ${actual.length} indexed vs ${expected.length} logged`
        )
        continue
      }
      for (let index = 0; index < expected.length; index++) {
        if (actual[index] !== expected[index]) {
          problems.push(`structural index order mismatch for ${key} at ${index}`)
          break
        }
      }
    }
    for (const key of this.structuralByKey.keys()) {
      if (!expectedStructural.has(key)) {
        problems.push(`structural index holds orphan key ${key}`)
      }
    }

    return problems
  }

  /**
   * Records or coalesces one append/remove change.
   *
   * When an opposite structural change for the same container and object ID
   * already exists in this transaction, both entries cancel and neither is kept.
   *
   * @param change - Append or remove entry to merge into the recorder
   */
  private recordStructuralChange(change: AcDbStructuralChange): void {
    const oppositeKind = change.kind === 'append' ? 'remove' : 'append'
    const objectId = change.object.objectId
    const oppositeKey = structuralKey(oppositeKind, change.container, objectId)
    const opposite = this.structuralByKey.get(oppositeKey)

    if (opposite && opposite.length > 0) {
      // Mirror the previous `splice(cancelIndex, 1)`: the earliest recorded
      // opposite change disappears from the log and the new one is dropped.
      const cancelled = opposite.shift()
      if (opposite.length === 0) {
        this.structuralByKey.delete(oppositeKey)
      }
      if (cancelled) {
        this.cancelledStructurals.add(cancelled)
      }
      return
    }

    const key = structuralKey(change.kind, change.container, objectId)
    const bucket = this.structuralByKey.get(key)
    if (bucket) {
      bucket.push(change)
    } else {
      this.structuralByKey.set(key, [change])
    }
    this.changes.push(change)
  }

  /**
   * Merges one change from a nested transaction into this recorder.
   *
   * Modify and sysvar entries deduplicate by object ID or variable name;
   * structural entries use the same cancel/coalesce rules as {@link recordAppend}.
   *
   * @param change - Change copied from a child transaction recorder
   */
  private mergeChange(change: AcDbDatabaseChange): void {
    if (change.kind === 'modify') {
      if (!this.modifyById.has(change.objectId)) {
        this.modifyById.set(change.objectId, change)
        this.changes.push(change)
      }
      return
    }

    if (change.kind === 'sysvar') {
      if (!this.sysvarByName.has(change.name)) {
        this.sysvarByName.set(change.name, change)
        this.changes.push(change)
      }
      return
    }

    this.recordStructuralChange(change)
  }

  /**
   * Removes tombstoned structural entries from the ordered log.
   *
   * Runs in one pass, in place, so any array reference previously returned by
   * {@link getChanges} keeps observing the same live change set. No-op when
   * nothing was cancelled, which is the common case.
   */
  private compact(): void {
    if (this.cancelledStructurals.size === 0) {
      return
    }

    let write = 0
    for (let read = 0; read < this.changes.length; read++) {
      const change = this.changes[read]
      if (this.cancelledStructurals.has(change)) {
        continue
      }
      this.changes[write] = change
      write++
    }
    this.changes.length = write
    this.cancelledStructurals.clear()
  }

  /**
   * Reads the current value of a system variable from the database.
   *
   * @param database - Database passed to {@link AcDbSysVarManager.getVar}
   * @param name - Normalized system variable name
   * @returns Live variable value used to populate `after` during {@link finalize}
   */
  private getSysvarValue(database: AcDbDatabase, name: string): unknown {
    return AcDbSysVarManager.instance().getVar(name, database)
  }
}

/**
 * Builds the structural index key for one append/remove target.
 *
 * Mirrors {@link acdbAreChangeContainersEqual}: two containers produce the same
 * key exactly when that predicate would return true. `type` participates in the
 * key so a `blockTableRecord` never matches a `dictionary` that happens to share
 * an id.
 *
 * @param kind - Append or remove
 * @param container - Container descriptor
 * @param objectId - Object identifier of the affected record
 * @returns Index key
 */
function structuralKey(
  kind: 'append' | 'remove',
  container: AcDbChangeContainer,
  objectId: string
): string {
  switch (container.type) {
    case 'blockTableRecord':
      return `${kind}${KEY_SEPARATOR}blockTableRecord${KEY_SEPARATOR}${container.ownerId}${KEY_SEPARATOR}${objectId}`
    case 'symbolTable':
      return `${kind}${KEY_SEPARATOR}symbolTable${KEY_SEPARATOR}${container.tableName}${KEY_SEPARATOR}${objectId}`
    case 'dictionary':
      return `${kind}${KEY_SEPARATOR}dictionary${KEY_SEPARATOR}${container.dictionaryId}${KEY_SEPARATOR}${container.key}${KEY_SEPARATOR}${objectId}`
  }
}

/** Compares one index map against the entries derived from the change log. */
function compareMap(
  label: string,
  expected: Map<string, AcDbDatabaseChange>,
  actual: Map<string, AcDbDatabaseChange>,
  problems: string[]
): void {
  for (const [key, change] of expected) {
    const indexed = actual.get(key)
    if (!indexed) {
      problems.push(`${label} index is missing ${key}`)
    } else if (indexed !== change) {
      problems.push(`${label} index points at a different entry for ${key}`)
    }
  }
  for (const key of actual.keys()) {
    if (!expected.has(key)) {
      problems.push(`${label} index holds orphan ${key}`)
    }
  }
}

/** Short description of one change, used in validation messages. */
function describe(change: AcDbDatabaseChange): string {
  if (change.kind === 'modify') return `modify ${change.objectId}`
  if (change.kind === 'sysvar') return `sysvar ${change.name}`
  return `${change.kind} ${change.object.objectId} in ${describeContainer(change.container)}`
}

/** Short description of one container, used in validation messages. */
function describeContainer(container: AcDbChangeContainer): string {
  switch (container.type) {
    case 'blockTableRecord':
      return `btr:${container.ownerId}`
    case 'symbolTable':
      return `table:${container.tableName}`
    case 'dictionary':
      return `dict:${container.dictionaryId}/${container.key}`
  }
}
