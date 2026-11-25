'use strict'
// Structured (JSON) logging with personal data and secrets removed.

// Any object that is logged has these keys censored, one or two levels deep.
const SENSITIVE_KEYS = [
  'email', 'phone', 'customer_name', 'address_line1', 'address_line2', 'city', 'postcode',
  'delivery_notes', 'password', 'current_password', 'new_password', 'token', 'access_token',
  'csrf_token', 'csrf_secret', 'cookie', 'authorization'
]

const redactPaths = ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]']
for (const key of SENSITIVE_KEYS) redactPaths.push(key, `*.${key}`, `*.*.${key}`)

/** Remove token-like query values from a URL before it is logged. */
function scrubUrl (url) {
  return String(url).replace(/([?&](?:token|access_token|email)=)[^&#]*/gi, '$1[redacted]')
}

function loggerOptions (config, stream) {
  const options = {
    level: config.logLevel,
    redact: { paths: redactPaths, censor: '[redacted]' },
    serializers: {
      req (request) {
        return {
          method: request.method,
          url: scrubUrl(request.url),
          ip: request.ip
        }
      },
      res (reply) {
        return { statusCode: reply.statusCode }
      },
      err (err) {
        // Stack traces go to the server log only (never to the client).
        return { type: err.name, code: err.code, message: err.message, stack: err.stack }
      }
    }
  }
  if (stream) options.stream = stream
  return options
}

module.exports = { loggerOptions, scrubUrl, redactPaths }
