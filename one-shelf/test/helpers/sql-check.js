'use strict'
// A deliberately strict, text-based check that SQL is only ever written as
// fixed strings with placeholders. It is not a parser; it works because the
// codebase follows simple rules that are easy to verify:
//
//   1. Only src/db.js touches node:sqlite (DatabaseSync, .prepare).
//   2. Only src/db.js and src/repo/*.js run statements (db.get/all/run/stmt).
//   3. Inside those files there is no template interpolation (${...}) at all,
//      and a string may only be joined (+) to another literal or to an
//      UPPER_CASE module constant.
//   4. The SQL argument of db.get/all/run starts with a literal or such a constant.
//   5. No other file under src/ contains SQL statement text.

const fs = require('node:fs')
const path = require('node:path')

const SQL_TEXT = /\b(SELECT\s[^;\n]*\sFROM\s|INSERT\s+(OR\s+\w+\s+)?INTO\s|UPDATE\s+\w+\s+SET\s|DELETE\s+FROM\s|DROP\s+TABLE|ALTER\s+TABLE|PRAGMA\s+\w+)/i

function stripComments (source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/([^:'"`\\])\/\/[^'"`\n]*$/gm, '$1')
}

/**
 * @param {string} file     path used in messages, relative to the project root with forward slashes
 * @param {string} source   file contents
 * @returns {string[]}      list of problems (empty when clean)
 */
function checkSource (file, source) {
  const problems = []
  const code = stripComments(source)
  const lines = code.split('\n')
  const isDbModule = file === 'src/db.js'
  const isRepo = /^src\/repo\/[^/]+\.js$/.test(file)
  const at = (i) => `${file}:${i + 1}`

  lines.forEach((line, i) => {
    if (!isDbModule && /\bDatabaseSync\b|node:sqlite|\.prepare\s*\(/.test(line)) {
      problems.push(`${at(i)} uses the SQLite driver directly; all database access goes through src/db.js`)
    }
    if (!isDbModule && !isRepo && /\bdb\.(get|all|run|stmt)\s*\(|\.raw\.exec\s*\(/.test(line)) {
      problems.push(`${at(i)} runs a statement outside src/repo/`)
    }
    if (!isDbModule && !isRepo && SQL_TEXT.test(line)) {
      problems.push(`${at(i)} contains SQL text outside src/db.js and src/repo/`)
    }
  })

  if (isDbModule || isRepo) {
    lines.forEach((line, i) => {
      if (line.includes('${')) problems.push(`${at(i)} uses template interpolation in a database module`)
      // literal + something-that-is-not-a-literal-or-CONSTANT
      if (/['"`]\s*\+\s*(?!['"`]|[A-Z][A-Z0-9_]*\b(?!\s*[.([]))/.test(line)) problems.push(`${at(i)} concatenates a string with a non-constant value`)
      // something-that-is-not-a-literal-or-CONSTANT + literal
      const m = /([A-Za-z0-9_$\])]+)\s*\+\s*['"`]/.exec(line)
      if (m && !/^[A-Z][A-Z0-9_]*$/.test(m[1])) problems.push(`${at(i)} concatenates a non-constant value with a string`)
      if (/\.(concat|join|replace|replaceAll|format)\s*\(/.test(line) || /\bString\.raw\b|util\.format/.test(line)) {
        problems.push(`${at(i)} builds a string dynamically in a database module`)
      }
    })
    // The SQL argument must be a literal or CONSTANT (optionally + literal).
    const call = /\bdb\.(get|all|run|stmt)\s*\(\s*([^\s])([A-Za-z0-9_]*)/g
    let m
    while ((m = call.exec(code))) {
      const first = m[2]
      const word = first + m[3]
      const ok = first === "'" || first === '`' || first === '"' || /^[A-Z][A-Z0-9_]*$/.test(word)
      if (!ok) {
        const lineNo = code.slice(0, m.index).split('\n').length
        problems.push(`${file}:${lineNo} passes a non-literal as SQL to db.${m[1]}()`)
      }
    }
    if (isDbModule) {
      const exec = /\.raw\.(exec|prepare)\s*\(\s*([^)]*)\)/g
      while ((m = exec.exec(code))) {
        const arg = m[2].trim()
        const ok = /^'[^']*'$/.test(arg) || arg === 'sql' || arg === "fs.readFileSync(SCHEMA_PATH, 'utf8'"
        if (!ok) problems.push(`${file} calls raw.${m[1]}() with an unexpected argument: ${arg}`)
      }
    }
  }
  return problems
}

function listJsFiles (dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listJsFiles(full))
    else if (/\.(js|cjs|mjs)$/.test(entry.name)) out.push(full)
  }
  return out
}

function checkProject (root) {
  const problems = []
  const files = [...listJsFiles(path.join(root, 'src')), ...listJsFiles(path.join(root, 'scripts'))]
  for (const full of files) {
    const rel = path.relative(root, full).split(path.sep).join('/')
    problems.push(...checkSource(rel, fs.readFileSync(full, 'utf8')))
  }
  return { files: files.length, problems }
}

module.exports = { checkSource, checkProject }
