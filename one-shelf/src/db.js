'use strict'
// The only place a database connection is created. All SQL lives in this file
// and in src/repo/*.js, always as fixed strings with placeholders; request data
// is only ever passed as bound parameters (test/sql-safety.test.js enforces this).

const fs = require('node:fs')
const path = require('node:path')

// node:sqlite prints "ExperimentalWarning: SQLite is an experimental feature".
// Silence exactly that one warning while the module loads, and nothing else.
function loadSqlite () {
  const original = process.emitWarning
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === 'string' ? warning : (warning && warning.message) || ''
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] && rest[0].type) || (warning && warning.name)
    if (type === 'ExperimentalWarning' && /SQLite/i.test(text)) return
    return original.call(process, warning, ...rest)
  }
  try {
    return require('node:sqlite')
  } finally {
    process.emitWarning = original
  }
}
const { DatabaseSync } = loadSqlite()

const SCHEMA_PATH = path.join(__dirname, 'schema.sql')

class Db {
  constructor (filename) {
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true })
    this.raw = new DatabaseSync(filename)
    this.raw.exec('PRAGMA journal_mode = WAL')
    this.raw.exec('PRAGMA foreign_keys = ON')
    this.raw.exec('PRAGMA busy_timeout = 5000')
    this.raw.exec('PRAGMA synchronous = NORMAL')
    this.raw.exec(fs.readFileSync(SCHEMA_PATH, 'utf8'))
    this.statements = new Map()
    this.depth = 0
  }

  /** Prepared statement, cached by its (fixed) SQL text. */
  stmt (sql) {
    let s = this.statements.get(sql)
    if (!s) {
      s = this.raw.prepare(sql)
      this.statements.set(sql, s)
    }
    return s
  }

  get (sql, params = {}) { return this.stmt(sql).get(params) }
  all (sql, params = {}) { return this.stmt(sql).all(params) }
  /** @returns {{ changes: number, lastInsertRowid: number }} */
  run (sql, params = {}) {
    const r = this.stmt(sql).run(params)
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
  }

  /**
   * Run fn inside a write transaction. node:sqlite is synchronous, so fn must
   * be synchronous too; nothing else can interleave with it in this process,
   * and BEGIN IMMEDIATE keeps other processes out.
   */
  tx (fn) {
    if (this.depth > 0) return fn()
    this.raw.exec('BEGIN IMMEDIATE')
    this.depth++
    try {
      const result = fn()
      if (result && typeof result.then === 'function') throw new Error('Db.tx callback must be synchronous')
      this.raw.exec('COMMIT')
      return result
    } catch (err) {
      this.raw.exec('ROLLBACK')
      throw err
    } finally {
      this.depth--
    }
  }

  close () {
    this.statements.clear()
    try { this.raw.close() } catch { /* already closed */ }
  }
}

function openDb (filename) {
  return new Db(filename)
}

const nowIso = () => new Date().toISOString()

module.exports = { openDb, nowIso }
