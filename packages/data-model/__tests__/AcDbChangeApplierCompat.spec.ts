import { AcGePoint3d } from '@mlightcad/geometry-engine'

import { AcDbBlockTableRecord } from '../src/database/AcDbBlockTableRecord'
import { AcDbDatabase } from '../src/database/AcDbDatabase'
import { AcDbChangeApplier } from '../src/database/transaction/AcDbChangeApplier'
import type { AcDbDatabaseChange } from '../src/database/transaction/AcDbDatabaseChange'
import { AcDbEntity } from '../src/entity/AcDbEntity'
import { AcDbLine } from '../src/entity/AcDbLine'

/**
 * Invocation-context coverage for the batched forward replay
 * (SPEC-CAD-001 Phase 2.8, Task A2).
 *
 * Phase 2.7 collapsed a maximal run of consecutive removals from one block
 * table record into a single `removeEntity(ids)` call. Only one caller exists
 * in the product — `AcDbDatabaseTransactionManager.redo()`, which always runs
 * inside `_applyingUndoRedo` — but `applyForward` is public, so the other two
 * contexts (direct call, call inside an open transaction) have to be pinned
 * down as well:
 *
 *   1. redo through the transaction manager,
 *   2. direct call with no transaction on the stack,
 *   3. call from inside an active transaction (unsupported, but must not
 *      silently change behaviour).
 *
 * `replayPerChange` is the pre-2.7 implementation kept as the oracle: it
 * applies one change at a time, in array order, through the same container
 * primitives.
 */

/** Object ids of a block table record, in array order. */
function idsOf(btr: AcDbBlockTableRecord): string[] {
  const ids: string[] = []
  for (const entity of btr.newIterator()) ids.push(entity.objectId)
  return ids
}

/** Sorted copy of an id list. */
function sortedIds(ids: string[]): string[] {
  return [...ids].sort()
}

/** Builds a document with `count` model-space lines. */
function createDocument(count: number): {
  db: AcDbDatabase
  btr: AcDbBlockTableRecord
  ids: string[]
} {
  const db = new AcDbDatabase()
  const btr = db.tables.blockTable.modelSpace
  for (let index = 0; index < count; index++) {
    btr.appendEntity(
      new AcDbLine(
        new AcGePoint3d(index, 0, 0),
        new AcGePoint3d(index + 10, 1, 0)
      )
    )
  }
  return { db, btr, ids: idsOf(btr) }
}

/** Adds a named block definition holding `count` lines. */
function addBlockDefinition(
  db: AcDbDatabase,
  name: string,
  count: number
): { btr: AcDbBlockTableRecord; ids: string[] } {
  const btr = new AcDbBlockTableRecord()
  btr.name = name
  db.tables.blockTable.add(btr)
  btr.database = db
  for (let index = 0; index < count; index++) {
    btr.appendEntity(
      new AcDbLine(new AcGePoint3d(index, 0, 0), new AcGePoint3d(index, 1, 0))
    )
  }
  return { btr, ids: idsOf(btr) }
}

/** Records `entityErased` / `entityAppended` payloads in dispatch order. */
function recordEvents(db: AcDbDatabase) {
  const erased: string[][] = []
  const appended: string[][] = []
  const asIds = (payload: unknown): string[] => {
    const items = Array.isArray(payload) ? payload : [payload]
    return items.map(item => (item as AcDbEntity).objectId)
  }
  const erasedListener = (args: { entity: unknown }) =>
    erased.push(asIds(args.entity))
  const appendedListener = (args: { entity: unknown }) =>
    appended.push(asIds(args.entity))
  db.events.entityErased.addEventListener(erasedListener)
  db.events.entityAppended.addEventListener(appendedListener)
  return {
    erased,
    appended,
    dispose: () => {
      db.events.entityErased.removeEventListener(erasedListener)
      db.events.entityAppended.removeEventListener(appendedListener)
    }
  }
}

/**
 * The pre-2.7 forward replay, kept here as the reference implementation.
 *
 * It applies one change at a time in array order, exactly like `applyForward`
 * did before the run aggregation.
 */
function replayPerChange(db: AcDbDatabase, changes: AcDbDatabaseChange[]) {
  for (const change of changes) {
    if (change.kind === 'modify') {
      const object = db.getObjectById(change.objectId)
      if (object && change.after) object.restoreFrom(change.after)
      continue
    }
    if (change.kind !== 'append' && change.kind !== 'remove') continue
    if (change.container.type !== 'blockTableRecord') continue
    const btr = db.tables.blockTable.getIdAt(change.container.ownerId)
    if (!btr) continue
    if (change.kind === 'append') {
      btr.appendEntity(change.object as AcDbEntity)
    } else {
      btr.removeEntity(change.object.objectId)
    }
  }
}

/** Counts `removeEntity` calls and the ids each call carried. */
function spyOnRemoveEntity() {
  const spy = jest.spyOn(AcDbBlockTableRecord.prototype, 'removeEntity')
  return {
    calls: () =>
      spy.mock.calls.map(call => {
        const argument = call[0] as unknown
        return Array.isArray(argument)
          ? argument.map(String)
          : [String(argument)]
      }),
    clear: () => spy.mockClear()
  }
}

/** Stack internals the tests reach into; both stacks are private. */
interface UndoStackProbe {
  popUndo: () => { changes: AcDbDatabaseChange[] } | undefined
  popRedo: () => { changes: AcDbDatabaseChange[] } | undefined
}

function stackOf(db: AcDbDatabase): UndoStackProbe {
  return (db.transactionManager as unknown as { undoStack: UndoStackProbe })
    .undoStack
}

/**
 * Builds a document, erases it in one command and leaves the record on the redo
 * stack, so the test owns the change list while the database sits in the
 * restored state.
 */
function erasedThenRestored(count: number): {
  db: AcDbDatabase
  btr: AcDbBlockTableRecord
  ids: string[]
  changes: AcDbDatabaseChange[]
} {
  const { db, btr, ids } = createDocument(count)
  const manager = db.transactionManager
  manager.runUndoable('Erase', () => {
    btr.removeEntity(ids)
  })
  if (!manager.undo()) throw new Error('undo returned false')
  const record = stackOf(db).popRedo()
  if (!record) throw new Error('no redo record was produced')
  return { db, btr, ids, changes: record.changes }
}

describe('applyForward invocation contexts', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('1. redo through the transaction manager uses one scan and keeps the event stream', () => {
    const { db, btr, ids } = createDocument(64)
    const manager = db.transactionManager

    manager.runUndoable('Erase', () => {
      btr.removeEntity(ids)
    })
    expect(manager.undo()).toBe(true)

    const events = recordEvents(db)
    const spy = spyOnRemoveEntity()
    expect(manager.redo()).toBe(true)
    const calls = spy.calls()
    events.dispose()

    // One scan for the whole run: the Θ(k·m) term is gone.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(ids.length)
    // Undo/redo events are derived from the change list after the replay, so
    // the batching cannot reorder or split them.
    expect(events.erased).toHaveLength(1)
    expect(sortedIds(events.erased[0])).toEqual(sortedIds(ids))
    expect(events.appended).toHaveLength(0)
    // Database state: the record is replayed forward, so nothing survives.
    expect(idsOf(btr)).toHaveLength(0)
    expect(ids.every(id => db.getObjectById(id) === undefined)).toBe(true)
  })

  it('2. direct call without a transaction is indistinguishable from per-change replay', () => {
    const legacy = erasedThenRestored(32)
    const batched = erasedThenRestored(32)

    const legacyEvents = recordEvents(legacy.db)
    const spy = spyOnRemoveEntity()
    replayPerChange(legacy.db, legacy.changes)
    const legacyCalls = spy.calls()
    legacyEvents.dispose()

    const batchedEvents = recordEvents(batched.db)
    spy.clear()
    new AcDbChangeApplier(batched.db).applyForward(batched.changes)
    const batchedCalls = spy.calls()
    batchedEvents.dispose()

    // No transaction is open and no replay is in progress, so `removeEntity`
    // dispatches `entityErased` itself. Per-entity notifications are observable
    // API: a bulk call must not fuse them into one dispatch.
    expect(batchedEvents.erased).toEqual(legacyEvents.erased)
    expect(batchedEvents.appended).toEqual(legacyEvents.appended)
    expect(batchedCalls).toEqual(legacyCalls)
    expect(idsOf(batched.btr)).toEqual(idsOf(legacy.btr))
    expect(idsOf(batched.btr)).toHaveLength(0)
  })

  it('3. call from inside an active transaction matches per-change replay', () => {
    const legacy = erasedThenRestored(8)
    const batched = erasedThenRestored(8)

    const legacyEvents = recordEvents(legacy.db)
    legacy.db.transactionManager.runUndoable('Outer', () => {
      replayPerChange(legacy.db, legacy.changes)
    })
    legacyEvents.dispose()

    const batchedEvents = recordEvents(batched.db)
    let outerRecorded = false
    batched.db.transactionManager.runUndoable('Outer', () => {
      new AcDbChangeApplier(batched.db).applyForward(batched.changes)
    })
    batchedEvents.dispose()
    outerRecorded = batched.db.transactionManager.canUndo()

    // Recording is on, so neither direction notifies; the replay is recorded
    // into the outer transaction in both forms.
    expect(batchedEvents.erased).toEqual(legacyEvents.erased)
    expect(idsOf(batched.btr)).toEqual(idsOf(legacy.btr))
    expect(outerRecorded).toBe(true)
  })

  it('4. consecutive removes from one block table record collapse into one call', () => {
    const { db, btr, ids } = createDocument(5_000)
    const manager = db.transactionManager

    manager.runUndoable('Erase', () => {
      btr.removeEntity(ids)
    })
    const record = stackOf(db).popUndo()
    if (!record) throw new Error('no undo record was produced')
    // `removeEntity(ids)` records one removal per id. The editor service adds a
    // `modify` snapshot in front of each of them by opening the entity for
    // write, which is where the 2n shape in the browser spec comes from.
    expect(record.changes).toHaveLength(ids.length)

    // Replay the forward direction inside the replay context the manager uses.
    const probe = db.transactionManager as unknown as {
      _applyingUndoRedo: boolean
    }
    const spy = spyOnRemoveEntity()
    probe._applyingUndoRedo = true
    try {
      new AcDbChangeApplier(db).applyForward(record.changes)
    } finally {
      probe._applyingUndoRedo = false
    }
    const calls = spy.calls()

    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(ids.length)
    expect(idsOf(btr)).toHaveLength(0)
  })

  it('5. multiple block table records and mixed change kinds replay identically', () => {
    const build = () => {
      const { db, btr: model, ids: modelIds } = createDocument(12)
      const { btr: block, ids: blockIds } = addBlockDefinition(db, 'P28', 6)
      const manager = db.transactionManager
      manager.runUndoable('Mixed', () => {
        // run A: model-space removes
        model.removeEntity(modelIds.slice(0, 4))
        // barrier: another block table record
        block.removeEntity(blockIds.slice(0, 3))
        // barrier: modify
        const moved = db.openEntityForWrite(modelIds[7])
        if (moved) (moved as AcDbLine).startPoint = new AcGePoint3d(9, 9, 0)
        // barrier: append
        model.appendEntity(
          new AcDbLine(new AcGePoint3d(-1, -1, 0), new AcGePoint3d(-2, -2, 0))
        )
        // second run on the first block table record
        model.removeEntity(modelIds.slice(4, 6))
      })
      if (!manager.undo()) throw new Error('undo returned false')
      const record = stackOf(db).popRedo()
      if (!record) throw new Error('no redo record was produced')
      return { db, model, block, modelIds, blockIds, changes: record.changes }
    }

    const legacy = build()
    const batched = build()

    const snapshot = (db: AcDbDatabase, model: AcDbBlockTableRecord, block: AcDbBlockTableRecord) => ({
      model: idsOf(model),
      block: idsOf(block),
      resolved: [...idsOf(model), ...idsOf(block)].filter(
        id => db.getObjectById(id) !== undefined
      ).length
    })

    const legacyEvents = recordEvents(legacy.db)
    replayPerChange(legacy.db, legacy.changes)
    legacyEvents.dispose()

    const batchedEvents = recordEvents(batched.db)
    new AcDbChangeApplier(batched.db).applyForward(batched.changes)
    batchedEvents.dispose()

    expect(batchedEvents.erased).toEqual(legacyEvents.erased)
    expect(batchedEvents.appended).toEqual(legacyEvents.appended)
    expect(snapshot(batched.db, batched.model, batched.block)).toEqual(
      snapshot(legacy.db, legacy.model, legacy.block)
    )
    // Both runs were removed in the forward direction, and the appended line
    // survives on top of the 12 original ones minus the 6 removed.
    expect(idsOf(batched.model)).toHaveLength(12 - 6 + 1)
    expect(idsOf(batched.block)).toHaveLength(6 - 3)
  })
})
