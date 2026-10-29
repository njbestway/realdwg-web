import { AcGePoint3d } from '@mlightcad/geometry-engine'

import { AcDbOpenMode, type AcDbObject } from '../src/base'
import { AcDbBlockTableRecord } from '../src/database/AcDbBlockTableRecord'
import { AcDbDatabase } from '../src/database/AcDbDatabase'
import { AcDbLayerTableRecord } from '../src/database/AcDbLayerTableRecord'
import { AcDbChangeApplier } from '../src/database/transaction/AcDbChangeApplier'
import type { AcDbDatabaseChange } from '../src/database/transaction/AcDbDatabaseChange'
import { AcDbEntity } from '../src/entity/AcDbEntity'
import { AcDbLine } from '../src/entity/AcDbLine'

/**
 * Correctness coverage for batched forward replay (SPEC-CAD-001 Phase 2.7).
 *
 * `AcDbChangeApplier.applyForward` collapses a maximal run of consecutive
 * removals from one block table record into a single
 * `AcDbBlockTableRecord.removeEntity(ids)` call. Everything asserted here is
 * about that collapse being unobservable: same surviving order, same handles,
 * same event stream, same undo/redo bookkeeping.
 */

/** Container descriptor pointing at model space. */
function modelSpaceContainer(db: AcDbDatabase) {
  return {
    type: 'blockTableRecord' as const,
    ownerId: db.tables.blockTable.modelSpace.objectId
  }
}

/** Object ids of a block table record, in array order. */
function idsOf(btr: AcDbBlockTableRecord): string[] {
  const ids: string[] = []
  for (const entity of btr.newIterator()) ids.push(entity.objectId)
  return ids
}

/**
 * Sorted copy of an id list.
 *
 * Inverse replay appends entities at the end of the array, so a partial undo
 * restores the right set in a different order. Set comparison is the correct
 * assertion for anything that goes through an undo; exact order is asserted
 * where removal guarantees it.
 */
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
    return items.map(item => (item as AcDbObject).objectId)
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
 * The pre-fix forward replay, kept here as the reference implementation.
 *
 * It applies one change at a time in array order, exactly like `applyForward`
 * did before the run aggregation, using only public API.
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

/**
 * Takes the change list out of the most recent undo record.
 *
 * The manager keeps records private, so the test reaches into the stack. The
 * record is removed, which is fine for the tests that use this helper: they
 * replay the list through `AcDbChangeApplier` directly instead of `undo()`.
 */
function captureChanges(db: AcDbDatabase): AcDbDatabaseChange[] {
  const stack = (
    db.transactionManager as unknown as {
      undoStack: { popUndo: () => { changes: AcDbDatabaseChange[] } | undefined }
    }
  ).undoStack
  const record = stack.popUndo()
  if (!record) throw new Error('no undo record was produced')
  return record.changes
}

describe('bulk replay of structural removals', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('single command ERASE', () => {
    for (const size of [50_000, 100_000]) {
      it(`round-trips a ${size}-entity erase through undo and redo`, () => {
        const { db, btr, ids } = createDocument(size)
        const manager = db.transactionManager

        manager.runUndoable('Erase', () => {
          btr.removeEntity(ids)
        })
        expect(idsOf(btr)).toHaveLength(0)
        expect(manager.canUndo()).toBe(true)

        expect(manager.undo()).toBe(true)
        expect(sortedIds(idsOf(btr))).toEqual(sortedIds(ids))
        expect(ids.every(id => db.getObjectById(id) !== undefined)).toBe(true)

        expect(manager.redo()).toBe(true)
        expect(idsOf(btr)).toHaveLength(0)
        expect(ids.every(id => db.getObjectById(id) === undefined)).toBe(true)
      }, 180_000)
    }

    it('restores the exact id set with one undo and removes it with one redo', () => {
      const { db, btr, ids } = createDocument(5_000)
      const manager = db.transactionManager

      manager.runUndoable('Erase', () => {
        btr.removeEntity(ids)
      })

      manager.undo()
      expect(sortedIds(idsOf(btr))).toEqual(sortedIds(ids))
      manager.redo()
      expect(idsOf(btr)).toEqual([])

      // One record, moved between the stacks rather than recreated.
      expect(manager.canUndo()).toBe(true)
      expect(manager.canRedo()).toBe(false)
    })

    it('stays exact across four undo/redo rounds', () => {
      const { db, btr, ids } = createDocument(2_000)
      const manager = db.transactionManager
      manager.runUndoable('Erase', () => {
        btr.removeEntity(ids)
      })

      for (let round = 0; round < 4; round++) {
        expect(manager.undo()).toBe(true)
        expect(sortedIds(idsOf(btr))).toEqual(sortedIds(ids))
        expect(manager.redo()).toBe(true)
        expect(idsOf(btr)).toEqual([])
      }
      expect(manager.canRedo()).toBe(false)
    })

    it('restores a partial erase by appending in reverse record order', () => {
      // Pre-existing inverse semantics, pinned here because the batched
      // forward path must not change what undo produces: changes are replayed
      // from last to first and each append lands at the end of the array.
      const { db, btr, ids } = createDocument(5)
      db.transactionManager.runUndoable('Erase', () => {
        btr.removeEntity([ids[1], ids[3]])
      })
      expect(idsOf(btr)).toEqual([ids[0], ids[2], ids[4]])

      db.transactionManager.undo()
      expect(idsOf(btr)).toEqual([ids[0], ids[2], ids[4], ids[3], ids[1]])
    })
  })

  describe('run aggregation', () => {
    it('collapses a contiguous run into one removeEntity call', () => {
      const { db, btr, ids } = createDocument(100)
      const spy = spyOnRemoveEntity()

      db.transactionManager.runUndoable('Erase', () => {
        btr.removeEntity(ids)
      })
      db.transactionManager.undo()
      spy.clear()
      db.transactionManager.redo()

      expect(spy.calls()).toEqual([ids])
    })

    it('keeps removals from different block table records in separate runs', () => {
      const { db, btr, ids } = createDocument(10)
      const block = addBlockDefinition(db, 'PART', 10)
      const spy = spyOnRemoveEntity()

      // Interleaved on purpose: model, block, model, block, …
      db.transactionManager.runUndoable('Erase', () => {
        for (let index = 0; index < 5; index++) {
          btr.removeEntity(ids[index])
          block.btr.removeEntity(block.ids[index])
        }
      })
      db.transactionManager.undo()
      spy.clear()
      db.transactionManager.redo()

      // Ten single-id removals, alternating between two containers.
      const calls = spy.calls()
      expect(calls).toHaveLength(10)
      expect(calls.map(call => call.length)).toEqual(Array(10).fill(1))
    })

    it('flushes before a modify barrier', () => {
      const { db, btr, ids } = createDocument(3)
      const spy = spyOnRemoveEntity()

      db.transactionManager.runUndoable('Mixed', tr => {
        const first = tr.getObject<AcDbLine>(ids[0], AcDbOpenMode.kForWrite)!
        first.endPoint = new AcGePoint3d(99, 99, 0)
        btr.removeEntity(ids[0])
        tr.getObject<AcDbLine>(ids[1], AcDbOpenMode.kForWrite)
        btr.removeEntity(ids[2])
      })
      db.transactionManager.undo()
      spy.clear()
      db.transactionManager.redo()

      // Two runs, one id each: the modify between them is a barrier.
      expect(spy.calls()).toEqual([[ids[0]], [ids[2]]])
    })

    it('flushes before an append barrier', () => {
      const { db, btr, ids } = createDocument(4)
      const spy = spyOnRemoveEntity()

      db.transactionManager.runUndoable('Mixed', () => {
        btr.removeEntity(ids[0])
        btr.appendEntity(
          new AcDbLine(new AcGePoint3d(0, 5, 0), new AcGePoint3d(1, 5, 0))
        )
        btr.removeEntity(ids[1])
      })
      db.transactionManager.undo()
      spy.clear()
      db.transactionManager.redo()

      expect(spy.calls()).toEqual([[ids[0]], [ids[1]]])
    })

    it('collapses duplicate ids in one run exactly like the per-id path', () => {
      const { db, btr, ids } = createDocument(3)
      const [first] = [...btr.newIterator()]
      const container = modelSpaceContainer(db)
      const snapshot = first.clonePreservingIdentity()

      // A real recorder cancels an append/remove pair and can never emit the
      // same removal twice, so this record is fabricated on purpose: the batch
      // must still behave like the per-change loop did.
      const changes: AcDbDatabaseChange[] = [
        { kind: 'remove', container, object: snapshot.clonePreservingIdentity() },
        { kind: 'remove', container, object: snapshot.clonePreservingIdentity() },
        { kind: 'remove', container, object: snapshot.clonePreservingIdentity() }
      ]

      const applier = new AcDbChangeApplier(db)
      expect(() => applier.applyForward(changes)).not.toThrow()
      const batched = idsOf(btr)
      expect(batched).toEqual([ids[1], ids[2]])

      // Same shape as the pre-fix loop: three single-id calls on one document.
      const reference = createDocument(3)
      for (let attempt = 0; attempt < 3; attempt++) {
        reference.btr.removeEntity(reference.ids[0])
      }
      expect(idsOf(reference.btr)).toEqual([reference.ids[1], reference.ids[2]])
    })

    it('matches the pre-fix per-change replay for a mixed record', () => {
      const { db, btr, ids } = createDocument(12)
      const all = [...btr.newIterator()]

      db.transactionManager.runUndoable('Mixed', tr => {
        // A contiguous run over the even indices…
        for (let index = 0; index < 12; index += 2) {
          tr.getObject<AcDbLine>(ids[index], AcDbOpenMode.kForWrite)
          btr.removeEntity(ids[index])
        }
        // …then a modify barrier, then a trailing removal.
        const target = tr.getObject<AcDbLine>(
          ids[6],
          AcDbOpenMode.kForWrite
        )!
        target.endPoint = new AcGePoint3d(77, 77, 0)
        btr.removeEntity(ids[11])
      })
      expect(all).toHaveLength(12)

      const changes = captureChanges(db)
      const applier = new AcDbChangeApplier(db)

      applier.applyInverse(changes)
      const restored = idsOf(btr)
      applier.applyForward(changes)
      const batched = idsOf(btr)
      const batchedHandles = ids.map(id => db.getObjectById(id)?.objectId)

      applier.applyInverse(changes)
      expect(idsOf(btr)).toEqual(restored)
      replayPerChange(db, changes)

      expect(idsOf(btr)).toEqual(batched)
      expect(ids.map(id => db.getObjectById(id)?.objectId)).toEqual(
        batchedHandles
      )
    })

    it('keeps order for remove then append and append then remove', () => {
      const { db, btr, ids } = createDocument(3)
      const manager = db.transactionManager

      manager.runUndoable('RemoveThenAppend', () => {
        btr.removeEntity(ids[1])
        btr.appendEntity(
          new AcDbLine(new AcGePoint3d(0, 9, 0), new AcGePoint3d(1, 9, 0))
        )
      })
      const afterForward = idsOf(btr)
      expect(afterForward).toHaveLength(3)

      manager.undo()
      expect(sortedIds(idsOf(btr))).toEqual(sortedIds(ids))
      manager.redo()
      expect(idsOf(btr)).toEqual(afterForward)

      const second = createDocument(3)
      const third = new AcDbLine(
        new AcGePoint3d(0, 4, 0),
        new AcGePoint3d(1, 4, 0)
      )
      second.db.transactionManager.runUndoable('AppendThenRemove', () => {
        second.btr.appendEntity(third)
        second.btr.removeEntity(second.ids[0])
      })
      const appendedThenRemoved = idsOf(second.btr)
      expect(appendedThenRemoved).toHaveLength(3)

      second.db.transactionManager.undo()
      expect(sortedIds(idsOf(second.btr))).toEqual(sortedIds(second.ids))
      second.db.transactionManager.redo()
      expect(idsOf(second.btr)).toEqual(appendedThenRemoved)
    })
  })

  describe('events', () => {
    it('produces the same dispatch order and payloads in both directions', () => {
      const { db, btr, ids } = createDocument(4)
      const manager = db.transactionManager

      manager.runUndoable('Mixed', () => {
        btr.removeEntity([ids[0], ids[1]])
        btr.removeEntity(ids[2])
      })

      const events = recordEvents(db)
      try {
        manager.undo()
        // The inverse of a removal is one append dispatch inside the batch.
        expect(events.appended).toEqual([[ids[0], ids[1], ids[2]]])
        expect(events.erased).toEqual([])

        events.appended.length = 0
        manager.redo()
        expect(events.erased).toEqual([[ids[0], ids[1], ids[2]]])
        expect(events.appended).toEqual([])
      } finally {
        events.dispose()
      }
    })

    it('fires once per direction no matter how many runs the record has', () => {
      const { db, btr, ids } = createDocument(6)
      const manager = db.transactionManager

      manager.runUndoable('Mixed', () => {
        btr.removeEntity(ids[0])
        btr.appendEntity(
          new AcDbLine(new AcGePoint3d(0, 1, 0), new AcGePoint3d(1, 1, 0))
        )
        btr.removeEntity(ids[1])
        btr.removeEntity(ids[2])
      })

      const events = recordEvents(db)
      try {
        manager.undo()
        expect(events.appended).toEqual([[ids[0], ids[1], ids[2]]])
        expect(events.erased).toHaveLength(1)
        expect(events.erased[0]).toHaveLength(1)
      } finally {
        events.dispose()
      }
    })

    it('does not create recorder entries while replaying', () => {
      const { db, btr, ids } = createDocument(6)
      const manager = db.transactionManager
      manager.runUndoable('Erase', () => {
        btr.removeEntity(ids.slice(0, 3))
      })

      manager.undo()
      expect(manager.isRecording()).toBe(false)
      expect(manager.isApplyingUndoRedo()).toBe(false)
      expect(manager.canRedo()).toBe(true)
      manager.redo()
      expect(manager.canUndo()).toBe(true)
      expect(manager.canRedo()).toBe(false)
    })
  })

  describe('transactions', () => {
    it('merges nested commits and restores both levels on undo', () => {
      const { db, btr, ids } = createDocument(4)
      const manager = db.transactionManager

      manager.startUndoMark('Nested')
      manager.startTransaction()
      btr.removeEntity(ids[0])

      manager.startTransaction()
      btr.removeEntity(ids[1])
      manager.commitTransaction()

      expect(idsOf(btr)).toEqual(ids.slice(2))
      manager.commitTransaction()
      manager.endUndoMark()

      expect(idsOf(btr)).toEqual(ids.slice(2))
      manager.undo()
      expect(sortedIds(idsOf(btr))).toEqual(sortedIds(ids))

      manager.redo()
      expect(idsOf(btr)).toEqual(ids.slice(2))
    })

    it('rolls a nested abort back without touching the outer removals', () => {
      const { db, btr, ids } = createDocument(4)
      const manager = db.transactionManager

      manager.startTransaction()
      btr.removeEntity(ids[0])

      manager.startTransaction()
      btr.removeEntity([ids[1], ids[2]])
      manager.abortTransaction()

      expect(sortedIds(idsOf(btr))).toEqual(
        sortedIds([ids[1], ids[2], ids[3]])
      )
      manager.commitTransaction()
      expect(sortedIds(idsOf(btr))).toEqual(
        sortedIds([ids[1], ids[2], ids[3]])
      )
      expect(manager.canUndo()).toBe(false)
    })
  })

  describe('damaged records', () => {
    it('skips removals whose container no longer exists', () => {
      const { db, btr, ids } = createDocument(2)
      const [first] = [...btr.newIterator()]
      const applier = new AcDbChangeApplier(db)
      const dead = {
        type: 'blockTableRecord' as const,
        ownerId: 'DEADBEEF'
      }

      const changes: AcDbDatabaseChange[] = [
        { kind: 'remove', container: dead, object: first.clonePreservingIdentity() },
        { kind: 'remove', container: dead, object: first.clonePreservingIdentity() }
      ]

      expect(() => applier.applyForward(changes)).not.toThrow()
      expect(idsOf(btr)).toEqual(ids)
      applier.applyInverse(changes)
      expect(idsOf(btr)).toEqual(ids)
    })

    it('removes an id that is already gone without disturbing the rest', () => {
      const { db, btr, ids } = createDocument(3)
      const [first, second] = [...btr.newIterator()]
      const container = modelSpaceContainer(db)
      const applier = new AcDbChangeApplier(db)

      applier.applyForward([
        { kind: 'remove', container, object: first.clonePreservingIdentity() }
      ])
      expect(idsOf(btr)).toEqual([ids[1], ids[2]])

      // A later record still naming the erased id is a silent no-op.
      applier.applyForward([
        { kind: 'remove', container, object: first.clonePreservingIdentity() },
        {
          kind: 'remove',
          container,
          object: second.clonePreservingIdentity()
        }
      ])
      expect(idsOf(btr)).toEqual([ids[2]])
    })
  })

  describe('preserved semantics', () => {
    it('leaves block definition members alone when an insert is erased', () => {
      const { db, btr, ids } = createDocument(2)
      const block = addBlockDefinition(db, 'PART', 3)

      db.transactionManager.runUndoable('Erase', () => {
        btr.removeEntity(ids[0])
      })
      db.transactionManager.undo()
      db.transactionManager.redo()

      expect(idsOf(block.btr)).toEqual(block.ids)
      expect(db.tables.blockTable.getIdAt(block.btr.objectId)).toBe(block.btr)
    })

    it('keeps owner and layer ownership across a replay on a locked layer', () => {
      const { db, btr, ids } = createDocument(4)
      const locked = new AcDbLayerTableRecord()
      locked.name = 'LOCKED'
      locked.isLocked = true
      db.tables.layerTable.add(locked)

      for (const entity of btr.newIterator()) entity.layer = 'LOCKED'
      const before = ids.map(id => {
        const entity = db.getObjectById(id) as AcDbEntity | undefined
        return {
          ownerId: entity?.getAttrWithoutException('ownerId'),
          layer: entity?.layer
        }
      })
      expect(before[0].layer).toBe('LOCKED')

      db.transactionManager.runUndoable('Erase', () => {
        btr.removeEntity(ids)
      })
      db.transactionManager.undo()

      expect(
        ids.map(id => {
          const entity = db.getObjectById(id) as AcDbEntity | undefined
          return {
            ownerId: entity?.getAttrWithoutException('ownerId'),
            layer: entity?.layer
          }
        })
      ).toEqual(before)

      // The layer record is not part of the record and keeps its lock flag.
      expect(db.tables.layerTable.getAt('LOCKED')?.isLocked).toBe(true)
    })
  })
})
