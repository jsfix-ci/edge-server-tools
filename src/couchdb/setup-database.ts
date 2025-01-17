import nano, { DatabaseCreateParams, DocumentScope } from 'nano'

import { matchJson } from '../util/match-json'
import {
  asMaybeExistsError,
  asMaybeNotFoundError
} from './couch-error-cleaners'
import { ReplicatorDocument, ReplicatorEndpoint } from './replicator-document'
import { ReplicatorSetupDocument } from './replicator-setup-document'
import { SyncedDocument } from './synced-document'
import { watchDatabase, WatchDatabaseOptions } from './watch-database'

/**
 * Describes a single Couch database that should exist.
 */
export interface DatabaseSetup
  extends Pick<WatchDatabaseOptions, 'onChange' | 'syncedDocuments'> {
  // The database name:
  name: string

  // Options to pass to CouchDB when creating this database:
  options?: DatabaseCreateParams

  // Documents that should exactly match:
  documents?: { [id: string]: object }

  // Documents that we should create, unless they already exist:
  templates?: { [id: string]: object }

  // Do not create the database if it is missing.
  // This also disables replication,
  // since the database might be missing on the remote side:
  ignoreMissing?: boolean

  // Deprecated. Put this in the options instead:
  replicatorSetup?: SyncedDocument<ReplicatorSetupDocument>
}

export interface SetupDatabaseOptions {
  // The couch cluster name the current client is connected to,
  // to enable replicating to or from this instance.
  currentCluster?: string

  // Servers to use for replication:
  replicatorSetup?: SyncedDocument<ReplicatorSetupDocument>

  // The setup routine will subscribe to the changes feed if
  // the setup includes an `onChange` callback or synced documents.
  // This option disables watching, performing a one-time sync instead.
  disableWatching?: boolean

  // Logs status messages whenever we write things to Couch:
  log?: (message: string) => void

  // Logs error messages whenever something goes wrong:
  onError?: (error: unknown) => void
}

/**
 * Ensures that the requested database exists in Couch.
 * Returns a cleanup function, which removes any background tasks.
 */
export async function setupDatabase(
  connectionOrUri: nano.ServerScope | string,
  setupInfo: DatabaseSetup,
  opts: SetupDatabaseOptions = {}
): Promise<() => void> {
  const cleanups: Array<() => void> = []
  const {
    documents = {},
    ignoreMissing = false,
    name,
    onChange,
    options,
    syncedDocuments = [],
    templates = {}
  } = setupInfo
  const {
    currentCluster,
    replicatorSetup = setupInfo.replicatorSetup,
    disableWatching = false,
    log = console.log,
    onError = error => {
      log(`Error while maintaining database "${name}": ${String(error)})`)
    }
  } = opts
  const connection =
    typeof connectionOrUri === 'string'
      ? nano(connectionOrUri)
      : connectionOrUri

  // Create missing databases:
  const existingInfo = await connection.db.get(name).catch(error => {
    if (asMaybeNotFoundError(error) == null) throw error
  })
  if (existingInfo == null) {
    if (ignoreMissing) return () => {}
    await connection.db.create(name, options).catch(error => {
      if (asMaybeExistsError(error) == null) throw error
    })
    log(`Created database "${name}"`)
  }
  const db: DocumentScope<unknown> = connection.db.use(name)

  // Update documents:
  for (const id of Object.keys(documents)) {
    const { _id, _rev, ...rest } = await db.get(id).catch(error => {
      if (asMaybeNotFoundError(error) == null) throw error
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
      if (asMaybeNotFoundError(error) == null) throw error
      return { _id: id, _rev: undefined }
    })

    if (_rev == null) {
      await db.insert({ _id, ...templates[id] })
      log(`Wrote document "${id}" in database "${name}".`)
    }
  }

  // Update or watch synced documents:
  const canWatch = onChange != null || syncedDocuments.length > 0
  if (canWatch && !disableWatching) {
    cleanups.push(
      await watchDatabase(db, { onChange, onError, syncedDocuments })
    )
  } else {
    await Promise.all(syncedDocuments.map(async doc => await doc.sync(db)))
  }

  // Set up replication.
  if (replicatorSetup != null && currentCluster != null && !ignoreMissing) {
    // Figure out the current username:
    const sessionInfo = await connection.session()
    const currentUsername: string = sessionInfo.userCtx.name

    // Helper to create replication documents on demand:
    const setupReplicator = async (): Promise<void> => {
      const { clusters } = replicatorSetup.doc

      // Bail out if the current cluster is missing from the list:
      const current = clusters[currentCluster]
      if (current == null) return

      // Who do we replicate with?
      const {
        exclude: localExclude = [],
        include: localInclude = ['*'],
        pullFrom = Object.keys(clusters).filter(name => {
          const { mode } = clusters[name]
          return mode === 'both' || mode === 'source'
        }),
        pushTo = Object.keys(clusters).filter(name => {
          const { mode } = clusters[name]
          return mode === 'both' || mode === 'target'
        })
      } = current

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
        const { exclude: remoteExclude = [], include: remoteInclude = ['*'] } =
          clusters[remoteCluster]

        if (!includesName(localInclude, name)) continue
        if (!includesName(remoteInclude, name)) continue
        if (includesName(localExclude, name)) continue
        if (includesName(remoteExclude, name)) continue

        if (includesName(pullFrom, remoteCluster)) {
          documents[`${name}.from.${remoteCluster}`] = {
            continuous: true,
            create_target: false,
            owner: currentUsername,
            source: makeEndpoint(remoteCluster),
            target: makeEndpoint(currentCluster)
          }
        }

        if (includesName(pushTo, remoteCluster)) {
          documents[`${name}.to.${remoteCluster}`] = {
            continuous: true,
            create_target: true,
            create_target_params: options,
            owner: currentUsername,
            source: makeEndpoint(currentCluster),
            target: makeEndpoint(remoteCluster)
          }
        }
      }
      await setupDatabase(
        connection,
        { name: '_replicator', documents },
        { ...opts, replicatorSetup: undefined }
      )
    }

    // Subscribe to changes in the replicator setup document:
    cleanups.push(
      replicatorSetup.onChange(() => {
        setupReplicator().catch(onError)
      })
    )
    await setupReplicator()
  }

  return () => cleanups.forEach(cleanup => cleanup())
}

/**
 * Returns true if a list includes a name.
 * If a list row ends with '*', treat that like a wildcard.
 */
function includesName(list: string[], name: string): boolean {
  const found = list.find(
    row =>
      row === (/\*$/.test(row) ? name.slice(0, row.length - 1) + '*' : name)
  )
  return found != null
}
