'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { checkSource, checkProject } = require('./helpers/sql-check')
const { makeApp, ORIGIN } = require('./helpers/app')

test('no SQL in src/ or scripts/ is built by interpolation or concatenation', () => {
  const { files, problems } = checkProject(path.join(__dirname, '..'))
  assert.ok(files > 20, 'the check actually looked at the source tree')
  assert.deepEqual(problems, [])
})

test('the SQL check catches the patterns it is meant to catch', () => {
  const bad = {
    'src/repo/x.js': [
      'db.all(`SELECT * FROM products WHERE slug = \'${slug}\'`)',
      "db.get('SELECT * FROM products WHERE slug = ' + slug)",
      "db.get('SELECT * FROM products ORDER BY ' + sortColumn + ' ASC')",
      "db.run(prefix + ' WHERE id = :id', { id })",
      'db.all(sql, params)',
      'db.all(buildQuery(filters))',
      "db.all(['SELECT * FROM products', where].join(' '))",
      "db.all('SELECT * FROM products WHERE ' + filters.map(f => f.sql))",
      "db.all('SELECT * FROM t ORDER BY ' + request.query.sort)",
      "db.all(SELECT_BASE + request.query.sort)".replace('SELECT_BASE + request', "SELECT_BASE + ' ' + request")
    ],
    'src/routes/x.js': [
      "app.db.raw.exec('DELETE FROM orders')",
      "const rows = db.all('SELECT * FROM orders')",
      'const q = `SELECT * FROM orders WHERE email = ${email}`',
      "const { DatabaseSync } = require('node:sqlite')",
      "db.raw.prepare('SELECT 1').get()",
      "const sql = 'UPDATE products SET stock = 0'"
    ]
  }
  for (const [file, snippets] of Object.entries(bad)) {
    for (const snippet of snippets) {
      assert.notEqual(checkSource(file, snippet).length, 0, `should be flagged in ${file}: ${snippet}`)
    }
  }
  const good = [
    "db.get('SELECT * FROM products WHERE slug = :slug', { slug })",
    'db.all(PRODUCT_SELECT + `\n  WHERE p.status = :status`, { status })',
    "db.run('UPDATE products SET stock = stock - :qty WHERE id = :id AND stock >= :qty', { id, qty })"
  ]
  for (const snippet of good) assert.deepEqual(checkSource('src/repo/x.js', snippet), [], snippet)
})

test('hostile input is treated as data, not SQL', async () => {
  const app = await makeApp()
  try {
    const attacks = ["' OR '1'='1", "'; DROP TABLE products; --", '" OR ""="', "%' UNION SELECT password_hash FROM admin_users --", 'x\\']
    for (const attack of attacks) {
      const res = await app.inject({ method: 'GET', url: '/api/products?q=' + encodeURIComponent(attack) })
      assert.equal(res.statusCode, 200, attack)
      assert.equal(res.json().count, 0, attack)
      const login = await app.inject({ method: 'POST', url: '/api/admin/login', headers: { origin: ORIGIN }, payload: { email: 'a@example.com', password: attack } })
      assert.equal(login.statusCode, 401)
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/products' })).json().count, 24, 'the products table is intact')
    const sub = await app.inject({ method: 'POST', url: '/api/subscribe', headers: { origin: ORIGIN }, payload: { email: "o'brien@example.com", consent: true } })
    assert.equal(sub.statusCode, 202)
    assert.equal(app.repo.subscribers.get("o'brien@example.com").status, 'pending')
  } finally {
    await app.close()
  }
})
