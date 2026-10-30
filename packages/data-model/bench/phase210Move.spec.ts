import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { AcGePoint3d } from '@mlightcad/geometry-engine'

import { AcDbObject } from '../src/base'
import { AcDbDatabase } from '../src/database/AcDbDatabase'
import { AcDbLine } from '../src/entity/AcDbLine'

/**
 * Phase 2.10 Task E1 — Node MOVE benchmark, snapshot sharing off vs on.
 *
 * This is a harness, not an assertion suite: it is skipped unless
 * `PHASE210_BENCH=1`, so `pnpm test` stays fast and deterministic. Run one size
 * per process so JIT and GC state cannot leak between sizes:
 *
 * ```powershell
 * $env:PHASE210_BENCH='1'; $env:PHASE210_SIZE='1000'
 * npx jest --config jest.config.ts --runTestsByPath packages/data-model/bench/phase210Move.spec.ts
 * ```
 *
 * The fixture is the Phase 2.6 MOVE shape translated to Node: N entities in
 * model space, one transaction, one `open → transform` pass over every entity,
 * one commit, one undo, one redo. Both arms run the same code and the same
 * order (A, B per sample) so JIT warm-up, GC drift and machine load are shared.
 *
 * Byte figures come from a harness-local structural estimator, not from the
 * kernel: it walks own enumerable properties and counts 8 bytes per primitive
 * plus 16 bytes per slot. That makes `snapshotBytesEstimated` comparable
 * between arms, which is what an A/B needs; it is not an absolute heap size.
 */

const ENABLED = process.env.PHASE210_BENCH === '1'
const SIZE = Number(process.env.PHASE210_SIZE ?? '1000')
const SAMPLES = Number(process.env.PHASE210_SAMPLES ?? '5')
const OUT_DIR =
  process.env.PHASE210_OUT ?? join(process.cwd(), 'reports', 'phase210')

/** Structural byte estimate used by the harness; see the file header. */
function estimateBytes(value: unknown, seen = new Set<unknown>()): number {
  if (value == null) return 0
  const type = typeof value
  if (type === 'number' || type === 'boolean') return 8
  if (type === 'string') return 16 + (value as string).length * 2
  if (type === 'function') return 0
  if (type !== 'object') return 0

  const object = value as object
  if (seen.has(object)) return 0
  seen.add(object)

  if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
    return (object as ArrayBufferView).byteLength ?? 0
  }
  if (typeof Blob !== 'undefined' && object instanceof Blob) return 0
  // The database is reachable from every object; counting it would explode the
  // figure and is identical in both arms.
  if ('tables' in object && 'transactionManager' in object) return 0

  let bytes = 16
  for (const key of Object.keys(object as Record<string, unknown>)) {
    bytes += 16 + estimateBytes((object as Record<string, unknown>)[key], seen)
  }
  return bytes
}

/** Median of a numeric list (input is copied, not sorted in place). */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

/** Nearest-rank p95. */
function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)
  return sorted[index]
}

/** One arm's raw sample. */
interface Sample {
  arm: 'sharingOff' | 'sharingOn'
  sample: number
  openMs: number
  transformMs: number
  commitMs: number
  undoMs: number
  redoMs: number
  totalMs: number
  rollbackSnapshotClones: number
  beforeSnapshotClones: number
  afterSnapshotClones: number
  sharedBeforeSnapshotCount: number
  copyOnWriteCount: number
  snapshotBytesEstimated: number
  retainedSnapshotBytesEstimated: number
  retainedUndoChanges: number
}

/** Builds `count` lines already in model space, outside any measurement. */
function createDocument(count: number): { db: AcDbDatabase; ids: string[] } {
  const db = new AcDbDatabase()
  const modelSpace = db.tables.blockTable.modelSpace
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const line = new AcDbLine(
      new AcGePoint3d(i, 0, 0),
      new AcGePoint3d(i, 10, 0)
    )
    modelSpace.appendEntity(line)
    ids.push(line.objectId)
  }
  return { db, ids }
}

/** Runs one MOVE round-trip and returns its raw sample. */
function runSample(
  count: number,
  sharing: boolean,
  sample: number
): Sample {
  const { db, ids } = createDocument(count)
  const manager = db.transactionManager
  manager.snapshotSharing = sharing
  manager.snapshotSizeEstimator = (snapshot: AcDbObject) =>
    estimateBytes(snapshot)
  manager.resetSnapshotSharingMetrics()

  manager.startUndoMark('Move')
  manager.startTransaction()

  const openStart = performance.now()
  const opened: AcDbLine[] = []
  for (const id of ids) {
    opened.push(db.openObjectForWrite<AcDbLine>(id)!)
  }
  const openEnd = performance.now()

  for (const line of opened) {
    line.startPoint = new AcGePoint3d(
      line.startPoint.x + 1,
      line.startPoint.y,
      0
    )
    line.endPoint = new AcGePoint3d(line.endPoint.x + 1, line.endPoint.y, 0)
  }
  const transformEnd = performance.now()

  manager.commitTransaction()
  manager.endUndoMark()
  const commitEnd = performance.now()

  const metrics = manager.getSnapshotSharingMetrics()

  const undoStart = performance.now()
  const undone = manager.undo()
  const undoEnd = performance.now()

  const redoStart = performance.now()
  const redone = manager.redo()
  const redoEnd = performance.now()

  if (!undone || !redone) {
    throw new Error(`undo/redo did not replay (${count}, sharing=${sharing})`)
  }

  return {
    arm: sharing ? 'sharingOn' : 'sharingOff',
    sample,
    openMs: openEnd - openStart,
    transformMs: transformEnd - openEnd,
    commitMs: commitEnd - transformEnd,
    undoMs: undoEnd - undoStart,
    redoMs: redoEnd - redoStart,
    totalMs: commitEnd - openStart,
    rollbackSnapshotClones: metrics.rollbackSnapshotClones,
    beforeSnapshotClones: metrics.beforeSnapshotClones,
    afterSnapshotClones: metrics.afterSnapshotClones,
    sharedBeforeSnapshotCount: metrics.sharedBeforeSnapshotCount,
    copyOnWriteCount: metrics.copyOnWriteCount,
    snapshotBytesEstimated: metrics.snapshotBytesEstimated,
    retainedSnapshotBytesEstimated: metrics.retainedSnapshotBytesEstimated,
    retainedUndoChanges: metrics.retainedUndoChanges
  }
}

/** Summarises one arm across its samples. */
function summarise(samples: Sample[]) {
  const field = (name: keyof Sample): number[] =>
    samples.map(sample => sample[name] as number)
  const stat = (name: keyof Sample) => {
    const values = field(name)
    return {
      median: median(values),
      p95: p95(values),
      min: Math.min(...values),
      max: Math.max(...values)
    }
  }
  return {
    arm: samples[0].arm,
    samples: samples.length,
    openMs: stat('openMs'),
    transformMs: stat('transformMs'),
    commitMs: stat('commitMs'),
    undoMs: stat('undoMs'),
    redoMs: stat('redoMs'),
    totalMs: stat('totalMs'),
    rollbackSnapshotClones: samples[0].rollbackSnapshotClones,
    beforeSnapshotClones: samples[0].beforeSnapshotClones,
    afterSnapshotClones: samples[0].afterSnapshotClones,
    sharedBeforeSnapshotCount: samples[0].sharedBeforeSnapshotCount,
    copyOnWriteCount: samples[0].copyOnWriteCount,
    snapshotBytesEstimated: samples[0].snapshotBytesEstimated,
    retainedSnapshotBytesEstimated:
      samples[0].retainedSnapshotBytesEstimated,
    retainedUndoChanges: samples[0].retainedUndoChanges
  }
}

;(ENABLED ? describe : describe.skip)(
  `phase 2.10 MOVE benchmark (${SIZE} entities)`,
  () => {
    jest.setTimeout(30 * 60 * 1000)

    it(`measures snapshot sharing off vs on at ${SIZE} entities`, () => {
      const samples: Sample[] = []

      for (let i = 0; i < SAMPLES; i++) {
        // Interleaved A/B: the pair shares the machine state of this instant.
        samples.push(runSample(SIZE, false, i))
        samples.push(runSample(SIZE, true, i))
      }

      const off = summarise(samples.filter(s => s.arm === 'sharingOff'))
      const on = summarise(samples.filter(s => s.arm === 'sharingOn'))
      const payload = {
        phase: '2.10',
        task: 'E1/E2 Node MOVE benchmark',
        generatedAt: new Date().toISOString(),
        runtime: {
          node: process.version,
          platform: process.platform,
          arch: process.arch
        },
        fixture: {
          kind: 'model-space lines, one transaction, one open+transform pass',
          entities: SIZE,
          samplesPerArm: SAMPLES,
          interleaved: true
        },
        arms: { sharingOff: off, sharingOn: on },
        deltas: {
          cloneCountBefore:
            off.rollbackSnapshotClones +
            off.beforeSnapshotClones +
            off.afterSnapshotClones,
          cloneCountAfter:
            on.rollbackSnapshotClones +
            on.beforeSnapshotClones +
            on.afterSnapshotClones,
          totalMsMedianRatio: on.totalMs.median / off.totalMs.median,
          openMsMedianRatio: on.openMs.median / off.openMs.median,
          retainedBytesRatio:
            off.retainedSnapshotBytesEstimated === 0
              ? null
              : on.retainedSnapshotBytesEstimated /
                off.retainedSnapshotBytesEstimated
        },
        raw: samples
      }

      const file = join(OUT_DIR, `node-move-${SIZE}.json`)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(payload, null, 2))

       
      console.log(
        `PHASE210 size=${SIZE} off(median total)=${off.totalMs.median.toFixed(1)}ms ` +
          `on(median total)=${on.totalMs.median.toFixed(1)}ms ` +
          `clones ${payload.deltas.cloneCountBefore}->${payload.deltas.cloneCountAfter} ` +
          `retainedBytes ${off.retainedSnapshotBytesEstimated}->${on.retainedSnapshotBytesEstimated}`
      )
    })
  }
)
