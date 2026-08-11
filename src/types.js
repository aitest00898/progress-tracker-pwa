/** @typedef {'active'|'completed'|'skipped'} ItemStatus */
/** @typedef {'none'|'low'|'medium'|'high'} Priority */
/** @typedef {'explicit'|'inherit'|'none'} DueMode */
/** @typedef {string} Tag */

/** @typedef {Object} RevisionMetadata
 * @property {number} revision
 * @property {number} baseRevision
 * @property {Record<string, number>} fieldRevisions
 */

/** @typedef {Object} Category
 * @property {string} id
 * @property {string} title
 * @property {number} order
 * @property {number} revision
 * @property {number} baseRevision
 * @property {Record<string, number>} fieldRevisions
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/** @typedef {Object} Item
 * @property {string} id
 * @property {string} categoryId
 * @property {string|null} parentId
 * @property {string} title
 * @property {ItemStatus} status
 * @property {number} activeOrder
 * @property {number} completedOrder
 * @property {Priority} priority
 * @property {0|1|2|3} importance
 * @property {string|null} plannedStart
 * @property {DueMode} dueMode
 * @property {string|null} dueDate
 * @property {string} notes
 * @property {Tag[]} tags
 * @property {string|null} createdAt
 * @property {string|null} firstCompletedAt
 * @property {string|null} completedAt
 * @property {string|null} reopenedAt
 * @property {number|null} reopenOrder
 * @property {number} revision
 * @property {number} baseRevision
 * @property {Record<string, number>} fieldRevisions
 * @property {string} updatedAt
 */

/** @typedef {Object} Reminder
 * @property {string} id
 * @property {string} itemId
 * @property {'absolute'|'relative'} type
 * @property {number} offsetDays
 * @property {string} time
 * @property {string|null} at
 * @property {boolean} enabled
 * @property {boolean} keepAfterComplete
 * @property {boolean} suspendedByCompletion
 * @property {string|null} snoozedUntil
 * @property {string|null} suppressedDay
 * @property {string|null} lastTriggeredAt
 * @property {number} revision
 * @property {number} baseRevision
 * @property {Record<string, number>} fieldRevisions
 * @property {string} createdAt
 * @property {string} updatedAt
 */

/** @typedef {Object} ActivityHistoryEntry
 * @property {string} id
 * @property {string|null} itemId
 * @property {string} type
 * @property {Record<string, unknown>} metadata
 * @property {string} at
 */

/** @typedef {Object} TodayMembership
 * @property {string} itemId
 * @property {number} order
 * @property {string} addedAt
 * @property {'manual'|'planned'} source
 * @property {string|null} completedAt
 * @property {number} revision
 * @property {number} baseRevision
 * @property {Record<string, number>} fieldRevisions
 */

/** @typedef {Object} TodayState
 * @property {string} lastRolloverDate
 * @property {Record<string, TodayMembership>} items
 */

/** @typedef {Object} SyncState
 * @property {boolean} enabled
 * @property {boolean} authorized
 * @property {string} status
 * @property {string} clientId
 * @property {string|null} accountId
 * @property {string|null} fileId
 * @property {string|null} selectedDatasetId
 * @property {Record<string, unknown>} datasetFiles
 * @property {unknown[]} availableDatasets
 * @property {string|null} backupFolderId
 * @property {unknown[]} visibleBackups
 * @property {string|null} lastSyncAt
 */

/** @typedef {Object} Settings
 * @property {string} language
 * @property {string} theme
 * @property {string} defaultPage
 * @property {string|null} defaultCategoryId
 * @property {string} defaultSmartView
 * @property {boolean} smartSort
 * @property {boolean} showCompleted
 * @property {boolean} overdueExpanded
 * @property {boolean} developerEnabled
 * @property {{enabled:boolean,smart:boolean,routine:boolean,reminderLearning:boolean}} experimental
 * @property {string} defaultReminderTime
 * @property {SyncState} cloudSync
 * @property {Record<string, string>} focusByCategory
 * @property {Record<string, string[]>} expandedByCategory
 * @property {Record<string, string[]>} smartOrders
 * @property {Record<string, boolean>} firstHints
 */

/** @typedef {Object} SyncChange
 * @property {string} id
 * @property {string} label
 * @property {string[]} itemIds
 * @property {string[]} entityKeys
 * @property {number} revision
 * @property {string} at
 */

/** @typedef {Object} SyncConflict
 * @property {string} id
 * @property {string} entityType
 * @property {string} entityId
 * @property {string|null} itemId
 * @property {string} type
 * @property {string|null} field
 * @property {unknown} baseState
 * @property {unknown} localState
 * @property {unknown} remoteState
 * @property {unknown} group
 */

/** @typedef {Object} ConflictArchiveEntry
 * @property {string} id
 * @property {string|null} conflictId
 * @property {string|null} itemId
 * @property {string} entityType
 * @property {string} entityId
 * @property {string|null} field
 * @property {string} type
 * @property {'local'|'remote'} chosenState
 * @property {unknown} baseState
 * @property {unknown} rejectedState
 * @property {string[]} restoreFields
 * @property {number} baseRevision
 * @property {string} resolvedAt
 * @property {string} purgeAfter
 * @property {string|null} restoredAt
 * @property {number} restoreCount
 * @property {number|null} latestRestoreRevision
 */

/** @typedef {Object} BackupMeta
 * @property {string} id
 * @property {string} scope
 * @property {string} format
 * @property {string} createdAt
 * @property {boolean} independentlyRestorable
 * @property {number} bytes
 */

/** @typedef {Object} MigrationSnapshot
 * @property {string} id
 * @property {string} kind
 * @property {number} fromVersion
 * @property {number} toVersion
 * @property {string} createdAt
 * @property {string} purgeAfter
 * @property {AppState} state
 */

/** @typedef {Object} DiagnosticsState
 * @property {Array<{id?:string,type?:string,metadata?:Record<string, unknown>,at:string}>} events
 * @property {Array<Record<string, unknown>>} errors
 * @property {Record<string, {count:number,firstAt:string,lastAt:string}>} aggregates
 * @property {unknown|null} lastSession
 */

/** @typedef {Object} AppState
 * @property {{schemaVersion:number,appVersion:string,datasetId:string,revision:number,baseRevision:number,clientId:string,accountId:string|null,createdAt:string,updatedAt:string,lastRolloverDate:string,recoveryMode:boolean,recoveryContext:unknown,lastSession:unknown} } meta
 * @property {Category[]} categories
 * @property {Item[]} items
 * @property {ActivityHistoryEntry[]} history
 * @property {Reminder[]} reminders
 * @property {TodayState} today
 * @property {Settings} settings
 * @property {Record<string,string[]>} smartOrders
 * @property {SyncChange[]} syncChanges
 * @property {SyncConflict[]} conflicts
 * @property {ConflictArchiveEntry[]} conflictArchive
 * @property {DeletedEntry[]} deleted
 * @property {BackupMeta[]} backupMeta
 * @property {MigrationSnapshot[]} migrationSnapshots
 * @property {MigrationSnapshot[]} recoverySnapshots
 * @property {DiagnosticsState} diagnostics
 * @property {unknown[]} performance
 * @property {Record<string, unknown>} capabilities
 */

/** @typedef {Object} DeletedEntry
 * @property {string} id
 * @property {string} kind
 * @property {string|null} categoryId
 * @property {{category?:Category,items:Item[],history?:ActivityHistoryEntry[],reminders?:Reminder[],today?:Record<string,TodayMembership>}} snapshot
 * @property {string} deletedAt
 * @property {string} purgeAfter
 */

/** @typedef {Object} PTMDItemNode
 * @property {string|null} id
 * @property {string} title
 * @property {string} status
 * @property {number} depth
 * @property {string} sourceKey
 * @property {string|null} parentSourceKey
 * @property {string|null} parentId
 * @property {Record<string, unknown>} metadata
 * @property {string} notes
 */

/** @typedef {Object} PTMDCategory
 * @property {string|null} id
 * @property {string} title
 * @property {number} order
 * @property {PTMDItemNode[]} items
 */

/** @typedef {Object} PTMDParseResult
 * @property {boolean} ok
 * @property {number} [version]
 * @property {string} [scope]
 * @property {PTMDCategory[]} [categories]
 * @property {AppState|null} [backupState]
 * @property {string[]} [warnings]
 * @property {string} [reason]
 */

export {};
