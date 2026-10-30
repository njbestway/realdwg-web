import { AcGePoint3d } from '@mlightcad/geometry-engine'

import { AcDbObject, AcDbOpenMode } from '../src/base'
import { AcDbDatabase } from '../src/database/AcDbDatabase'
import { AcDbLine } from '../src/entity/AcDbLine'

/**
 * Runtime proof of the transaction snapshot model (phase 2.10 Task B1).
 *
 * The ownership audit derives three snapshots per modified object from the
 * sources:
 *
 *   clone #1 -> AcDbTransaction.originalStates   (abort / rollback)
 *   clone #2 -> AcDbChangeRecorder.before        (undo)
 *   clone #3 -> AcDbChangeRecorder.after         (redo, at finalize)
 *
 * These tests count real `clonePreservingIdentity` calls instead of assuming
 * that model. They describe the *baseline* contract (3N for a pure modify
 * transaction over N ids) and are meant to stay green when snapshot sharing is
 * off; `AcDbTransactionSnapshotSharing.spec.ts` asserts the 2N variant.
 */

/** Live counter around `AcDbObject.prototype.clonePreservingIdentity`. */
interface CloneCounter {
  /** Calls observed since the last {@link CloneCounter.reset}. */
  read: () => number
  /** Zeroes the counter without removing the spy. */
  reset: () => void
  /** Restores the original prototype method. */
  restore: () => void
}

/**
 * Installs a counting spy on the snapshot entry point.
 *
 * `clonePreservingIdentity` is the single funnel for every transaction
 * snapshot: rollback, before and after all call it, so counting here captures
 * all three without touching production code.
 */
function countClones(): CloneCounter {
  const original = AcDbObject.prototype.clonePreservingIdentity
  let total = 0
  const spy = jest.spyOn(AcDbObject.prototype, 'clonePreservingIdentity')
  spy.mockImplementation(function (this: AcDbObject) {
    total++
    return original.call(this)
  })
  return {
    read: () => total,
    reset: () => {
      total = 0
    },
    restore: () => {
      spy.mockRestore()
    }
  }
}

/** Builds a database with `count` lines in model space. */
function createDatabase(count: number): { db: AcDbDatabase; lines: AcDbLine[] } {
  const db = new AcDbDatabase()
  const lines: AcDbLine[] = []
  for (let i = 0; i < count; i++) {
    const line = new AcDbLine(
      new AcGePoint3d(i, 0, 0),
      new AcGePoint3d(i, 10, 0)
    )
    db.tables.blockTable.modelSpace.appendEntity(line)
    lines.push(line)
  }
  return { db, lines }
}

/** Moves one line in place, mimicking a MOVE transform. */
function move(line: AcDbLine, dx: number): void {
  line.startPoint = new AcGePoint3d(line.startPoint.x + dx, line.startPoint.y, 0)
  line.endPoint = new AcGePoint3d(line.endPoint.x + dx, line.endPoint.y, 0)
}

describe('transaction snapshot flow (baseline cloning contract)', () => {
  let counter: CloneCounter

  beforeEach(() => {
    counter = countClones()
  })

  afterEach(() => {
    counter.restore()
  })

  it('clones 2N inside a pure modify transaction and 3N after commit', () => {
    const n = 5
    const { db, lines } = createDatabase(n)
    const manager = db.transactionManager

    manager.startUndoMark('Move')
    const tr = manager.startTransaction()
    for (const line of lines) {
      const opened = tr.getObject<AcDbLine>(
        line.objectId,
        AcDbOpenMode.kForWrite
      )
      move(opened!, 1)
    }

    // clone #1 (originalStates) + clone #2 (change.before) per object.
    expect(counter.read()).toBe(2 * n)

    manager.commitTransaction()
    manager.endUndoMark()

    // clone #3 (change.after) happens during finalize.
    expect(counter.read()).toBe(3 * n)
  })

  it('does not re-clone when the same object is opened for write twice', () => {
    const { db, lines } = createDatabase(1)
    const line = lines[0]
    const tr = db.transactionManager.startTransaction()

    tr.getObject<AcDbLine>(line.objectId, AcDbOpenMode.kForWrite)
    tr.getObject<AcDbLine>(line.objectId, AcDbOpenMode.kForWrite)
    tr.getObject<AcDbLine>(line.objectId, AcDbOpenMode.kForWrite)

    expect(counter.read()).toBe(2)
    db.transactionManager.abortTransaction()
  })

  it('creates no after snapshot when the transaction aborts', () => {
    const n = 3
    const { db, lines } = createDatabase(n)
    const manager = db.transactionManager

    manager.startTransaction()
    for (const line of lines) {
      const opened = db.openObjectForWrite<AcDbLine>(line.objectId)
      move(opened!, 2)
    }
    expect(counter.read()).toBe(2 * n)

    manager.abortTransaction()
    expect(counter.read()).toBe(2 * n)
    expect(lines[0].startPoint.x).toBe(0)
  })

  it('clones the pair once when a child transaction commits into its parent', () => {
    const { db, lines } = createDatabase(1)
    const line = lines[0]
    const manager = db.transactionManager

    manager.startUndoMark('Move')
    manager.startTransaction()
    const child = manager.startTransaction()
    const opened = child.getObject<AcDbLine>(
      line.objectId,
      AcDbOpenMode.kForWrite
    )
    move(opened!, 5)

    // The child owns the only modify entry; the parent merges it and does not
    // clone again, because `modifyById` already covers that object id.
    manager.commitTransaction()
    expect(counter.read()).toBe(2)

    // The outermost commit still finalizes that merged entry, so the redo
    // snapshot is produced exactly once.
    manager.commitTransaction()
    manager.endUndoMark()

    expect(counter.read()).toBe(3)
    expect(manager.canUndo()).toBe(true)
    expect(line.startPoint.x).toBe(5)
  })

  it('does not clone while replaying undo or redo', () => {
    const n = 2
    const { db, lines } = createDatabase(n)
    const manager = db.transactionManager

    manager.runUndoable('Move', () => {
      for (const line of lines) {
        const opened = db.openObjectForWrite<AcDbLine>(line.objectId)
        move(opened!, 3)
      }
    })

    const afterCommit = counter.read()
    expect(afterCommit).toBe(3 * n)

    manager.undo()
    expect(counter.read()).toBe(afterCommit)
    expect(lines[0].startPoint.x).toBe(0)

    manager.redo()
    expect(counter.read()).toBe(afterCommit)
    expect(lines[0].startPoint.x).toBe(3)
  })

  it('keeps before and after reachable after originalStates is cleared', () => {
    const { db, lines } = createDatabase(1)
    const line = lines[0]
    const manager = db.transactionManager

    manager.runUndoable('Move', () => {
      const opened = db.openObjectForWrite<AcDbLine>(line.objectId)
      move(opened!, 7)
    })

    // The transaction's rollback map is gone, yet both undo directions still
    // restore exactly: the undo record owns before/after independently.
    manager.undo()
    expect(line.startPoint.x).toBe(0)
    manager.redo()
    expect(line.startPoint.x).toBe(7)
    manager.undo()
    expect(line.startPoint.x).toBe(0)
  })
})
