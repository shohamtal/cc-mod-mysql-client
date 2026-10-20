export type SqlResult = {
  id: number
  server: string
  database: string
  sql: string
  columns: string[]
  rows: string[][]
  ms: number
  error?: string
  limited?: boolean
  at: string
}

export type SqlView = {
  expanded: number[]
  top: number
  cursor: number
  left: number
  search: string
  match: number
}

export type SqlServer = { id: string; name: string; host: string; tag?: 'production' | 'staging' | 'development' | 'local'; databases: string[] }

// A write the person must approve: exactly this statement, on this server entry and database.
export type SqlWritePrompt = { kind: 'write'; serverId: string; serverName: string; target: string; fingerprint: string; database: string; sql: string; verb: string; noWhere: boolean; production: boolean; shownFrom: number }
export type SqlTrustPrompt = { kind: 'trust'; serverId: string; serverName: string; target: string; source: string; fingerprint: string; then: 'run' | 'schema'; sql: string; database: string; mode: 'read' | 'write' }
export type SqlConfirm = SqlWritePrompt | SqlTrustPrompt
// A session unlock holds for one server entry exactly as it was.
export type SqlUnlock = { id: string; fingerprint: string }

export type SqlSchema = { dbs: string[]; tables: Record<string, string[]>; cols: Record<string, string[]> }

declare module 'claude-code' {
  interface PluginState {
    'sql-console': {
      query: string
      rev: number
      cursorRow: number
      result: SqlResult | null
      view: SqlView
      running: boolean
      server: string
      database: string
      servers: SqlServer[]
      showHelp: boolean
      paste: { id: number; text: string } | null
      schema: Record<string, SqlSchema>
      schemaLoading: string
      paths: { file: string; config: string } | null
      editorScroll: { id: number; by: number } | null
      menuOpen: string
      editorCmd: { id: number; cmd: 'undo' | 'redo' } | null
      confirm: SqlConfirm | null
      unlocked: SqlUnlock[]
      prodSeen: string[]
    }
  }
}
