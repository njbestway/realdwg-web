import { AcGePoint3d } from '@mlightcad/geometry-engine'

import { AcDbObject, AcDbOpenMode } from '../src/base'
import { AcDbDatabase } from '../src/database/AcDbDatabase'
import { AcDbDatabaseTransaction } from '../src/database/transaction/AcDbDatabaseTransaction'
import {
  acdbFingerprintSnapshot,
  AcDbSnapshotIntegrityProbe} from '../src/database/transaction/AcDbSnapshotSharingIntegrity'
import { AcDbLine } from '../src/entity/AcDbLine'

/**
 * Phase 2.11 Task A2 — the shared snapshot must be provably immutable.
 *
 * Sharing is safe exactly as long as nothing ever writes to the snapshot that
 * the rollback map and the undo record both hold. These tests turn that
 * assumption into an assertion: the probe records the state at creation and
 * re-reads it at commit, abort, undo and redo, and a deliberately tampered
 * snapshot must be reported instead of silently corrupting the replay.
 *
 * The probe is a development/test instrument, so the tests also pin the two
 * production properties: it is off by default, and switching it on does not
 * change the clone budget.
 */

/** Model-space line factory. */
function createLine(x = 0): AcDbLine {
  return new AcDbLine(new AcGePoint3d(x, 0, 0), new AcGePoint3d(x, 10, 0))
}

/** Database holding `count` lines, already appended to model space. */
function createDatabase(count: number): {
  db: AcDbDatabase
  lines: AcDbLine[]
} {
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

/** The `before` snapshot the undo record will replay, i.e. the shared one. */
function beforeSnapshotOf(
  tr: AcDbDatabaseTransaction,
  objectId: string
): AcDbObject | undefined {
  const change = tr.recorder
    .getChanges()
    .find(item => item.kind === 'modify' && item.objectId === objectId)
  return change && change.kind === 'modify' ? change.before : undefined
}

describe('snapshot integrity probe (phase 2.11 Task A2)', () => {
  describe('fingerprint', () => {
    it('is stable for an unchanged snapshot and moves for a changed one', () => {
      const line = createLine(1)
      const snapshot = line.clonePreservingIdentity()

      const first = acdbFingerprintSnapshot(snapshot)
      const second = acdbFingerprintSnapshot(snapshot)
      expect(second).toEqual(first)

      move(snapshot as AcDbLine, 5)
      const third = acdbFingerprintSnapshot(snapshot)
      expect(third).not.toEqual(first)
    })

    it('ignores key insertion order but not values', () => {
      const a = createLine(2).clonePreservingIdentity()
      const b = createLine(2).clonePreservingIdentity()
      expect(acdbFingerprintSnapshot(b)).toEqual(acdbFingerprintSnapshot(a))

      move(b as AcDbLine, 0.0001)
      expect(acdbFingerprintSnapshot(b)).not.toEqual(
        acdbFingerprintSnapshot(a)
      )
    })
  })

  describe('probe bookkeeping', () => {
    it('evicts the oldest watch when maxWatched is reached', () => {
      const probe = new AcDbSnapshotIntegrityProbe({ maxWatched: 4 })
      for (let i = 0; i < 6; i++) {
        probe.watch(`id-${i}`, createLine(i).clonePreservingIdentity())
      }

      const metrics = probe.getMetrics()
      expect(metrics.watchedSnapshots).toBe(4)
      expect(metrics.evictedSnapshots).toBe(2)
    })

    it('detects an in-place write to a watched snapshot', () => {
      const probe = new AcDbSnapshotIntegrityProbe()
      const snapshot = createLine(0).clonePreservingIdentity()
      probe.watch('line-1', snapshot)

      expect(probe.check('line-1', snapshot, 'commit')).toBe(true)

      move(snapshot as AcDbLine, 3)
      expect(probe.check('line-1', snapshot, 'commit')).toBe(false)

      const metrics = probe.getMetrics()
      expect(metrics.checks).toBe(2)
      expect(metrics.violations).toBe(1)
      expect(metrics.recentViolations[0].objectId).toBe('line-1')
      expect(metrics.recentViolations[0].boundary).toBe('commit')
      expect(metrics.recentViolations[0].changedKeys.length).toBeGreaterThan(0)
    })
  })

  describe('transaction manager integration', () => {
    it('is disabled by default, so the production path never fingerprints', () => {
      const { db, lines } = createDatabase(1)
      const manager = db.transactionManager
      manager.snapshotSharing = true

      const metrics = manager.getSnapshotIntegrityMetrics()
      expect(metrics.enabled).toBe(false)
      expect(metrics.checks).toBe(0)

      manager.runUndoable('Move', () => {
        move(db.openObjectForWrite<AcDbLine>(lines[0].objectId)!, 1)
      })
      expect(manager.undo()).toBe(true)
      expect(manager.getSnapshotIntegrityMetrics().checks).toBe(0)
    })

    it('does not change the clone budget while attached', () => {
      const n = 4
      const { db, lines } = createDatabase(n)
      const manager = db.transactionManager
      manager.snapshotSharing = true
      manager.snapshotIntegrityProbe = new AcDbSnapshotIntegrityProbe()

      const original = AcDbObject.prototype.clonePreservingIdentity
      let clones = 0
      const spy = jest
        .spyOn(AcDbObject.prototype, 'clonePreservingIdentity')
        .mockImplementation(function (this: AcDbObject) {
          clones++
          return original.call(this)
        })

      try {
        manager.startUndoMark('Move')
        const tr = manager.startTransaction()
        for (const line of lines) {
          move(tr.getObject<AcDbLine>(line.objectId, AcDbOpenMode.kForWrite)!, 1)
        }
        expect(clones).toBe(n)

        manager.commitTransaction()
        manager.endUndoMark()
        // One `after` per object at finalize, unchanged by the probe.
        expect(clones).toBe(2 * n)
      } finally {
        spy.mockRestore()
      }
    })

    it('reports no violation across commit, undo and redo', () => {
      const { db, lines } = createDatabase(3)
      const manager = db.transactionManager
      manager.snapshotSharing = true
      manager.snapshotIntegrityProbe = new AcDbSnapshotIntegrityProbe()

      manager.runUndoable('Move', () => {
        for (const line of lines) {
          move(db.openObjectForWrite<AcDbLine>(line.objectId)!, 4)
        }
      })

      const afterCommit = manager.getSnapshotIntegrityMetrics()
      expect(afterCommit.violations).toBe(0)
      expect(afterCommit.watchedSnapshots).toBe(3)
      expect(afterCommit.lastBoundary).toBe('commit')

      expect(manager.undo()).toBe(true)
      const afterUndo = manager.getSnapshotIntegrityMetrics()
      expect(afterUndo.violations).toBe(0)
      expect(afterUndo.lastBoundary).toBe('undo')
      expect(afterUndo.checks).toBeGreaterThan(afterCommit.checks)

      expect(manager.redo()).toBe(true)
      const afterRedo = manager.getSnapshotIntegrityMetrics()
      expect(afterRedo.violations).toBe(0)
      expect(afterRedo.lastBoundary).toBe('redo')
      expect(afterRedo.checkedBoundaries).toBeGreaterThanOrEqual(3)
    })

    it('reports no violation across abort', () => {
      const { db, lines } = createDatabase(2)
      const manager = db.transactionManager
      manager.snapshotSharing = true
      manager.snapshotIntegrityProbe = new AcDbSnapshotIntegrityProbe()
      manager.resetSnapshotSharingMetrics()

      const tr = manager.startTransaction()
      for (const line of lines) {
        move(tr.getObject<AcDbLine>(line.objectId, AcDbOpenMode.kForWrite)!, 1)
      }
      manager.abortTransaction()

      const metrics = manager.getSnapshotIntegrityMetrics()
      expect(metrics.lastBoundary).toBe('abort')
      expect(metrics.violations).toBe(0)
      // `copyOnWriteCount` stays 0, but it is no longer the only evidence.
      expect(manager.getSnapshotSharingMetrics().copyOnWriteCount).toBe(0)
    })

    it('catches a write to the shared snapshot at the commit boundary', () => {
      const { db, lines } = createDatabase(1)
      const line = lines[0]
      const manager = db.transactionManager
      manager.snapshotSharing = true
      manager.snapshotIntegrityProbe = new AcDbSnapshotIntegrityProbe()

      const tr = manager.startTransaction()
      move(tr.getObject<AcDbLine>(line.objectId, AcDbOpenMode.kForWrite)!, 1)

      const shared = beforeSnapshotOf(tr, line.objectId)
      expect(shared).toBeDefined()

      // Simulate the bug this probe exists for: somebody writes to the snapshot.
      move(shared as AcDbLine, 100)

      manager.abortTransaction()

      const metrics = manager.getSnapshotIntegrityMetrics()
      expect(metrics.violations).toBe(1)
      expect(metrics.recentViolations[0].boundary).toBe('abort')
      expect(metrics.recentViolations[0].objectId).toBe(line.objectId)
      expect(metrics.recentViolations[0].changedKeys.length).toBeGreaterThan(0)
    })

    it('catches a write to the shared snapshot before undo replays it', () => {
      const { db, lines } = createDatabase(1)
      const line = lines[0]
      const manager = db.transactionManager
      manager.snapshotSharing = true
      manager.snapshotIntegrityProbe = new AcDbSnapshotIntegrityProbe()

      manager.startUndoMark('Move')
      const tr = manager.startTransaction()
      move(tr.getObject<AcDbLine>(line.objectId, AcDbOpenMode.kForWrite)!, 2)

      const shared = beforeSnapshotOf(tr, line.objectId)!
      manager.commitTransaction()
      manager.endUndoMark()

      // Post-commit tampering: the undo record still points at this object.
      move(shared as AcDbLine, 50)

      expect(manager.undo()).toBe(true)

      const metrics = manager.getSnapshotIntegrityMetrics()
      expect(metrics.violations).toBe(1)
      expect(metrics.lastBoundary).toBe('undo')
      expect(metrics.recentViolations[0].boundary).toBe('undo')
    })
  })
})
