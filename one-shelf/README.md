# One Shelf

A London marketplace where twelve independent coffee roasters sell bags of beans. Customers enter a postcode, browse a filterable shelf, add coffees to a basket, choose to collect from the roastery or have a local delivery, and check out. There is a mailing-list sign-up, and an admin area for handling orders and managing the catalogue.

This repository is the **server**: the API, the database, the security rules and a demo payment step. The customer pages live in `public/` and the admin pages in `admin/`; the server serves both.

> **The coffees, prices and stock levels in the seed data are illustrative placeholders**, taken from the design mock-up. They are not real offers from the roasters named. Replace them before taking real orders.

## What is not done yet

Stated plainly, so nobody is surprised:

- **Real payments.** The shop runs in *demo mode*: the payment page says "no money is taken" and nothing is charged. The Stripe integration is a documented stub (`src/payments/stripe.js`).
- **Sending email.** No order confirmations and no mailing-list confirmation emails are sent. In demo mode the mailing-list links are only written to the server log.
- **Two-factor sign-in** for admins. Sign-in is email and password only.
- **Legal pages.** There are no terms of sale, privacy notice, cookie notice or returns policy. Checkout requires `accept_terms`, so the terms need to exist before launch.

Also not built: customer accounts, discount codes, refunds through the API (statuses are recorded; money is refunded at the payment provider), VAT invoices, and stock reports.

## Run it locally

You need Node.js 22.5 or newer (built with 22.23).

```sh
npm install
npm run seed                                   # adds the 12 roasters, 24 coffees and delivery zones
node scripts/create-admin.js you@example.com   # asks for a password (12+ characters)
npm start
```

Then open <http://localhost:3000> for the shop and <http://localhost:3000/admin/> for the admin area. The API is described in [`docs/API.md`](docs/API.md).

- `npm run seed` is safe to run again: it only adds what is missing and never overwrites your edits.
- There is no default admin account. For scripted set-up: `ADMIN_PASSWORD='a long passphrase' node scripts/create-admin.js you@example.com`. To set a new password for an existing admin add `--reset`.
- To use a `.env` file: copy `.env.example` to `.env`, then `node --env-file=.env --disable-warning=ExperimentalWarning src/server.js`.
- `npm run dev` restarts the server when a file changes.
- All data (the SQLite database and uploaded images) is in `data/`. Delete that folder to start again from nothing.

### Tests

```sh
npm test
```

Uses Node's built-in test runner against the real app (no network, no extra packages). Each test file gets its own temporary database.

## Environment variables

| Variable | Default | What it is for |
|----------|---------|----------------|
| `NODE_ENV` | `development` | `development`, `test` or `production`. Production switches on Secure cookies, HSTS and the stricter origin rule. |
| `PORT` | `3000` | Port to listen on. |
| `HOST` | `127.0.0.1` | Address to listen on. Use `0.0.0.0` in a container. |
| `DATA_DIR` | `./data` | Where the database and uploads are kept. Must be a persistent disk in production. |
| `PUBLIC_BASE_URL` | `http://localhost:PORT` | The site's public address, no trailing slash. **Required in production and must be `https://`.** |
| `PAYMENT_PROVIDER` | `demo` | `demo` or `stripe`. |
| `ALLOW_DEMO_IN_PRODUCTION` | unset | Set to `yes` only for a staging demo. See below. |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | unset | Required when `PAYMENT_PROVIDER=stripe`. |
| `TRUST_PROXY` | `no` | Set to `yes` behind a reverse proxy or load balancer, so rate limits see the visitor's real address. |
| `ALLOW_MISSING_ORIGIN` | `yes` in development and test, `no` in production | Whether state-changing requests without an `Origin`/`Referer` header (curl, scripts) are accepted. Cannot be enabled in production. |
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`. |
| `RATE_LIMIT_GLOBAL_MAX` | `300` | Requests per IP per minute, everything. |
| `RATE_LIMIT_LOGIN_MAX` | `5` | Sign-in attempts per IP + email per 15 minutes. |
| `RATE_LIMIT_CHECKOUT_MAX` | `10` | Checkouts per IP per minute. |
| `RATE_LIMIT_SUBSCRIBE_MAX` | `5` | Mailing-list sign-ups per IP per hour. |
| `ORDER_EXPIRY_MINUTES` | `30` | How long an unpaid order holds its stock. |
| `ADMIN_PASSWORD` | unset | Read only by `scripts/create-admin.js`, for scripted use. |

The server checks these at start-up and stops with a plain message if something is missing or unsafe. No session secret is needed: sessions are random ids looked up in the database, not signed cookies.

## Payments: demo mode, and moving to Stripe

**Demo mode (`PAYMENT_PROVIDER=demo`, the default).** Checkout creates a real order and reserves real stock, then sends the customer to a page on this server that says in large text "Demo payment: no money is taken", shows the total, and offers two buttons: pay, or make the payment fail. Either way the customer returns to the order page. This lets you try the whole shop, including the admin side, without a payment account.

**The server refuses to start with `NODE_ENV=production` and the demo provider**, because customers would receive coffee without paying. For a staging site that must run in production mode you can set `ALLOW_DEMO_IN_PRODUCTION=yes`; the server then starts and logs a loud warning.

**Moving to Stripe.** `src/payments/stripe.js` is a stub that fails with "not configured" and lists, step by step, what to implement:

1. Create a Stripe account and get the secret key and a webhook signing secret.
2. Implement `createCheckout` with Stripe's hosted Checkout page, using amounts from our database.
3. Implement the signed webhook at `POST /api/webhooks/stripe`. **Only the verified webhook may mark an order paid**; the customer's return to the site proves nothing.
4. Set `PAYMENT_PROVIDER=stripe`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and test with Stripe's test cards before going live.

Nothing else changes: the checkout, order page and admin already go through the same `markPaid` / `markFailed` path the webhook will call.

This server never receives, stores or logs card details, in either mode. With Stripe the customer types their card on Stripe's own page.

## Security measures, in plain words

- **Prices cannot be tampered with.** The browser sends only product ids and quantities. Prices, delivery fees and totals are worked out on the server from the database; anything price-like the browser sends is thrown away.
- **Stock cannot be oversold.** Checkout takes stock inside a single database transaction with a guard that only succeeds while enough is left. If two people go for the last bag, one of them is told it has sold out.
- **Unpaid orders do not hog stock.** An order that is not paid within 30 minutes expires and its stock goes back on the shelf. Cancelling an order does the same.
- **Order pages are private.** A customer needs both the order reference and a long random token to see an order. The server stores only a fingerprint (hash) of the token. A wrong token looks exactly like a missing order. Database ids never appear on the customer side.
- **Admin passwords** are stored with scrypt (a deliberately slow, salted one-way function), each with its own random salt. New passwords need 12+ characters and common ones are refused. There is no default account.
- **Admin sessions** use a random 32-byte id in a cookie that page scripts cannot read (`HttpOnly`), that is not sent on cross-site requests that change things (`SameSite=Lax`), and that is HTTPS-only in production (with the `__Host-` name prefix). The database keeps only a hash of the id. Sessions end after 30 minutes without activity or 12 hours in total, and signing out deletes them.
- **Sign-in guessing is slowed down.** Five attempts per 15 minutes per address and email, and every failure gives the same "Invalid email or password" message, so it cannot be used to discover which emails are admins.
- **Forged requests are blocked two ways.** Every admin change needs a secret token (CSRF token) that another website cannot obtain, and every request that changes anything, public or admin, must come from this site's own pages (Origin check). Nothing is changed by simply opening a link, except the two mailing-list links sent by email (confirm and unsubscribe), which is the normal exception.
- **All input is checked.** Every request body, query string and URL parameter is validated against a strict description (types, lengths, 1 to 12 per line, UK postcode and email formats). Unknown fields are dropped. Errors come back per field so the form can show them in place.
- **Database queries cannot be hijacked.** All SQL is fixed text with placeholders; user input is only ever passed as data. A test scans the source and fails the build if anyone writes a query by gluing strings together.
- **Browser protections.** A strict Content-Security-Policy means only scripts, styles, fonts and images from this site load, and inline scripts and styles are blocked, which defuses most script-injection attacks. The site cannot be framed by other sites. HTTPS is enforced by the browser (HSTS) in production.
- **Uploads are treated as hostile.** Admin only, 5 MB at most. The server checks the real file contents (JPEG, PNG or WebP; never SVG), then re-draws the picture into a fresh WebP file, which removes anything hidden in the original. Files get random names, are kept outside the public folders and are only served as images.
- **Rate limits** on everything (300 a minute per address), with tighter limits on checkout and mailing-list sign-up.
- **Errors do not leak.** Server faults return a generic message; details go to the log only.
- **Logs avoid personal data.** Logs are structured JSON. Emails, phone numbers, addresses, passwords, cookies and tokens are redacted; tokens are stripped from logged URLs. Order contents are not logged.
- **An audit trail.** Every change an admin makes (and every payment, expiry and failed payment) is recorded with who, when, and the before and after values.
- **Safe start-up.** Configuration is checked when the server starts; it refuses to run in production with demo payments or without an `https://` address.
- **Mailing-list consent is recorded.** Each sign-up stores when, where and the exact wording agreed to, starts as "pending" until confirmed (double opt-in), and can be unsubscribed with one click.

## Before going live

A checklist, roughly in order.

- [ ] **Decide who the legal seller is.** Is each sale between the customer and One Shelf, or between the customer and the individual roaster with One Shelf as an agent? This decides whose name is on the terms, who handles refunds and complaints, who accounts for VAT, and whose details must be shown on the site. Get advice; it also shapes the Stripe set-up (one account, or Stripe Connect paying roasters).
- [ ] **Legal pages**: terms of sale, privacy notice, returns and refunds policy, delivery information, and the seller's company details and contact address. Link the terms next to the checkout tick-box. Food products also need ingredient/allergen and business-address information.
- [ ] **Real catalogue**: replace the placeholder coffees, prices, stock and collection hours with each roaster's real ones, with their agreement.
- [ ] **Hosting with a persistent disk.** The database is a single SQLite file in `DATA_DIR`. The host must keep that folder between restarts and deploys (a mounted volume), and run **one** instance of the server (SQLite and the in-memory rate limits are not shared between instances).
- [ ] **Domain and HTTPS.** Point a domain at the host with a valid certificate; set `NODE_ENV=production` and `PUBLIC_BASE_URL=https://your-domain`. Set `TRUST_PROXY=yes` if the host puts a proxy in front (most do).
- [ ] **Stripe account** and the Stripe provider implemented and tested (see above). Agree how roasters are paid.
- [ ] **Email provider** (Postmark, Resend, Amazon SES or similar) for order confirmations, "ready to collect" notices and the mailing-list confirmation email. Verify the sending domain (SPF, DKIM, DMARC). The mailing list must not be used until confirmation emails really go out.
- [ ] **Backups.** Schedule regular copies of the SQLite file and `data/uploads/` to somewhere off the server (for example with `sqlite3 one-shelf.sqlite ".backup ..."` or Litestream), and practise restoring one.
- [ ] **Monitoring.** Uptime checks on `/api/config`, alerts on server errors (the logs are JSON, ready for a log service), and disk-space alerts for the data folder.
- [ ] **Admin accounts**: one per person, long unique passwords, kept in a password manager. Consider adding two-factor sign-in before giving access to more people.
- [ ] **Data protection**: register with the ICO if required, decide how long order and subscriber data is kept, and have a way to answer "what do you hold about me?" and deletion requests.
- [ ] **A test order** all the way through on the live site: pay, see it in admin, move it to completed, refund it.

## How the code is laid out

```
src/server.js          builds the app (buildApp is exported for tests) and starts it
src/config.js          reads and checks environment variables
src/db.js              the only SQLite connection; src/schema.sql is applied at start-up
src/repo/              every SQL statement (fixed text, placeholders only)
src/domain/            business rules: basket pricing, checkout, order status machine, postcodes, response shapes
src/routes/            HTTP endpoints (public, mailing list, media, admin)
src/payments/          payment providers: demo (working), stripe (stub)
src/security/          sessions, passwords, origin check, validation helpers, errors, log redaction
src/storage.js         image checking, re-encoding and storage
src/seed.js            seed logic; src/seed-data.json holds the placeholder catalogue and postcode table
scripts/               seed and create-admin commands
docs/API.md            the API reference and the contract for the two front ends
test/                  automated tests (npm test)
public/, admin/        the two front ends (static files)
seed-assets/           roaster photos used by the seed
data/                  created at run time: database and uploads (not in version control)
```

Technical notes:

- SQLite is used through Node's built-in `node:sqlite`, which Node still labels experimental. It prints a warning at start-up; `src/db.js` silences exactly that one warning and the npm scripts pass `--disable-warning=ExperimentalWarning`. Pin the Node version in production and re-run the tests when upgrading Node.
- The database runs in WAL mode with foreign keys on. Money is stored as whole pence; times as ISO 8601 UTC text.
- Distances are straight-line miles from the centre of a postcode district, so they are approximate.
- "Today" in the admin summary is the UTC day.
