import { AcGePoint3d } from '@mlightcad/geometry-engine'

import { AcDbObject, AcDbOpenMode } from '../src/base'
import { AcDbDatabase } from '../src/database/AcDbDatabase'
import { AcDbDatabaseTransaction } from '../src/database/transaction/AcDbDatabaseTransaction'
import { AcDbLine } from '../src/entity/AcDbLine'

/**
 * Phase 2.10 Task C — snapshot sharing must be indistinguishable from cloning.
 *
 * Every test here runs the **same** scenario the audit describes and asserts
 * the observable outcome, so a broken share (rollback and undo disagreeing, a
 * nested level overwriting a parent's before state, an `after` snapshot skipped)
 * fails on behaviour rather than on an internal counter.
 *
 * The clone counts are asserted too, because "3N -> 2N" is the whole point of
 * the change: `AcDbTransactionSnapshotFlow.spec.ts` pins the baseline (3N) with
 * sharing off, this file pins 2N with it on.
 */

/** Model-space line factory. */
function createLine(x = 0): AcDbLine {
  return new AcDbLine(new AcGePoint3d(x, 0, 0), new AcGePoint3d(x, 10, 0))
}

/** Database holding `count` lines, already appended to model space. */
function createDatabase(count: number): { db: AcDbDatabase; lines: AcDbLine[] } {
  const db = new AcDbDatabase()
  const lines: AcDbLine[] = []
  for (let i = 0; i < count; i++) {
    const line = createLine(i)
    db.tables.blockTable.modelSpace.appendEntity(line)
    lines.push(line)
  }
  return { db, lines }
}

/** Moves a line by `dx` on X, the operation a MOVE command performs. */
function move(line: AcDbLine, dx: number): void {
  line.startPoint = new AcGePoint3d(line.startPoint.x + dx, line.startPoint.y, 0)
  line.endPoint = new AcGePoint3d(line.endPoint.x + dx, line.endPoint.y, 0)
}

/** Reads the private rollback map to prove identity, not just equality. */
function rollbackSnapshotOf(
  tr: AcDbDatabaseTransaction,
  objectId: string
): AcDbObject | undefined {
  const internals = tr as unknown as {
    originalStates: Map<string, AcDbObject>
  }
  return internals.originalStates.get(objectId)
}

/** The `before` snapshot the undo record will replay. */
function beforeSnapshotOf(
  tr: AcDbDatabaseTransaction,
  objectId: string
): AcDbObject | undefined {
  const change = tr.recorder
    .getChanges()
    .find(item => item.kind === 'modify' && item.objectId === objectId)
  return change && change.kind === 'modify' ? change.before : undefined
}

describe('snapshot sharing (phase 2.10 Task C)', () => {
  let cloneSpy: jest.SpyInstance
  let cloneCount = 0

  beforeEach(() => {
    cloneCount = 0
    const original = AcDbObject.prototype.clonePreservingIdentity
    cloneSpy = jest
      .spyOn(AcDbObject.prototype, 'clonePreservingIdentity')
      .mockImplementation(function (this: AcDbObject) {
        cloneCount++
        return original.call(this)
      })
  })

  afterEach(() => {
    cloneSpy.mockRestore()
  })

  describe('clone budget', () => {
    it('takes N clones while open and 2N after commit for N objects', () => {
      const n = 8
      const { db, lines } = createDatabase(n)
      const manager = db.transactionManager
      manager.snapshotSharing = true

      manager.startUndoMark('Move')
      const tr = manager.startTransaction()
      for (const line of lines) {
        const opened = tr.getObject<AcDbLine>(
          line.objectId,
          AcDbOpenMode.kForWrite
        )
        move(opened!, 1)
      }

      // One clone per object: the rollback snapshot and the undo `before` are
      // the same object.
      expect(cloneCount).toBe(n)

      manager.commitTransaction()
      manager.endUndoMark()

      // Plus one `after` per object at finalize.
      expect(cloneCount).toBe(2 * n)
    })

    it('shares the identical object between rollback and undo', () => {
      const { db, lines } = createDatabase(1)
      const line = lines[0]
      const manager = db.transactionManager
      manager.snapshotSharing = true

      const tr = manager.startTransaction()
      tr.getObject<AcDbLine>(line.objectId, AcDbOpenMode.kForWrite)

      const rollback = rollbackSnapshotOf(tr, line.objectId)
      const before = beforeSnapshotOf(tr, line.objectId)
      expect(rollback).toBeDefined()
      expect(before).toBe(rollback)

      manager.abortTransaction()
    })

    it('reports the sharing counters and keeps copy-on-write at zero', () => {
      const n = 3
      const { db, lines } = createDatabase(n)
      const manager = db.transactionManager
      manager.snapshotSharing = true
      manager.resetSnapshotSharingMetrics()

      manager.runUndoable('Move', () => {
        for (const line of lines) {
          const opened = db.openObjectForWrite<AcDbLine>(line.objectId)
          move(opened!, 2)
        }
      })

      const metrics = manager.getSnapshotSharingMetrics()
      expect(metrics.uniqueModifiedObjects).toBe(n)
      expect(metrics.rollbackSnapshotClones).toBe(n)
      expect(metrics.sharedBeforeSnapshotCount).toBe(n)
      expect(metrics.beforeSnapshotClones).toBe(0)
      expect(metrics.afterSnapshotClones).toBe(n)
      expect(metrics.copyOnWriteCount).toBe(0)
      expect(metrics.retainedUndoChanges).toBe(n)
    })
  })

  describe('abort and undo parity', () => {
    it('restores the original state on abort', () => {
      const { db, lines } = createDatabase(2)
      const line = lines[0]
      const manager = db.transactionManager
      manager.snapshotSharing = true

      manager.startTransaction()
      const opened = db.openObjectForWrite<AcDbLine>(line.objectId)!
      move(opened, 25)
      expect(line.startPoint.x).toBe(25)

      manager.abortTransaction()
      expect(line.startPoint.x).toBe(0)
    })

    it('keeps multi-round undo / redo exact', () => {
      const { db, lines } = createDatabase(1)
      const line = lines[0]
      const manager = db.transactionManager
      manager.snapshotSharing = true

      manager.runUndoable('Move 1', () => {
        move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 5)
      })
      manager.runUndoable('Move 2', () => {
        move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 7)
      })
      expect(line.startPoint.x).toBe(12)

      manager.undo()
      expect(line.startPoint.x).toBe(5)
      manager.undo()
      expect(line.startPoint.x).toBe(0)
      manager.redo()
      expect(line.startPoint.x).toBe(5)
      manager.redo()
      expect(line.startPoint.x).toBe(12)
    })

    it('keeps the abort snapshot valid after an undo has read it', () => {
      const { db, lines } = createDatabase(1)
      const line = lines[0]
      const manager = db.transactionManager
      manager.snapshotSharing = true

      manager.runUndoable('Move', () => {
        move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 9)
      })

      // The same object served the rollback (already discarded) and the undo.
      // Replay it twice in both directions: a mutated snapshot would drift.
      for (let round = 0; round < 3; round++) {
        manager.undo()
        expect(line.startPoint.x).toBe(0)
        manager.redo()
        expect(line.startPoint.x).toBe(9)
      }
    })
  })

  describe('C3 nested transactions', () => {
    it('child modify then child commit keeps the parent before state', () => {
      const { db, lines } = createDatabase(1)
      const line = lines[0]
      const manager = db.transactionManager
      manager.snapshotSharing = true

      manager.startUndoMark('Nested')
      manager.startTransaction()
      move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 3)

      manager.startTransaction()
      move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 4)
      manager.commitTransaction()

      manager.commitTransaction()
      manager.endUndoMark()
      expect(line.startPoint.x).toBe(7)

      manager.undo()
      expect(line.startPoint.x).toBe(0)
      manager.redo()
      expect(line.startPoint.x).toBe(7)
    })

    it('child abort restores its own starting state', () => {
      const { db, lines } = createDatabase(1)
      const line = lines[0]
      const manager = db.transactionManager
      manager.snapshotSharing = true

      manager.startUndoMark('Nested abort')
      manager.startTransaction()
      move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 3)

      manager.startTransaction()
      move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 4)
      // The child's rollback snapshot was taken after the parent's move.
      manager.abortTransaction()

      expect(line.startPoint.x).toBe(3)
      manager.commitTransaction()
      manager.endUndoMark()
      manager.undo()
      expect(line.startPoint.x).toBe(0)
    })

    it('child writes first and the parent writes afterwards', () => {
      const { db, lines } = createDatabase(1)
      const line = lines[0]
      const manager = db.transactionManager
      manager.snapshotSharing = true

      manager.startUndoMark('Child first')
      manager.startTransaction()
      manager.startTransaction()
      move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 2)
      manager.commitTransaction()

      move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 6)
      manager.commitTransaction()
      manager.endUndoMark()
      expect(line.startPoint.x).toBe(8)

      manager.undo()
      expect(line.startPoint.x).toBe(0)
      manager.redo()
      expect(line.startPoint.x).toBe(8)
    })

    it('keeps the outermost before state when the same id is written on three levels', () => {
      const { db, lines } = createDatabase(1)
      const line = lines[0]
      const manager = db.transactionManager
      manager.snapshotSharing = true

      manager.startUndoMark('Three levels')
      manager.startTransaction()
      move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 1)
      manager.startTransaction()
      move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 2)
      manager.startTransaction()
      move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 4)
      manager.commitTransaction()
      manager.commitTransaction()
      manager.commitTransaction()
      manager.endUndoMark()
      expect(line.startPoint.x).toBe(7)

      manager.undo()
      expect(line.startPoint.x).toBe(0)
    })

    it('child commit then parent abort rolls everything back', () => {
      const { db, lines } = createDatabase(2)
      const line = lines[0]
      const manager = db.transactionManager
      manager.snapshotSharing = true

      manager.startTransaction()
      move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 3)

      manager.startTransaction()
      move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 5)
      move(db.openObjectForWrite<AcDbLine>(lines[1].objectId)!, 5)
      manager.commitTransaction()

      manager.abortTransaction()
      expect(line.startPoint.x).toBe(0)
      expect(lines[1].startPoint.x).toBe(1)
      expect(manager.canUndo()).toBe(false)
    })

    it('modifies different entities on different levels', () => {
      const { db, lines } = createDatabase(3)
      const manager = db.transactionManager
      manager.snapshotSharing = true

      manager.startUndoMark('Mixed levels')
      manager.startTransaction()
      move(db.openObjectForWrite<AcDbLine>(lines[0].objectId)!, 10)

      manager.startTransaction()
      move(db.openObjectForWrite<AcDbLine>(lines[1].objectId)!, 20)
      manager.commitTransaction()

      move(db.openObjectForWrite<AcDbLine>(lines[2].objectId)!, 30)
      manager.commitTransaction()
      manager.endUndoMark()

      expect(lines[0].startPoint.x).toBe(10)
      expect(lines[1].startPoint.x).toBe(21)
      expect(lines[2].startPoint.x).toBe(32)

      manager.undo()
      expect(lines[0].startPoint.x).toBe(0)
      expect(lines[1].startPoint.x).toBe(1)
      expect(lines[2].startPoint.x).toBe(2)
    })

    it('mixes append, remove and modify across levels', () => {
      const { db, lines } = createDatabase(2)
      const manager = db.transactionManager
      manager.snapshotSharing = true
      const modelSpace = db.tables.blockTable.modelSpace
      const added = createLine(100)

      manager.startUndoMark('Mixed kinds')
      manager.startTransaction()
      modelSpace.appendEntity(added)
      move(db.openObjectForWrite<AcDbLine>(lines[0].objectId)!, 7)

      manager.startTransaction()
      modelSpace.removeEntity(lines[1].objectId)
      manager.commitTransaction()

      manager.commitTransaction()
      manager.endUndoMark()

      expect(modelSpace.getIdAt(added.objectId)).toBe(added)
      expect(modelSpace.getIdAt(lines[1].objectId)).toBeUndefined()
      expect(lines[0].startPoint.x).toBe(7)

      manager.undo()
      // Undo of a removal re-materialises the entity from the recorded clone
      // (`AcDbChangeRecorder.recordRemove` snapshots it), so `lines[1]` is not
      // the instance that comes back. Presence, id and geometry are what the
      // contract promises; the reference is not.
      expect(modelSpace.getIdAt(added.objectId)).toBeUndefined()
      const restored = modelSpace.getIdAt(lines[1].objectId) as
        | AcDbLine
        | undefined
      expect(restored?.objectId).toBe(lines[1].objectId)
      expect(restored?.startPoint.x).toBe(1)
      expect(lines[0].startPoint.x).toBe(0)

      manager.redo()
      // Redo replays the recorded clone for the same reason, so identity is
      // not part of the contract here either.
      const replayed = modelSpace.getIdAt(added.objectId) as
        | AcDbLine
        | undefined
      expect(replayed?.startPoint.x).toBe(100)
      expect(modelSpace.getIdAt(lines[1].objectId)).toBeUndefined()
      expect(lines[0].startPoint.x).toBe(7)
    })
  })

  describe('sharing off stays the baseline', () => {
    it('clones 2N while open when the switch is off', () => {
      const n = 4
      const { db, lines } = createDatabase(n)
      const manager = db.transactionManager
      expect(manager.snapshotSharing).toBe(false)

      const tr = manager.startTransaction()
      for (const line of lines) {
        tr.getObject<AcDbLine>(line.objectId, AcDbOpenMode.kForWrite)
      }
      expect(cloneCount).toBe(2 * n)
      manager.abortTransaction()
    })

    it('never reads the switch for a transaction already open', () => {
      const { db, lines } = createDatabase(1)
      const manager = db.transactionManager

      const tr = manager.startTransaction()
      manager.snapshotSharing = true
      tr.getObject<AcDbLine>(lines[0].objectId, AcDbOpenMode.kForWrite)

      expect(cloneCount).toBe(2)
      manager.abortTransaction()
    })
  })
})
