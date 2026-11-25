'use strict'
// Some hosts (Vercel among them) run Node with require() of ES modules turned
// off. Two of our dependencies' dependencies are ES-module-only and are loaded
// with require() by CommonJS packages:
//   content-disposition  (required by @fastify/static)
//   cookie               (required by light-my-request, used by fastify.inject)
// Where plain require() refuses, load them with import() first and place the
// result in the require cache, so the later require() finds them.

const Module = require('node:module')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const TARGETS = [
  { name: 'content-disposition', from: '@fastify/static' },
  { name: 'cookie', from: 'light-my-request' }
]

function resolveFrom (name, fromPackage) {
  const fromDir = path.dirname(require.resolve(`${fromPackage}/package.json`))
  return require.resolve(name, { paths: [fromDir] })
}

async function preloadEsmDependencies () {
  for (const target of TARGETS) {
    let file
    try {
      file = resolveFrom(target.name, target.from)
    } catch {
      continue // not installed in this shape; nothing to do
    }
    if (require.cache[file]) continue
    try {
      require(file)
    } catch (err) {
      if (err.code !== 'ERR_REQUIRE_ESM') throw err
      const namespace = await import(pathToFileURL(file).href)
      const shim = new Module(file)
      shim.filename = file
      shim.paths = Module._nodeModulePaths(path.dirname(file))
      shim.exports = { ...namespace }
      shim.loaded = true
      require.cache[file] = shim
    }
  }
}

module.exports = { preloadEsmDependencies }
