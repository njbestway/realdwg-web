export {
  AcDbChangeApplier,
  acdbCollectChangeEntities,
  acdbCollectDictionaryChanges
} from './AcDbChangeApplier.js'
export { AcDbChangeRecorder } from './AcDbChangeRecorder.js'
export { acdbAreChangeContainersEqual } from './AcDbDatabaseChange.js'
export type {
  AcDbChangeContainer,
  AcDbDatabaseChange
} from './AcDbDatabaseChange.js'
export type { AcDbDictionaryChangeEntry } from './AcDbChangeApplier.js'
export { AcDbDatabaseTransaction } from './AcDbDatabaseTransaction.js'
export { AcDbDatabaseTransactionManager } from './AcDbDatabaseTransactionManager.js'
export {
  AcDbSnapshotIntegrityProbe,
  acdbFingerprintSnapshot
} from './AcDbSnapshotSharingIntegrity.js'
export type {
  AcDbSnapshotIntegrityBoundary,
  AcDbSnapshotIntegrityMetrics,
  AcDbSnapshotIntegrityProbeOptions,
  AcDbSnapshotIntegrityViolation
} from './AcDbSnapshotSharingIntegrity.js'
export { acdbCreateSnapshotSharingMetrics } from './AcDbSnapshotSharingMetrics.js'
export type {
  AcDbSnapshotSharingMetrics,
  AcDbSnapshotSizeEstimator
} from './AcDbSnapshotSharingMetrics.js'
export { AcDbTransaction } from './AcDbTransaction.js'
export type { AcDbTransactionOptions } from './AcDbTransaction.js'
export { AcDbTransactionManager } from './AcDbTransactionManager.js'
export type { AcDbUndoRecord } from './AcDbUndoRecord.js'
export { AcDbUndoStack } from './AcDbUndoStack.js'
