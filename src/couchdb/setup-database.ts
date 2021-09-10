import { asMaybe, asObject, asValue } from 'cleaners'
import nano, { DatabaseCreateParams, DocumentScope } from 'nano'

import { matchJson } from '../util/match-json'
import { ReplicatorDocument, ReplicatorEndpoint } from './replicator-document'
import { ReplicatorSetupDocument } from './replicator-setup-document'
import { SyncedDocument } from './synced-document'
import { watchDatabase } from './watch-database'

/**
 * Describes a single Couch database that should exist.
 */
export interface DatabaseSetup {
  name: string
  options?: DatabaseCreateParams

  // Documents that should exactly match:
  documents?: { [id: string]: object }

  // Servers to use for replication:
  replicatorSetup?: SyncedDocument<ReplicatorSetupDocument>

  // Documents that we should keep up-to-date:
  syncedDocuments?: Array<SyncedDocument<unknown>>

  // Documents that we should create, unless they already exist:
  templates?: { [id: string]: object }
}

export interface SetupDatabaseOptions {
  log?: (message: string) => void

  // The cluster name for the current machine.
  // This must name be present in the replication setup document,
  // or we won't be able to set up replication.
  currentCluster?: string

  // Set this to true to perform a one-time sync,
  // so synced documents will not auto-update:
  disableWatching?: boolean
}

/**
 * Ensures that the requested database exists in Couch.
 */
export async function setupDatabase(
  connectionOrUri: nano.ServerScope | string,
  setupInfo: DatabaseSetup,
  opts: SetupDatabaseOptions = {}
): Promise<void> {
  const {
    name,
    options,
    documents = {},
    replicatorSetup,
    syncedDocuments = [],
    templates = {}
  } = setupInfo
  const {
    log = console.log,
    currentCluster,
    // Don't watch the database unless there are synced documents:
    disableWatching = syncedDocuments.length === 0
  } = opts
  const connection =
    typeof connectionOrUri === 'string'
      ? nano(connectionOrUri)
      : connectionOrUri

  // Create missing databases:
  const existingDbs = await connection.db.list()
  if (!existingDbs.includes(name)) {
    await connection.db.create(name, options)
    log(`Created database "${name}"`)
  }
  const db: DocumentScope<unknown> = connection.db.use(name)

  // Update documents:
  for (const id of Object.keys(documents)) {
    const { _id, _rev, ...rest } = await db.get(id).catch(error => {
      if (asMaybeNotFound(error) == null) throw error
      return { _id: id, _rev: undefined }
    })

    if (!matchJson(documents[id], rest)) {
      await db.insert({ _id, _rev, ...documents[id] })
      log(`Wrote document "${id}" in database "${name}".`)
    }
  }

  // Create template documents:
  for (const id of Object.keys(templates)) {
    const { _id, _rev } = await db.get(id).catch(error => {
      if (asMaybeNotFound(error) == null) throw error
      return { _id: id, _rev: undefined }
    })

    if (_rev == null) {
      await db.insert({ _id, ...templates[id] })
      log(`Wrote document "${id}" in database "${name}".`)
    }
  }

  // Update or watch synced documents:
  if (disableWatching) {
    await Promise.all(syncedDocuments.map(async doc => await doc.sync(db)))
  } else {
    await watchDatabase(db, {
      syncedDocuments,
      onError(error) {
        log(`Error watching database ${name}: ${String(error)})`)
      }
    })
  }

  // Set up replication:
  if (replicatorSetup != null && currentCluster != null) {
    // Figure out the current username:
    const sessionInfo = await connection.session()
    const currentUsername: string = sessionInfo.userCtx.name

    // Helper to create replication documents on demand:
    const setupReplicator = async (): Promise<void> => {
      const { clusters } = replicatorSetup.doc

      // Bail out if the current cluster is missing from the list:
      if (clusters[currentCluster] == null) return

      function makeEndpoint(clusterName: string): ReplicatorEndpoint {
        const row = clusters[clusterName]
        const url = `${row.url.replace(/[/]$/, '')}/${name}`
        return row.basicAuth == null
          ? url
          : { url, headers: { Authorization: `Basic ${row.basicAuth}` } }
      }

      const documents: { [name: string]: ReplicatorDocument } = {}
      for (const remoteCluster of Object.keys(clusters)) {
        if (remoteCluster === currentCluster) continue
        const { mode } = clusters[remoteCluster]

        if (mode === 'source' || mode === 'both') {
          documents[`${name}.from.${remoteCluster}`] = {
            continuous: true,
            create_target: false,
            owner: currentUsername,
            source: makeEndpoint(remoteCluster),
            target: makeEndpoint(currentCluster)
          }
        }

        if (mode === 'target' || mode === 'both') {
          documents[`${name}.to-${remoteCluster}`] = {
            continuous: true,
            create_target: true,
            create_target_params: options,
            owner: currentUsername,
            source: makeEndpoint(currentCluster),
            target: makeEndpoint(remoteCluster)
          }
        }
      }
      await setupDatabase(connection, { name: '_replicator', documents }, opts)
    }

    // Subscribe to changes in the replicator setup document:
    replicatorSetup.onChange(() => {
      setupReplicator().catch(error => {
        log(`Error updating replication for ${name}: ${String(error)})`)
      })
    })
    await setupReplicator()
  }
}

const asMaybeNotFound = asMaybe(
  asObject({
    error: asValue('not_found')
  })
)
