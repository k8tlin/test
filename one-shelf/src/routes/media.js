'use strict'
// Uploaded images. The files live outside the static roots and can only be
// reached through this route, by an exact server-generated name.

const { z } = require('../security/validate')
const { notFound } = require('../security/errors')
const { NAME_PATTERN } = require('../storage')

const params = z.object({ name: z.string().regex(NAME_PATTERN) })

module.exports = async function mediaRoutes (app, { storage }) {
  app.get('/media/:name', async (request, reply) => {
    const parsed = params.safeParse(request.params)
    if (!parsed.success) throw notFound()
    const data = await storage.read(parsed.data.name)
    if (!data) throw notFound()
    // The type is decided here, never by the uploader. Names are random and a
    // replaced image gets a new name, so a long cache is safe.
    return reply
      .header('Content-Type', 'image/webp')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
      .send(data)
  })
}
