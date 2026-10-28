import { AcGePoint3d } from '@mlightcad/geometry-engine'
import { AcDbOpenMode } from '../src/base'
import type { AcDbChangeContainer } from '../src/database/transaction/AcDbDatabaseChange'
import { AcDbDatabase } from '../src/database/AcDbDatabase'
import { AcDbChangeRecorder } from '../src/database/transaction/AcDbChangeRecorder'
import { AcDbLine } from '../src/entity/AcDbLine'

type Structural = Extract<
  ReturnType<AcDbChangeRecorder['getChanges']>[number],
  { kind: 'append' | 'remove' }
>

const MODEL_SPACE: AcDbChangeContainer = {
  type: 'blockTableRecord',
  ownerId: 'B1'
}
const OTHER_SPACE: AcDbChangeContainer = {
  type: 'blockTableRecord',
  ownerId: 'B2'
}

function createDocument(count = 0): { db: AcDbDatabase; lines: AcDbLine[] } {
  const db = new AcDbDatabase()
  const lines: AcDbLine[] = []
  for (let index = 0; index < count; index++) {
    const line = new AcDbLine(
      new AcGePoint3d(index, 0, 0),
      new AcGePoint3d(index + 10, 0, 0)
    )
    db.tables.blockTable.modelSpace.appendEntity(line)
    lines.push(line)
  }
  return { db, lines }
}

function structuralKinds(recorder: AcDbChangeRecorder): string[] {
  return recorder
    .getChanges()
    .filter((change): change is Structural => change.kind !== 'modify')
    .filter(change => change.kind === 'append' || change.kind === 'remove')
    .map(change => change.kind)
}

describe('AcDbChangeRecorder', () => {
  describe('modify index', () => {
    it('records one entry with the first before snapshot and the final after state', () => {
      const { db, lines } = createDocument(1)
      const line = lines[0]
      const recorder = new AcDbChangeRecorder()

      recorder.recordModify(line)
      line.endPoint = new AcGePoint3d(30, 0, 0)
      line.endPoint = new AcGePoint3d(40, 0, 0)

      const changes = recorder.getChanges()
      expect(changes).toHaveLength(1)
      expect(changes[0].kind).toBe('modify')

      recorder.finalize(db)
      const entry = recorder.getChanges()[0]
      expect(entry.kind).toBe('modify')
      if (entry.kind !== 'modify') throw new Error('unreachable')
      expect((entry.before as AcDbLine).endPoint.x).toBe(10)
      expect((entry.after as AcDbLine).endPoint.x).toBe(40)
      expect(recorder.validateIndexes()).toEqual([])
    })

    it('keeps exactly one entry when the same entity is written many times', () => {
      const { db, lines } = createDocument(1)
      const recorder = new AcDbChangeRecorder()

      for (let index = 0; index < 100; index++) {
        recorder.recordModify(lines[0])
      }
      lines[0].endPoint = new AcGePoint3d(99, 0, 0)

      expect(recorder.getChanges()).toHaveLength(1)
      recorder.finalize(db)
      const entry = recorder.getChanges()[0]
      if (entry.kind !== 'modify') throw new Error('unreachable')
      expect((entry.before as AcDbLine).endPoint.x).toBe(10)
      expect((entry.after as AcDbLine).endPoint.x).toBe(99)
      expect(recorder.validateIndexes()).toEqual([])
    })

    it('hasModify answers from the index for known and unknown ids', () => {
      const { lines } = createDocument(2)
      const recorder = new AcDbChangeRecorder()
      recorder.recordModify(lines[0])

      expect(recorder.hasModify(lines[0].objectId)).toBe(true)
      expect(recorder.hasModify(lines[1].objectId)).toBe(false)
      expect(recorder.hasModify('not-an-id')).toBe(false)
    })

    it('handles 50k distinct modifies without duplicate entries', () => {
      const { lines } = createDocument(50000)
      const recorder = new AcDbChangeRecorder()
      for (const line of lines) recorder.recordModify(line)
      for (const line of lines) recorder.recordModify(line)

      expect(recorder.getChanges()).toHaveLength(50000)
      expect(recorder.validateIndexes()).toEqual([])
    }, 180000)

    it('handles 100k distinct modifies without duplicate entries', () => {
      const { lines } = createDocument(100000)
      const recorder = new AcDbChangeRecorder()
      for (const line of lines) recorder.recordModify(line)
      for (const line of lines) recorder.recordModify(line)

      expect(recorder.getChanges()).toHaveLength(100000)
      expect(recorder.validateIndexes()).toEqual([])
    }, 300000)
  })

  describe('sysvar index', () => {
    it('normalizes the name and keeps the first value', () => {
      const recorder = new AcDbChangeRecorder()
      recorder.recordSysvar('ORTHOMODE', 0)
      recorder.recordSysvar('orthomode', 1)
      recorder.recordSysvar('OrthoMode', 2)

      const changes = recorder.getChanges()
      expect(changes).toHaveLength(1)
      expect(changes[0].kind).toBe('sysvar')
      if (changes[0].kind !== 'sysvar') throw new Error('unreachable')
      expect(changes[0].name).toBe('orthomode')
      expect(changes[0].before).toBe(0)
      expect(recorder.validateIndexes()).toEqual([])
    })

    it('keeps different variables apart', () => {
      const recorder = new AcDbChangeRecorder()
      recorder.recordSysvar('a', 1)
      recorder.recordSysvar('b', 2)
      expect(recorder.getChanges()).toHaveLength(2)
      expect(recorder.validateIndexes()).toEqual([])
    })
  })

  describe('structural index', () => {
    it('cancels append followed by remove', () => {
      const { lines } = createDocument(1)
      const recorder = new AcDbChangeRecorder()
      recorder.recordAppend(MODEL_SPACE, lines[0])
      recorder.recordRemove(MODEL_SPACE, lines[0])

      expect(recorder.getChanges()).toHaveLength(0)
      expect(recorder.validateIndexes()).toEqual([])
    })

    it('cancels remove followed by append', () => {
      const { lines } = createDocument(1)
      const recorder = new AcDbChangeRecorder()
      recorder.recordRemove(MODEL_SPACE, lines[0])
      recorder.recordAppend(MODEL_SPACE, lines[0])

      expect(recorder.getChanges()).toHaveLength(0)
      expect(recorder.validateIndexes()).toEqual([])
    })

    it('keeps the log order of the surviving entries', () => {
      const { lines } = createDocument(4)
      const recorder = new AcDbChangeRecorder()
      recorder.recordAppend(MODEL_SPACE, lines[0])
      recorder.recordAppend(MODEL_SPACE, lines[1])
      recorder.recordRemove(MODEL_SPACE, lines[0])
      recorder.recordAppend(MODEL_SPACE, lines[2])
      recorder.recordAppend(MODEL_SPACE, lines[3])

      const ids = recorder
        .getChanges()
        .map(change => (change.kind === 'append' ? change.object.objectId : '?'))
      expect(ids).toEqual([lines[1].objectId, lines[2].objectId, lines[3].objectId])
      expect(structuralKinds(recorder)).toEqual(['append', 'append', 'append'])
      expect(recorder.validateIndexes()).toEqual([])
    })

    it('does not cancel across different containers with the same object id', () => {
      const { lines } = createDocument(1)
      const recorder = new AcDbChangeRecorder()
      recorder.recordAppend(MODEL_SPACE, lines[0])
      recorder.recordRemove(OTHER_SPACE, lines[0])

      expect(recorder.getChanges()).toHaveLength(2)
      expect(structuralKinds(recorder)).toEqual(['append', 'remove'])
      expect(recorder.validateIndexes()).toEqual([])
    })

    it('does not cancel across a symbol table and a block table record', () => {
      const { lines } = createDocument(1)
      const recorder = new AcDbChangeRecorder()
      recorder.recordAppend(
        { type: 'symbolTable', tableName: 'LAYER' },
        lines[0]
      )
      recorder.recordRemove(MODEL_SPACE, lines[0])

      expect(recorder.getChanges()).toHaveLength(2)
      expect(recorder.validateIndexes()).toEqual([])
    })

    it('cancels the earliest duplicate append, like the previous linear scan', () => {
      const { lines } = createDocument(1)
      const recorder = new AcDbChangeRecorder()
      recorder.recordAppend(MODEL_SPACE, lines[0])
      recorder.recordAppend(MODEL_SPACE, lines[0])
      expect(recorder.getChanges()).toHaveLength(2)

      recorder.recordRemove(MODEL_SPACE, lines[0])
      expect(recorder.getChanges()).toHaveLength(1)
      expect(structuralKinds(recorder)).toEqual(['append'])
      expect(recorder.validateIndexes()).toEqual([])
    })
  })

  describe('clear and nested merge', () => {
    it('clears every index together with the log', () => {
      const { lines } = createDocument(2)
      const recorder = new AcDbChangeRecorder()
      recorder.recordModify(lines[0])
      recorder.recordSysvar('x', 1)
      recorder.recordAppend(MODEL_SPACE, lines[1])
      expect(recorder.getChanges()).toHaveLength(3)

      recorder.clear()

      expect(recorder.getChanges()).toHaveLength(0)
      expect(recorder.hasModify(lines[0].objectId)).toBe(false)
      expect(recorder.validateIndexes()).toEqual([])
      recorder.recordSysvar('x', 2)
      expect(recorder.getChanges()).toHaveLength(1)
    })

    it('merges a child recorder without duplicating entries', () => {
      const { lines } = createDocument(2)
      const parent = new AcDbChangeRecorder()
      const child = new AcDbChangeRecorder()
      parent.recordModify(lines[0])
      parent.recordSysvar('x', 1)
      child.recordModify(lines[0])
      child.recordModify(lines[1])
      child.recordSysvar('X', 2)
      child.recordAppend(MODEL_SPACE, lines[1])

      parent.mergeFrom(child)

      // modify(line0) is deduplicated, modify(line1) and append(line1) are new,
      // sysvar('X') deduplicates against 'x'.
      expect(parent.getChanges()).toHaveLength(4)
      expect(parent.validateIndexes()).toEqual([])
    })

    it('cancels a child append against a parent remove', () => {
      const { lines } = createDocument(1)
      const parent = new AcDbChangeRecorder()
      const child = new AcDbChangeRecorder()
      parent.recordRemove(MODEL_SPACE, lines[0])
      child.recordAppend(MODEL_SPACE, lines[0])

      parent.mergeFrom(child)

      expect(parent.getChanges()).toHaveLength(0)
      expect(parent.validateIndexes()).toEqual([])
    })
  })
})

describe('AcDbDatabaseTransactionManager with indexed recorder', () => {
  it('rolls back a mixed modify / append / remove transaction', () => {
    const { db, lines } = createDocument(2)
    const manager = db.transactionManager
    const appended = new AcDbLine(
      new AcGePoint3d(0, 50, 0),
      new AcGePoint3d(10, 50, 0)
    )

    manager.startUndoMark('Mixed')
    manager.startTransaction()
    const tr = manager.startTransaction()
    const opened = tr.getObject<AcDbLine>(lines[0].objectId, AcDbOpenMode.kForWrite)
    opened!.endPoint = new AcGePoint3d(99, 0, 0)
    db.tables.blockTable.modelSpace.appendEntity(appended)
    db.tables.blockTable.modelSpace.removeEntity(lines[1].objectId)
    manager.commitTransaction()
    manager.commitTransaction()
    manager.endUndoMark()

    expect(db.tables.blockTable.getEntityById(lines[1].objectId)).toBeUndefined()
    expect(db.tables.blockTable.getEntityById(appended.objectId)).toBe(appended)

    manager.undo()
    expect(lines[0].endPoint.x).toBe(10)
    // Undo re-appends the recorded snapshot, so the object id survives even when
    // the JavaScript instance is not the one the fixture kept.
    const restored = db.tables.blockTable.getEntityById(lines[1].objectId)
    expect(restored).toBeDefined()
    expect((restored as AcDbLine).endPoint.x).toBe(11)
    expect(db.tables.blockTable.getEntityById(appended.objectId)).toBeUndefined()

    manager.redo()
    expect(lines[0].endPoint.x).toBe(99)
    expect(db.tables.blockTable.getEntityById(lines[1].objectId)).toBeUndefined()
    expect(db.tables.blockTable.getEntityById(appended.objectId)).toBeDefined()
  })

  it('cancels a remove followed by an append in one transaction', () => {
    const { db, lines } = createDocument(1)
    const manager = db.transactionManager
    manager.startUndoMark('Move-like')
    manager.startTransaction()
    db.tables.blockTable.modelSpace.removeEntity(lines[0].objectId)
    db.tables.blockTable.modelSpace.appendEntity(lines[0])
    manager.commitTransaction()
    manager.endUndoMark()

    expect(db.tables.blockTable.getEntityById(lines[0].objectId)).toBe(lines[0])
    expect(manager.canUndo()).toBe(false)
  })

  it('keeps undo / redo stable across many rounds on the same entity', () => {
    const { db, lines } = createDocument(1)
    const manager = db.transactionManager
    const line = lines[0]

    for (let round = 1; round <= 10; round++) {
      manager.runUndoable(`Move ${round}`, tr => {
        // Recording a modify entry requires an open-for-write access, exactly
        // like the editor command path does through AcApEntityService.
        const opened = tr.getObject<AcDbLine>(
          line.objectId,
          AcDbOpenMode.kForWrite
        )
        opened!.endPoint = new AcGePoint3d(round * 100, 0, 0)
      })
    }
    expect(line.endPoint.x).toBe(1000)

    for (let round = 10; round >= 1; round--) {
      manager.undo()
      // Round 1 restores the state before the first edit, i.e. the fixture value.
      expect(line.endPoint.x).toBe(round === 1 ? 10 : (round - 1) * 100)
    }

    for (let round = 1; round <= 10; round++) {
      manager.redo()
      expect(line.endPoint.x).toBe(round * 100)
    }
  })

  it('restores erased entities on undo and re-erases on redo', () => {
    const { db, lines } = createDocument(5)
    const manager = db.transactionManager
    const ids = lines.map(line => line.objectId)

    manager.runUndoable('Erase', () => {
      db.tables.blockTable.modelSpace.removeEntity(ids)
    })
    expect(db.tables.blockTable.getEntityById(ids[0])).toBeUndefined()

    manager.undo()
    for (const id of ids) {
      expect(db.tables.blockTable.getEntityById(id)).toBeDefined()
    }

    manager.redo()
    for (const id of ids) {
      expect(db.tables.blockTable.getEntityById(id)).toBeUndefined()
    }
  })

  it('reports opened-for-write state for symbol table records', () => {
    const { db } = createDocument(0)
    const manager = db.transactionManager
    db.createDefaultData()
    const layer = db.tables.layerTable.getAt('0')!

    const tr = manager.startTransaction()
    expect(manager.isOpenedForWriteInTransaction(layer.objectId)).toBe(false)
    tr.getObject(layer.objectId, AcDbOpenMode.kForWrite)
    expect(manager.isOpenedForWriteInTransaction(layer.objectId)).toBe(true)
    manager.abortTransaction()
    expect(manager.isOpenedForWriteInTransaction(layer.objectId)).toBe(false)
  })

  it('dispatches one entityModified event per entity in change order', () => {
    const { db, lines } = createDocument(3)
    const manager = db.transactionManager
    const seen: string[] = []
    db.events.entityModified.addEventListener(args => {
      const payload = args.entity
      const list = Array.isArray(payload) ? payload : [payload]
      for (const entity of list) seen.push(entity.objectId)
    })

    manager.runUndoable('Move three', tr => {
      for (const line of lines) {
        const opened = tr.getObject<AcDbLine>(
          line.objectId,
          AcDbOpenMode.kForWrite
        )
        opened!.endPoint = new AcGePoint3d(line.endPoint.x + 5, 0, 0)
      }
    })

    expect(seen).toEqual(lines.map(line => line.objectId))
  })

  it('keeps object ids stable across modify rounds', () => {
    const { db, lines } = createDocument(3)
    const manager = db.transactionManager
    // `objectId` is the database handle, so comparing it also covers "the
    // handle did not change".
    const snapshot = lines.map(line => line.objectId)

    manager.runUndoable('Move', tr => {
      for (const line of lines) {
        const opened = tr.getObject<AcDbLine>(
          line.objectId,
          AcDbOpenMode.kForWrite
        )
        opened!.endPoint = new AcGePoint3d(line.endPoint.x + 1, 0, 0)
      }
    })
    manager.undo()
    manager.redo()

    expect(lines.map(line => line.objectId)).toEqual(snapshot)
  })

  it('rolls the database back when a transaction body throws', () => {
    const { db, lines } = createDocument(1)
    const manager = db.transactionManager
    const line = lines[0]

    expect(() =>
      manager.runUndoable('Failing edit', tr => {
        const opened = tr.getObject<AcDbLine>(
          line.objectId,
          AcDbOpenMode.kForWrite
        )
        opened!.endPoint = new AcGePoint3d(500, 0, 0)
        throw new Error('boom')
      })
    ).toThrow('boom')

    expect(line.endPoint.x).toBe(10)
    expect(manager.canUndo()).toBe(false)
    expect(db.tables.blockTable.getEntityById(line.objectId)).toBe(line)
  })

  it('keeps the recorder indexes consistent through commit and abort', () => {
    const { db, lines } = createDocument(4)
    const manager = db.transactionManager
    const extra = new AcDbLine(new AcGePoint3d(0, 9, 0), new AcGePoint3d(1, 9, 0))

    manager.startUndoMark('Consistency')
    manager.startTransaction()
    manager.currentTransaction()!.recorder.recordModify(lines[0])
    manager.currentTransaction()!.recorder.recordAppend(
      { type: 'blockTableRecord', ownerId: 'B9' },
      extra
    )
    manager.currentTransaction()!.recorder.recordRemove(
      { type: 'blockTableRecord', ownerId: 'B9' },
      extra
    )
    manager.currentTransaction()!.recorder.recordSysvar('ORTHOMODE', 0)
    expect(manager.currentTransaction()!.recorder.validateIndexes()).toEqual([])
    manager.abortTransaction()
    manager.endUndoMark()

    manager.startUndoMark('Second')
    manager.startTransaction()
    manager.currentTransaction()!.recorder.recordModify(lines[1])
    manager.commitTransaction()
    manager.endUndoMark()

    manager.undo()
    manager.redo()
    expect(lines[1]).toBeDefined()
  })
})
