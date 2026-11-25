'use strict'
// Vercel entry point: PREVIEW DEPLOYMENTS ONLY. See src/preview.js and the README.

const { applyVercelEnv, preparePreview } = require('../src/preview')
applyVercelEnv()

let starting = null
let lastCrash = null
// Keep one bad request from taking the whole instance down, and remember why.
process.on('uncaughtException', (err) => { lastCrash = err; console.error('uncaughtException', err) })
process.on('unhandledRejection', (err) => { lastCrash = err; console.error('unhandledRejection', err) })

async function start () {
  const { buildApp } = require('../src/server')
  const app = await buildApp()
  await preparePreview(app)
  await app.ready()
  return app
}

module.exports = async function handler (req, res) {
  try {
    if (!starting) starting = start()
    const app = await starting
    app.server.emit('request', req, res)
  } catch (err) {
    starting = null
    console.error(err)
    if (res.headersSent) return res.end()
    res.statusCode = 500
    res.setHeader('content-type', 'text/plain; charset=utf-8')
    // This is a preview deployment, so say what went wrong instead of a blank failure.
    const detail = err && (err.name === 'ConfigError' ? err.message : `${err.name || 'Error'}: ${err.message}`)
    res.end(`One Shelf could not start on this preview.\n\n${detail || 'Unknown error'}\n\nNode ${process.version}${lastCrash ? `\nEarlier: ${lastCrash.message}` : ''}`)
  }
}
