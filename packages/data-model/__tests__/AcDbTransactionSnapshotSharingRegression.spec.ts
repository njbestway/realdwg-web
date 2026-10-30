import { AcGePoint2d, AcGePoint3d, AcGeVector3dLike } from '@mlightcad/geometry-engine'

import { AcDbObject, AcDbOpenMode } from '../src/base'
import { AcDbBlockTableRecord } from '../src/database/AcDbBlockTableRecord'
import { AcDbDatabase } from '../src/database/AcDbDatabase'
import { AcDbLayerTableRecord } from '../src/database/AcDbLayerTableRecord'
import { AcDbBlockReference } from '../src/entity/AcDbBlockReference'
import { AcDbEntity } from '../src/entity/AcDbEntity'
import { AcDbLine } from '../src/entity/AcDbLine'
import { AcDbMText } from '../src/entity/AcDbMText'
import { AcDbPolyline } from '../src/entity/AcDbPolyline'
import { AcDbText } from '../src/entity/AcDbText'

/**
 * Phase 2.10 Task D — correctness and transaction atomicity with snapshot
 * sharing **on**.
 *
 * Every item in the spec's D list that belongs to this package is asserted
 * here, and each one compares full entity state rather than entity counts:
 * `stateOf()` renders the geometry of the entity types the task names, and
 * `modelSpaceState()` compares whole-document state as sorted `id:state`
 * strings. A view that lost a vertex, a text that lost its string or an INSERT
 * that lost its scale cannot pass by merely staying present.
 *
 * The one thing this file deliberately does *not* do is assert reference
 * identity of re-materialised entities: undo of a removal and redo of an append
 * replay the recorder's snapshot, so the instance that comes back is not the
 * original object. That is pre-existing behaviour (`AcDbBulkReplay.spec.ts`
 * pins it too) and is unaffected by sharing.
 *
 * Items owned by the other repositories are covered elsewhere: the 1k/10k/50k/
 * 100k single-transaction MOVE runs live in `bench/phase210-move.mjs`, the R-8
 * race and Scene Readiness regressions live in cad-viewer.
 */

/** Model-space line factory. */
function createLine(x = 0): AcDbLine {
  return new AcDbLine(new AcGePoint3d(x, 0, 0), new AcGePoint3d(x, 10, 0))
}

/** Database holding `count` lines, already appended to model space. */
function createDatabase(count = 0): { db: AcDbDatabase; lines: AcDbLine[] } {
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

const point = (p: AcGePoint3d | AcGePoint2d | AcGeVector3dLike): string =>
  `${p.x},${p.y},${'z' in p ? p.z : 0}`

/**
 * Full comparable state of one entity.
 *
 * Covers exactly the entity types item 16 names plus LINE, and always includes
 * the type name so a converted entity cannot pass as its original.
 */
function stateOf(entity: AcDbEntity): string {
  if (entity instanceof AcDbLine) {
    return `LINE ${point(entity.startPoint)} ${point(entity.endPoint)}`
  }
  if (entity instanceof AcDbPolyline) {
    const vertices: string[] = []
    for (let i = 0; i < entity.numberOfVertices; i++) {
      vertices.push(point(entity.getPoint2dAt(i)))
    }
    return `LWPOLYLINE e=${entity.elevation} c=${entity.closed} ${vertices.join('|')}`
  }
  if (entity instanceof AcDbBlockReference) {
    return `INSERT ${point(entity.position)} r=${entity.rotation} s=${point(entity.scaleFactors)}`
  }
  if (entity instanceof AcDbMText) {
    return `MTEXT ${point(entity.location)} h=${entity.height} ${entity.contents}`
  }
  if (entity instanceof AcDbText) {
    return `TEXT ${point(entity.position)} h=${entity.height} ${entity.textString}`
  }
  return entity.dxfTypeName
}

/** Whole model space as sorted `id:state`, so set *and* geometry are compared. */
function modelSpaceState(db: AcDbDatabase): string[] {
  const out: string[] = []
  for (const entity of db.tables.blockTable.modelSpace.newIterator()) {
    out.push(`${entity.objectId}:${stateOf(entity)}`)
  }
  return out.sort()
}

/** Copies a state list so later mutation of the database cannot alias it. */
const freeze = (state: string[]): string[] => [...state]

describe('snapshot sharing regressions (phase 2.10 Task D)', () => {
  /** Every test in this file runs the sharing path unless it says otherwise. */
  let db: AcDbDatabase

  beforeEach(() => {
    db = new AcDbDatabase()
    db.transactionManager.snapshotSharing = true
  })
  describe('single transaction basics', () => {
    it('round-trips one entity through commit, undo and redo', () => {
      const { lines } = createDatabase(1)
      const fresh = new AcDbDatabase()
      fresh.tables.blockTable.modelSpace.appendEntity(lines[0])
      const manager = fresh.transactionManager
      manager.snapshotSharing = true
      const before = freeze(modelSpaceState(fresh))

      manager.runUndoable('Move', tr => {
        move(tr.getObject<AcDbLine>(lines[0].objectId, AcDbOpenMode.kForWrite)!, 25)
      })
      const moved = freeze(modelSpaceState(fresh))
      expect(moved).not.toEqual(before)

      expect(manager.undo()).toBe(true)
      expect(modelSpaceState(fresh)).toEqual(before)

      expect(manager.redo()).toBe(true)
      expect(modelSpaceState(fresh)).toEqual(moved)
    })

    it('treats repeated transforms of one entity as a single undo step', () => {
      const { db: local, lines } = createDatabase(1)
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const original = freeze(modelSpaceState(local))

      // One MOVE command: three writes to the same object id, one undo mark.
      manager.startUndoMark('Move')
      manager.startTransaction()
      const line = local.openObjectForWrite<AcDbLine>(lines[0].objectId)!
      move(line, 1)
      move(line, 2)
      move(line, 3)
      manager.commitTransaction()
      manager.endUndoMark()

      expect(lines[0].startPoint.x).toBe(6)
      expect(manager.undo()).toBe(true)
      expect(modelSpaceState(local)).toEqual(original)
      // Exactly one undo step: a second undo has nothing to replay.
      expect(manager.canUndo()).toBe(false)
    })

    it('restores every entity modified in one transaction', () => {
      const { db: local, lines } = createDatabase(4)
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const original = freeze(modelSpaceState(local))

      manager.runUndoable('Move', tr => {
        for (const line of lines) {
          move(tr.getObject<AcDbLine>(line.objectId, AcDbOpenMode.kForWrite)!, 5)
        }
      })
      expect(lines.map(line => line.startPoint.x)).toEqual([5, 6, 7, 8])

      manager.undo()
      expect(modelSpaceState(local)).toEqual(original)
      manager.redo()
      expect(lines.map(line => line.startPoint.x)).toEqual([5, 6, 7, 8])
    })
  })

  describe('structural changes crossing modify (items 6-9)', () => {
    it('handles append then modify', () => {
      const { db: local, lines } = createDatabase(1)
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const original = freeze(modelSpaceState(local))
      const added = createLine(50)

      manager.runUndoable('Append and move', tr => {
        local.tables.blockTable.modelSpace.appendEntity(added)
        move(tr.getObject<AcDbLine>(lines[0].objectId, AcDbOpenMode.kForWrite)!, 2)
        move(tr.getObject<AcDbLine>(added.objectId, AcDbOpenMode.kForWrite)!, 3)
      })

      const afterCommit = freeze(modelSpaceState(local))
      expect(afterCommit).toHaveLength(2)

      manager.undo()
      expect(modelSpaceState(local)).toEqual(original)
      manager.redo()
      expect(modelSpaceState(local)).toEqual(afterCommit)
    })

    it('handles modify then remove', () => {
      const { db: local, lines } = createDatabase(2)
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const original = freeze(modelSpaceState(local))

      manager.runUndoable('Move and erase', tr => {
        move(tr.getObject<AcDbLine>(lines[0].objectId, AcDbOpenMode.kForWrite)!, 4)
        local.tables.blockTable.modelSpace.removeEntity(lines[1].objectId)
      })
      const afterCommit = freeze(modelSpaceState(local))
      expect(afterCommit).toHaveLength(1)

      manager.undo()
      expect(modelSpaceState(local)).toEqual(original)
      manager.redo()
      expect(modelSpaceState(local)).toEqual(afterCommit)
    })

    it('handles remove then append of a different entity', () => {
      const { db: local, lines } = createDatabase(2)
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const modelSpace = local.tables.blockTable.modelSpace
      const original = freeze(modelSpaceState(local))
      const added = createLine(60)

      manager.runUndoable('Erase and add', tr => {
        modelSpace.removeEntity(lines[1].objectId)
        modelSpace.appendEntity(added)
        move(tr.getObject<AcDbLine>(lines[0].objectId, AcDbOpenMode.kForWrite)!, 6)
      })
      const afterCommit = freeze(modelSpaceState(local))
      expect(afterCommit).toHaveLength(2)
      expect(afterCommit.join()).not.toContain(lines[1].objectId)

      manager.undo()
      expect(modelSpaceState(local)).toEqual(original)
      manager.redo()
      expect(modelSpaceState(local)).toEqual(afterCommit)
    })

    it('collapses a remove and re-append of the same id', () => {
      // Item 9: a structural pair on the same object id cancels in
      // `AcDbChangeRecorder.recordStructuralChange`, so the transaction
      // records nothing for that id and no snapshot is retained for it.
      const { db: local, lines } = createDatabase(2)
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const modelSpace = local.tables.blockTable.modelSpace

      manager.runUndoable('Erase and re-add', () => {
        modelSpace.removeEntity(lines[1].objectId)
        move(lines[1], 40)
        modelSpace.appendEntity(lines[1])
      })

      const afterCommit = freeze(modelSpaceState(local))
      expect(afterCommit).toHaveLength(2)
      expect(lines[1].startPoint.x).toBe(41)
      // No change survived the cancellation, so there is nothing to undo.
      expect(manager.canUndo()).toBe(false)
      expect(
        manager.getSnapshotSharingMetrics().retainedUndoChanges
      ).toBe(0)
    })

    it('cancels out a structural append and removal of the same id', () => {
      const { db: local, lines } = createDatabase(1)
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const modelSpace = local.tables.blockTable.modelSpace
      const original = freeze(modelSpaceState(local))
      const added = createLine(70)

      manager.runUndoable('Append then erase', () => {
        modelSpace.appendEntity(added)
        move(local.openObjectForWrite<AcDbLine>(lines[0].objectId)!, 1)
        modelSpace.removeEntity(added.objectId)
      })

      const afterCommit = freeze(modelSpaceState(local))
      expect(afterCommit).toHaveLength(1)
      expect(afterCommit[0]).not.toContain(added.objectId)

      manager.undo()
      expect(modelSpaceState(local)).toEqual(original)
      manager.redo()
      expect(modelSpaceState(local)).toEqual(afterCommit)
    })
  })

  describe('nested transactions (item 10)', () => {
    it('merges a committed child into the parent undo step', () => {
      const { db: local, lines } = createDatabase(2)
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const original = freeze(modelSpaceState(local))

      manager.startUndoMark('Nested move')
      manager.startTransaction()
      move(local.openObjectForWrite<AcDbLine>(lines[0].objectId)!, 10)

      manager.startTransaction()
      move(local.openObjectForWrite<AcDbLine>(lines[1].objectId)!, 20)
      manager.commitTransaction()

      manager.commitTransaction()
      manager.endUndoMark()

      const afterCommit = freeze(modelSpaceState(local))
      manager.undo()
      expect(modelSpaceState(local)).toEqual(original)
      expect(manager.canUndo()).toBe(false)
      manager.redo()
      expect(modelSpaceState(local)).toEqual(afterCommit)
    })

    it('discards a child abort without disturbing the parent', () => {
      const { db: local, lines } = createDatabase(2)
      const manager = local.transactionManager
      manager.snapshotSharing = true

      manager.startUndoMark('Parent then aborted child')
      manager.startTransaction()
      move(local.openObjectForWrite<AcDbLine>(lines[0].objectId)!, 10)

      manager.startTransaction()
      move(local.openObjectForWrite<AcDbLine>(lines[1].objectId)!, 20)
      manager.abortTransaction()
      expect(lines[1].startPoint.x).toBe(1)

      manager.commitTransaction()
      manager.endUndoMark()

      expect(lines[0].startPoint.x).toBe(10)
      expect(lines[1].startPoint.x).toBe(1)
      manager.undo()
      expect(lines[0].startPoint.x).toBe(0)
      expect(lines[1].startPoint.x).toBe(1)
    })
  })

  describe('failure and history (items 11-15)', () => {
    it('rolls every entity back when the caller throws', () => {
      const { db: local, lines } = createDatabase(3)
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const original = freeze(modelSpaceState(local))

      expect(() =>
        manager.runUndoable('Move and fail', tr => {
          for (const line of lines) {
            move(tr.getObject<AcDbLine>(line.objectId, AcDbOpenMode.kForWrite)!, 9)
          }
          throw new Error('injected')
        })
      ).toThrow('injected')

      expect(modelSpaceState(local)).toEqual(original)
      expect(manager.canUndo()).toBe(false)
    })

    it('clears the redo stack when a new edit follows an undo', () => {
      const { db: local, lines } = createDatabase(1)
      const manager = local.transactionManager
      manager.snapshotSharing = true

      manager.runUndoable('First', tr => {
        move(tr.getObject<AcDbLine>(lines[0].objectId, AcDbOpenMode.kForWrite)!, 10)
      })
      manager.undo()
      expect(manager.canRedo()).toBe(true)

      manager.runUndoable('Second', tr => {
        move(tr.getObject<AcDbLine>(lines[0].objectId, AcDbOpenMode.kForWrite)!, 30)
      })

      expect(manager.canRedo()).toBe(false)
      expect(lines[0].startPoint.x).toBe(30)
      manager.undo()
      expect(lines[0].startPoint.x).toBe(0)
    })

    it('stays exact across five undo / redo rounds', () => {
      const { db: local, lines } = createDatabase(3)
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const states: string[][] = [freeze(modelSpaceState(local))]

      for (let round = 0; round < 5; round++) {
        manager.runUndoable(`Move ${round}`, tr => {
          for (const line of lines) {
            move(tr.getObject<AcDbLine>(line.objectId, AcDbOpenMode.kForWrite)!, round + 1)
          }
        })
        states.push(freeze(modelSpaceState(local)))
      }

      for (let round = 5; round > 0; round--) {
        expect(manager.undo()).toBe(true)
        expect(modelSpaceState(local)).toEqual(states[round - 1])
      }
      expect(manager.canUndo()).toBe(false)

      for (let round = 1; round <= 5; round++) {
        expect(manager.redo()).toBe(true)
        expect(modelSpaceState(local)).toEqual(states[round])
      }
    })

    it('drops the oldest records when the history is exhausted', () => {
      const { db: local, lines } = createDatabase(1)
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const depth = 105

      for (let i = 0; i < depth; i++) {
        manager.runUndoable(`Move ${i}`, tr => {
          move(tr.getObject<AcDbLine>(lines[0].objectId, AcDbOpenMode.kForWrite)!, 1)
        })
      }

      // maxDepth is 100, so the five oldest records were discarded: the history
      // holds exactly 100 undoable steps and their snapshots are unreachable.
      let steps = 0
      while (manager.undo()) steps++
      expect(steps).toBe(100)
      expect(manager.canUndo()).toBe(false)
      // The five evicted steps cannot be replayed, so the line keeps their
      // effects (105 moves, only 100 undone).
      expect(lines[0].startPoint.x).toBe(5)
    })

    it('releases every retained snapshot when the history is cleared', () => {
      const { db: local, lines } = createDatabase(2)
      const manager = local.transactionManager
      manager.snapshotSharing = true

      manager.runUndoable('Move', tr => {
        for (const line of lines) {
          move(tr.getObject<AcDbLine>(line.objectId, AcDbOpenMode.kForWrite)!, 3)
        }
      })
      expect(manager.getSnapshotSharingMetrics().retainedUndoChanges).toBe(2)

      manager.clearUndoStack()

      expect(manager.getSnapshotSharingMetrics().retainedUndoChanges).toBe(0)
      expect(manager.canUndo()).toBe(false)
      expect(manager.canRedo()).toBe(false)
      // A document opened afterwards starts with an empty history as well.
      const other = new AcDbDatabase()
      expect(other.transactionManager.getSnapshotSharingMetrics()).toMatchObject(
        {
          retainedUndoChanges: 0,
          rollbackSnapshotClones: 0,
          beforeSnapshotClones: 0
        }
      )
    })
  })

  describe('entity kinds (item 16)', () => {
    /** Builds one instance of each named entity type, uncommitted. */
    function createSamples() {
      const polyline = new AcDbPolyline()
      polyline.addVertexAt(0, new AcGePoint2d(0, 0), 0, 1, 1)
      polyline.addVertexAt(1, new AcGePoint2d(10, 0))

      const insert = new AcDbBlockReference('TEST_BLOCK')
      insert.position = { x: 5, y: 5, z: 0 }

      const text = new AcDbText()
      text.position = new AcGePoint3d(1, 2, 0)
      text.textString = 'label'

      const mtext = new AcDbMText()
      mtext.location = { x: 3, y: 4, z: 0 }
      mtext.contents = 'note'

      return { polyline, insert, text, mtext }
    }

    it('round-trips LINE / LWPOLYLINE / INSERT / TEXT / MTEXT', () => {
      const { polyline, insert, text, mtext } = createSamples()
      const local = new AcDbDatabase()
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const modelSpace = local.tables.blockTable.modelSpace
      for (const entity of [polyline, insert, text, mtext]) {
        modelSpace.appendEntity(entity)
      }
      const original = freeze(modelSpaceState(local))

      manager.runUndoable('Move all kinds', tr => {
        const opened = tr.getObject<AcDbPolyline>(
          polyline.objectId,
          AcDbOpenMode.kForWrite
        )!
        opened.removeVertexAt(1)
        opened.addVertexAt(1, new AcGePoint2d(-1, -1))
        opened.closed = true
        opened.elevation = 7

        const openedInsert = tr.getObject<AcDbBlockReference>(
          insert.objectId,
          AcDbOpenMode.kForWrite
        )!
        openedInsert.position = { x: 50, y: 60, z: 0 }
        openedInsert.rotation = Math.PI / 2
        openedInsert.scaleFactors = { x: 2, y: 3, z: 1 }

        const openedText = tr.getObject<AcDbText>(
          text.objectId,
          AcDbOpenMode.kForWrite
        )!
        openedText.textString = 'changed'
        openedText.height = 9

        const openedMText = tr.getObject<AcDbMText>(
          mtext.objectId,
          AcDbOpenMode.kForWrite
        )!
        openedMText.contents = 'changed note'
        openedMText.height = 4
      })

      const afterCommit = freeze(modelSpaceState(local))
      expect(afterCommit).not.toEqual(original)

      manager.undo()
      expect(modelSpaceState(local)).toEqual(original)
      manager.redo()
      expect(modelSpaceState(local)).toEqual(afterCommit)
    })
  })

  describe('existing layer and block semantics (item 17)', () => {
    it('keeps the locked flag and the entity state it guards', () => {
      const { db: local, lines } = createDatabase(1)
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const layer = new AcDbLayerTableRecord()
      layer.name = '0'
      local.tables.layerTable.add(layer)
      expect(layer.isLocked).toBe(false)

      manager.runUndoable('Lock layer', tr => {
        const opened = tr.getObject<AcDbLayerTableRecord>(
          layer.objectId,
          AcDbOpenMode.kForWrite
        )!
        opened.isLocked = true
        move(tr.getObject<AcDbLine>(lines[0].objectId, AcDbOpenMode.kForWrite)!, 2)
      })
      expect(layer.isLocked).toBe(true)
      expect(lines[0].startPoint.x).toBe(2)

      manager.undo()
      // The data model stores the flag; locking is enforced by the editor, so
      // sharing must not change either side of that contract.
      expect(layer.isLocked).toBe(false)
      expect(lines[0].startPoint.x).toBe(0)

      manager.redo()
      expect(layer.isLocked).toBe(true)
      expect(lines[0].startPoint.x).toBe(2)
    })

    it('round-trips an entity inside a block definition', () => {
      const local = new AcDbDatabase()
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const blockTable = local.tables.blockTable
      const record = new AcDbBlockTableRecord()
      record.name = 'MEMBER_BLOCK'
      blockTable.add(record)
      const member = createLine(11)
      record.appendEntity(member)
      const original = freeze(modelSpaceState(local))
      const before = stateOf(member)

      manager.runUndoable('Move block member', tr => {
        move(tr.getObject<AcDbLine>(member.objectId, AcDbOpenMode.kForWrite)!, 4)
      })
      expect(member.startPoint.x).toBe(15)

      manager.undo()
      expect(stateOf(member)).toBe(before)
      expect(modelSpaceState(local)).toEqual(original)
      manager.redo()
      expect(member.startPoint.x).toBe(15)
    })
  })

  describe('phase 2.7 batch erase redo (item 19)', () => {
    it('restores and re-erases a 2k batch with identical geometry', () => {
      const { db: local, lines } = createDatabase(2_000)
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const modelSpace = local.tables.blockTable.modelSpace
      const original = freeze(modelSpaceState(local))
      const ids = lines.map(line => line.objectId)

      manager.runUndoable('Erase', () => {
        modelSpace.removeEntity(ids)
      })
      expect(modelSpaceState(local)).toHaveLength(0)

      manager.undo()
      expect(modelSpaceState(local)).toEqual(original)

      manager.redo()
      expect(modelSpaceState(local)).toHaveLength(0)

      manager.undo()
      expect(modelSpaceState(local)).toEqual(original)
    })
  })

  describe('snapshot immutability under sharing', () => {
    it('never mutates the shared before snapshot', () => {
      const { db: local, lines } = createDatabase(2)
      const manager = local.transactionManager
      manager.snapshotSharing = true
      const original = freeze(modelSpaceState(local))
      const tr = manager.startTransaction()

      const first = local.openObjectForWrite<AcDbLine>(lines[0].objectId)!
      const internals = tr as unknown as {
        originalStates: Map<string, AcDbObject>
        recorder: { getChanges(): Array<{ before?: AcDbObject }> }
      }
      const before = internals.originalStates.get(lines[0].objectId)!
      // The whole point of the change: one instance, two consumers.
      expect(internals.recorder.getChanges()[0].before).toBe(before)
      const fingerprint = stateOf(before as unknown as AcDbEntity)

      move(first, 12)
      // Mutating the live object must not reach the snapshot it came from.
      expect(stateOf(before as unknown as AcDbEntity)).toBe(fingerprint)

      manager.startUndoMark('Shared snapshot')
      manager.commitTransaction()
      manager.endUndoMark()
      manager.undo()
      // Replaying the snapshot reads it; the object comes back unchanged.
      expect(stateOf(before as unknown as AcDbEntity)).toBe(fingerprint)
      expect(modelSpaceState(local)).toEqual(original)
    })
  })
})
