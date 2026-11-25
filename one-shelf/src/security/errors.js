'use strict'
// One error shape for the whole API: { error: { code, message, fields? } }.
// 5xx responses never include stack traces, SQL or internal messages.

class AppError extends Error {
  /**
   * @param {number} statusCode
   * @param {string} code      machine-readable, snake_case
   * @param {string} message   safe to show to the person using the site
   * @param {object} [fields]  per-field messages, keyed by dotted path (e.g. "customer.email")
   */
  constructor (statusCode, code, message, fields) {
    super(message)
    this.name = 'AppError'
    this.statusCode = statusCode
    this.code = code
    this.fields = fields
    this.expose = true
  }
}

const notFound = (message = 'Not found') => new AppError(404, 'not_found', message)

function body (code, message, fields) {
  const error = { code, message }
  if (fields && Object.keys(fields).length) error.fields = fields
  return { error }
}

// Errors raised by Fastify itself and its plugins, mapped to our codes.
const FRAMEWORK_ERRORS = {
  FST_ERR_CTP_INVALID_MEDIA_TYPE: [415, 'unsupported_media_type', 'Unsupported content type.'],
  FST_ERR_CTP_BODY_TOO_LARGE: [413, 'payload_too_large', 'The request is too large.'],
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: [400, 'bad_request', 'The request could not be read.'],
  FST_ERR_CTP_EMPTY_JSON_BODY: [400, 'bad_request', 'The request body is empty.'],
  FST_ERR_CTP_INVALID_JSON_BODY: [400, 'bad_request', 'The request body is not valid JSON.'],
  FST_CSRF_MISSING_SECRET: [403, 'csrf_invalid', 'Your session security token is missing or out of date. Reload the page and try again.'],
  FST_CSRF_INVALID_TOKEN: [403, 'csrf_invalid', 'Your session security token is missing or out of date. Reload the page and try again.'],
  FST_REQ_FILE_TOO_LARGE: [413, 'file_too_large', 'The file is too large. The limit is 5 MB.'],
  FST_FILES_LIMIT: [400, 'bad_request', 'Upload one file at a time.'],
  FST_PARTS_LIMIT: [400, 'bad_request', 'Upload one file at a time.'],
  FST_FIELDS_LIMIT: [400, 'bad_request', 'Too many form fields.'],
  FST_INVALID_MULTIPART_CONTENT_TYPE: [415, 'unsupported_media_type', 'Send the image as multipart/form-data.']
}

function errorHandler (err, request, reply) {
  if (err instanceof AppError) {
    if (err.headers) reply.headers(err.headers)
    return reply.code(err.statusCode).send(body(err.code, err.message, err.fields))
  }
  const mapped = err && FRAMEWORK_ERRORS[err.code]
  if (mapped) return reply.code(mapped[0]).send(body(mapped[1], mapped[2]))
  if (err instanceof SyntaxError && err.statusCode === 400) {
    return reply.code(400).send(body('bad_request', 'The request body is not valid JSON.'))
  }
  const status = err && Number.isInteger(err.statusCode) ? err.statusCode : 500
  if (status >= 400 && status < 500) {
    // Unknown client error from a plugin: keep the status, use a generic message.
    return reply.code(status).send(body(status === 404 ? 'not_found' : 'bad_request',
      status === 404 ? 'Not found' : 'The request could not be processed.'))
  }
  // Full detail goes to the server log only.
  request.log.error({ err }, 'unhandled error')
  return reply.code(500).send(body('internal_error', 'Something went wrong on our side. Please try again.'))
}

function notFoundHandler (request, reply) {
  reply.code(404).send(body('not_found', 'Not found'))
}

module.exports = { AppError, notFound, errorHandler, notFoundHandler, errorBody: body }
