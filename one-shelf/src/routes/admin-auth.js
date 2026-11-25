'use strict'
// Admin sign-in, sign-out, "who am I" (which also hands out the CSRF token)
// and password change.

const v = require('../security/validate')
const { z, parse } = v
const { AppError } = require('../security/errors')
const { hashPassword, verifyPassword, verifyDummy, passwordProblem } = require('../security/passwords')

const loginBody = z.object({
  email: v.email,
  password: z.string({ error: 'Enter your password' }).min(1, 'Enter your password').max(200, 'Enter your password')
})
const passwordBody = z.object({
  current_password: z.string({ error: 'Enter your current password' }).min(1, 'Enter your current password').max(200),
  new_password: z.string({ error: 'Enter a new password' }).min(1, 'Enter a new password').max(200, 'Use at most 200 characters')
})

const INVALID_LOGIN = 'Invalid email or password'

/** Routes that do not need a session. */
async function adminLoginRoutes (app, { repo, sessions, rateLimits }) {
  app.post('/api/admin/login', { config: { rateLimit: rateLimits.login } }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    // Every failure (bad shape, unknown email, wrong password, disabled user)
    // gives the same answer, and takes about the same time.
    const parsed = loginBody.safeParse(request.body ?? {})
    if (!parsed.success) {
      await verifyDummy('x')
      throw new AppError(401, 'invalid_credentials', INVALID_LOGIN)
    }
    const admin = repo.admin.getAdminByEmail(parsed.data.email)
    const ok = admin ? await verifyPassword(parsed.data.password, admin.password_hash) : await verifyDummy(parsed.data.password)
    if (!admin || !ok || admin.disabled) {
      request.log.warn('failed admin sign-in')
      throw new AppError(401, 'invalid_credentials', INVALID_LOGIN)
    }
    // Regenerate: drop whatever session the browser presented, then issue a new id.
    sessions.destroy(request, reply)
    const session = sessions.create(reply, admin.id)
    repo.admin.touchLogin(admin.id)
    repo.admin.audit(admin.id, 'admin.login', 'admin_user', admin.id, null, null)
    request.session = { adminId: admin.id, email: admin.email, _csrf: session.csrfSecret }
    return { admin: { id: admin.id, email: admin.email }, csrf_token: reply.generateCsrf() }
  })
}

/** Routes inside the protected admin scope. */
async function adminAccountRoutes (app, { repo, sessions, rateLimits }) {
  app.get('/api/admin/me', async (request, reply) => {
    const admin = repo.admin.getAdmin(request.session.adminId)
    return {
      admin: { id: admin.id, email: admin.email, last_login_at: admin.last_login_at },
      csrf_token: reply.generateCsrf(),
      session: { idle_timeout_minutes: 30, absolute_timeout_hours: 12, started_at: request.session.createdAt }
    }
  })

  app.post('/api/admin/logout', async (request, reply) => {
    repo.admin.audit(request.session.adminId, 'admin.logout', 'admin_user', request.session.adminId, null, null)
    sessions.destroy(request, reply)
    return { ok: true }
  })

  app.post('/api/admin/password', { config: { rateLimit: rateLimits.password } }, async (request, reply) => {
    const body = parse(passwordBody, request.body)
    const admin = repo.admin.getAdmin(request.session.adminId)
    if (!(await verifyPassword(body.current_password, admin.password_hash))) {
      throw new AppError(422, 'validation_error', 'Please check the highlighted fields.', { current_password: 'That is not your current password' })
    }
    const problem = passwordProblem(body.new_password, admin.email)
    if (problem) throw new AppError(422, 'validation_error', 'Please check the highlighted fields.', { new_password: problem })
    if (body.new_password === body.current_password) {
      throw new AppError(422, 'validation_error', 'Please check the highlighted fields.', { new_password: 'Choose a password you have not just used' })
    }
    repo.admin.setPassword(admin.id, await hashPassword(body.new_password))
    // Sign out everywhere, then start a fresh session for this browser.
    repo.admin.deleteSessionsForAdmin(admin.id)
    const session = sessions.create(reply, admin.id)
    repo.admin.audit(admin.id, 'admin.password_changed', 'admin_user', admin.id, null, null)
    request.session = { adminId: admin.id, email: admin.email, _csrf: session.csrfSecret }
    return { ok: true, csrf_token: reply.generateCsrf() }
  })
}

module.exports = { adminLoginRoutes, adminAccountRoutes }
