# One Shelf API

Everything the two front ends need. The server is the source of truth for prices, stock, fees and order status; the browser only ever sends *what* the customer wants, never *what it costs*.

- Base URL: same origin as the pages (`/api/...`). There is no CORS: the API is only for pages served by this server.
- Bodies and responses are JSON (`Content-Type: application/json`) unless stated.
- Money is always an integer number of **pence** (`1250` = £12.50). Currency is GBP.
- Timestamps are ISO 8601 strings in UTC (`2026-11-25T13:32:45.275Z`).
- Unknown keys in a body or query string are ignored (stripped), never an error.

Contents: [Front-end contract](#front-end-contract) · [Errors](#errors) · [Public API](#public-api) · [Demo payment pages](#demo-payment-pages) · [Admin API](#admin-api) · [Order status transitions](#order-status-transitions) · [Rate limits](#rate-limits)

---

## Front-end contract

Read this section first; it is the part that is easy to get wrong.

### Where the files go

| Folder    | Served at  | Notes |
|-----------|------------|-------|
| `public/` | `/`        | Customer site. `index.html` is the home page. |
| `admin/`  | `/admin/`  | Admin site. `/admin` redirects to `/admin/`. |

HTML is served with `Cache-Control: no-cache`; other static files with `public, max-age=3600`. Files whose name starts with a dot are never served.

Pages the server links to, which the customer front end **must provide**:

| URL | When |
|-----|------|
| `/order.html?ref=OS-XXXXXXX&token=...` | The customer lands here after the payment step (paid, failed or abandoned). Read `ref` and `token` from the query string and call `GET /api/orders/:ref?token=`. |
| `/?newsletter=confirmed` \| `unsubscribed` \| `invalid` | The customer lands here after clicking a link in a mailing-list email. Show a short message. |

### Content-Security-Policy (this will break careless code)

Every response carries:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:;
font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none';
base-uri 'none'; object-src 'none'
```

So, in both front ends:

- **No inline scripts**: no `<script>...</script>` with code in it, no `onclick="..."` attributes, no `javascript:` URLs. Use `<script src="/js/app.js" defer></script>` and `addEventListener`.
- **No inline styles**: no `<style>` blocks and no `style="..."` attributes. Use `.css` files. Setting styles from JavaScript through the DOM (`el.style.setProperty('--bag', colour)`, `el.style.width = ...`) *is* allowed; `el.setAttribute('style', ...)` and `innerHTML` containing `style=` are not.
- **No third-party anything**: no CDN scripts, web fonts, analytics or images from other hosts. Put fonts and libraries in the static folder.
- Forms can only post back to this site.
- **Render data with `textContent`** (or `document.createElement` + `textContent` / `setAttribute`), **never `innerHTML`**. Product names, roaster descriptions, customer names and notes are free text typed by people. The API returns them as plain text, not HTML-escaped.
- For colours from the API (`bag_color`, `label_color`, `label_ink`, `tint`; always `#RRGGBB`), set a CSS custom property through `el.style.setProperty`.

### Images

`image_url` fields are either `null` or a path like `/media/3d47c40ca7406a49b1378a09dc698d45.webp`. Use it as-is in `img.src`. Images are always WebP, at most 1600px on the long side, and cacheable forever (a replaced image gets a new URL). All twelve seeded roasters have a photo; seeded coffees have `image_url: null` (draw the bag from the roaster's colours and the product `tint`).

`seed-assets/fish-sheet.webp` is a design asset, not served by the API. If the customer site needs it, copy it into `public/`.

### Identifiers

Public responses never contain database ids. A product's or roaster's public `id` is a string that is the same as its `slug` (`"guji-natural"`, `"square-mile"`). Send a product's `id` back as `product_id` in basket and checkout calls. An order is identified by its `ref` (`OS-7K3F9QX`) **plus** its access token.

The admin API does use integer ids (`/api/admin/products/17`).

### Passing the postcode

The customer types a postcode once. Validate it with `GET /api/postcode/:value` (URL-encode it; full postcodes such as `E8 4PH` and districts such as `E8` both work), keep the returned `district` in `localStorage`, and pass it as `?postcode=` on `GET /api/products`, `GET /api/products/:slug` and `GET /api/roasters`. With it, items gain `distance_miles` and `sort=near` works.

Distances are **approximate**: straight-line miles from the centre of the postcode district to the roastery, rounded to 0.1. Say "about 0.4 miles", not "0.4 miles from your door".

### Basket and checkout flow

The basket lives in the browser (e.g. `localStorage`) as a list of `{ product_id, quantity, grind }`. Nothing is reserved until checkout.

1. **Quote** whenever the basket or the fulfilment choice changes: `POST /api/basket/quote`. Display the `lines`, `subtotal_pence`, `delivery_fee_pence` and `total_pence` from the response; do not compute totals yourself. If `problems` is non-empty, show each `message` and replace your stored basket with the returned `lines` (quantities may have been reduced, lines removed).
2. Use `collection.allowed` / `collection.reason` and `delivery.available` / `delivery.reason` to enable or explain the two fulfilment options. `can_checkout` tells you whether the "Pay" button should be enabled.
3. **Checkout**: `POST /api/checkout` with the items, fulfilment, customer details, address (delivery only) and `accept_terms: true`. Any price fields you send are ignored.
4. On `201`, store `order_ref` and `access_token` (e.g. `sessionStorage`, so the customer can get back to the order), empty the basket, then send the browser to `payment_url` with `location.assign(payment_url)`. It may be a relative path (demo) or an absolute URL (a real provider).
5. The payment step ends with a redirect to `/order.html?ref=...&token=...`. That page calls `GET /api/orders/:ref?token=` and shows the status. If the status is still `pending_payment`, poll every few seconds for up to a minute (a real provider confirms by webhook, slightly after the redirect), and offer the returned `payment_url` as a "complete payment" link.
6. On `409 basket_changed` or `409 collection_unavailable`, show `error.message`, re-run the quote and let the customer review.
7. On `422 validation_error`, show each `error.fields[...]` message next to its input (keys listed under [Checkout](#post-apicheckout)).

An unpaid order holds its stock for 30 minutes (`expires_at`), then becomes `expired` and the stock goes back on the shelf.

When `GET /api/config` says `payment_mode: "demo"`, show a visible "Demo shop: no money is taken" notice near the pay button.

### Admin sign-in, cookie and CSRF flow

1. `POST /api/admin/login` with `{ email, password }`. On success the server sets an `HttpOnly` session cookie (JavaScript cannot read it; the browser sends it automatically on same-origin `fetch`) and returns `{ admin, csrf_token }`.
2. Keep `csrf_token` **in memory only** (a module variable). On a page reload call `GET /api/admin/me`: `200` returns a fresh `csrf_token`; `401` means show the sign-in form.
3. Send the token as the `x-csrf-token` header on **every** admin `POST`, `PUT`, `PATCH`. It is not accepted in the body or query string. `GET`s do not need it.
4. Any admin call can return `401 unauthorized` (session expired: 30 minutes without activity, or 12 hours after sign-in). Show the sign-in form again.
5. `403 csrf_invalid`: call `GET /api/admin/me` for a new token and retry once.
6. `POST /api/admin/logout` ends the session. After `POST /api/admin/password` use the `csrf_token` from its response (the session is replaced).

Use plain same-origin `fetch` (the default `credentials: 'same-origin'` is right). Browsers add the `Origin` header themselves; the server refuses state-changing requests whose `Origin`/`Referer` is another site.

### Optimistic locking (`version`)

Orders, products and roasters carry a `version` number. Send the `version` you loaded with every change. If someone else changed the record meanwhile you get `409 stale_version`: reload the record, show the user what changed, and let them retry. Every successful change returns the updated record with its new `version`.

---

## Errors

Every error, from any endpoint, has this shape:

```json
{ "error": { "code": "validation_error", "message": "Please check the highlighted fields.", "fields": { "customer.email": "Enter a valid email address, like name@example.com" } } }
```

- `code`: stable, machine-readable. Branch on this.
- `message`: plain English, safe to show to the person.
- `fields`: only on validation-type errors. Keys are dotted paths into the request (`customer.email`, `address.postcode`, `items.0.quantity`); values are messages written to sit next to that form field.

| HTTP | `code` | Meaning |
|------|--------|---------|
| 400 | `bad_request` | Body is not valid JSON, or otherwise unreadable. |
| 401 | `unauthorized` | Admin session missing or expired. |
| 401 | `invalid_credentials` | Sign-in failed. Always the message "Invalid email or password". |
| 403 | `origin_forbidden` | State-changing request from another site (or with no `Origin`/`Referer` in production). |
| 403 | `csrf_invalid` | Missing or wrong `x-csrf-token`. |
| 404 | `not_found` | No such route, record, order (or wrong order token), image. |
| 409 | `stale_version` | The record changed since you loaded it. |
| 409 | `invalid_transition` | That status change is not allowed. |
| 409 | `basket_changed` | Stock or availability changed; re-quote. `fields` keys are `items.<product_id>`. |
| 409 | `collection_unavailable` | Collection chosen but not possible for this basket. |
| 413 | `payload_too_large` / `file_too_large` | JSON over 64 KB / upload over 5 MB. |
| 415 | `unsupported_media_type` / `unsupported_image` | Wrong content type / file is not a real JPEG, PNG or WebP. |
| 422 | `validation_error` | One or more fields are invalid; see `fields`. |
| 422 | `postcode_invalid` / `postcode_not_london` | From the postcode lookup. |
| 429 | `rate_limited` | Too many requests; a `retry-after` header (seconds) is set. |
| 500 | `internal_error` | Our fault. No detail is ever included. |
| 501 | `not_configured` | Stripe webhook hit while Stripe is still a stub. |
| 503 | `payment_unavailable` | The payment provider could not start a payment. Nothing was charged; stock was released. |

---

## Public API

No authentication. `POST`s must come from this site (browser `fetch` does this automatically).

### `GET /api/config`

```json
{
  "payment_mode": "demo",
  "delivery_fee_pence": 350,
  "currency": "GBP",
  "grinds": ["Whole bean", "Espresso", "Moka pot", "Filter", "Cafetière"],
  "max_quantity_per_line": 12,
  "max_basket_lines": 20,
  "order_expiry_minutes": 30
}
```

`payment_mode` is `"demo"` or `"live"`. `delivery_fee_pence` is the standard (lowest active) delivery fee for display such as "Delivery from £3.50"; the quote is authoritative. It is `null` if delivery is switched off everywhere.

### `GET /api/roasters`

Query: `postcode` (optional; full postcode or district).

Active roasters only. Without a postcode: sorted by name. With a valid London postcode: each gains `distance_miles` and the list is sorted nearest first. A well-formed non-London postcode is ignored (no distances); a malformed one is `422`.

```json
{
  "roasters": [
    {
      "id": "climpson-and-sons", "slug": "climpson-and-sons", "name": "Climpson & Sons",
      "area": "Hackney", "postcode": "E8", "lat": 51.537, "lon": -0.061,
      "description": "Broadway Market roots and bright, fruit-forward espresso.",
      "bag_color": "#F4F1EA", "label_color": "#F4F1EA", "label_ink": "#C4361F",
      "image_url": "/media/ef34fb0a720a4df9221b28dae759aee6.webp",
      "collection_enabled": true, "collection_hours": "Mon to Fri 9am to 4pm",
      "distance_miles": 0.4
    }
  ],
  "postcode": { "district": "E8", "label": "E8" }
}
```

`postcode` is `null` when none (or a non-London one) was given.

### `GET /api/products`

Only products with status `active` from active roasters.

| Query | Values | Effect |
|-------|--------|--------|
| `postcode` | full postcode or district | adds `distance_miles` |
| `roaster` | roaster slug | only that roaster |
| `roast` | `light` \| `medium` \| `dark` | roast level 1-2 / 3 / 4-5 |
| `brew` | `espresso` \| `filter` | matches that brew method or `both` |
| `max_price_pence` | integer | price at or below |
| `q` | text, up to 60 chars | searches name, origin, process, varietal, tasting notes, roaster name and area |
| `sort` | `roast` (default) \| `near` \| `price_asc` \| `price_desc` | `near` needs a valid postcode, otherwise falls back to `roast` |

Any other `sort`/`roast`/`brew` value is a `422`.

```json
{
  "products": [
    {
      "id": "guji-natural", "slug": "guji-natural", "name": "Guji Natural",
      "roaster": {
        "id": "climpson-and-sons", "slug": "climpson-and-sons", "name": "Climpson & Sons",
        "area": "Hackney", "postcode": "E8",
        "bag_color": "#F4F1EA", "label_color": "#F4F1EA", "label_ink": "#C4361F",
        "image_url": "/media/ef34fb0a720a4df9221b28dae759aee6.webp",
        "collection_enabled": true, "distance_miles": 0.4
      },
      "origin_country": "Ethiopia", "origin_region": "Guji", "process": "Natural", "varietal": "Heirloom",
      "altitude_m": 2100, "roast_level": 2, "roast_band": "light", "brew": "both",
      "notes": ["Blueberry", "Cocoa nib", "Violet"],
      "flavour": { "acidity": 7, "sweetness": 8, "body": 5, "fruit": 9, "floral": 6, "roast": 3 },
      "weight_g": 250, "price_pence": 1250, "image_url": null, "tint": "#B0668D",
      "in_stock": true, "low_stock": false, "stock_left": null,
      "distance_miles": 0.4
    }
  ],
  "count": 24,
  "postcode": { "district": "E8", "label": "E8" }
}
```

- `roast_level` is 1 (lightest) to 5 (darkest). `brew` is `espresso`, `filter` or `both`.
- `flavour` scores are 0 to 10, in the display order acidity, sweetness, body, fruit, floral, roast.
- `in_stock`: at least one left. `low_stock`: 1 to 3 left. `stock_left`: the exact number **only when 5 or fewer remain**, otherwise `null`. The exact stock is never exposed above 5.
- `distance_miles` (on the product and its `roaster`) only appears when a valid London postcode was given.

### `GET /api/products/:slug`

Query: `postcode` (optional). Returns `{ "product": { ...same shape as above... } }`, or `404 not_found` if it does not exist or is not on sale.

### `GET /api/postcode/:value`

`value` is URL-encoded, any case, space optional: `E8%204PH`, `e84ph`, `E8`, `N1C`.

```json
{
  "valid": true,
  "district": "E8",
  "label": "E8",
  "approximate": false,
  "delivery_available": true,
  "nearest_roaster": { "id": "climpson-and-sons", "slug": "climpson-and-sons", "name": "Climpson & Sons", "area": "Hackney", "distance_miles": 0.4 }
}
```

- `district`: the first half of the postcode. Store this and pass it as `?postcode=`.
- `label`: for display. Usually the district; when the district is not in our table (`approximate: true`) it is the wider area, e.g. `"east London"`, and distances are measured from the centre of that whole area.
- Distance is from the postcode district centroid, so it is approximate.

Errors (`422`):

```json
{ "error": { "code": "postcode_not_london", "message": "One Shelf only covers London for now. Try a London postcode such as E8, N1, SE15, SW9 or W11.", "fields": { "postcode": "Enter a London postcode" } } }
```

`postcode_invalid` is returned when the text is not shaped like a UK postcode. Covered areas: E, EC, N, NW, SE, SW, W, WC, TW.

### `POST /api/basket/quote`

Prices a basket. Changes nothing; call it as often as you like.

```json
{
  "items": [
    { "product_id": "guji-natural", "quantity": 2, "grind": "Filter" },
    { "product_id": "nyeri-aa", "quantity": 1 }
  ],
  "fulfilment": "delivery",
  "postcode": "E8 4PH"
}
```

| Field | Rules |
|-------|-------|
| `items` | 1 to 20 lines |
| `items[].product_id` | a product `id` (slug) |
| `items[].quantity` | whole number 1 to 12 |
| `items[].grind` | one of `grinds` from `/api/config`; default `"Whole bean"` |
| `fulfilment` | `collect` (default) or `delivery` |
| `postcode` | optional; full postcode or district; used for the delivery check |

Response `200`:

```json
{
  "lines": [
    {
      "product_id": "guji-natural", "name": "Guji Natural",
      "roaster": { "id": "climpson-and-sons", "name": "Climpson & Sons" },
      "grind": "Filter", "weight_g": 250,
      "quantity": 2, "requested_quantity": 2,
      "unit_price_pence": 1250, "line_total_pence": 2500,
      "image_url": null, "tint": "#B0668D",
      "bag_color": "#F4F1EA", "label_color": "#F4F1EA", "label_ink": "#C4361F"
    }
  ],
  "problems": [
    { "product_id": "kayanza-washed", "code": "quantity_reduced", "message": "Only 2 of Kayanza Washed left, so the quantity was reduced.", "requested_quantity": 5, "available_quantity": 2 }
  ],
  "fulfilment": "delivery",
  "subtotal_pence": 3800,
  "delivery_fee_pence": 350,
  "total_pence": 4150,
  "currency": "GBP",
  "collection": {
    "allowed": false,
    "reason_code": "multiple_roasters",
    "reason": "Collection is only possible when everything in your basket comes from one roastery. Choose delivery, or order from each roastery separately.",
    "roaster": null
  },
  "delivery": { "available": true, "fee_pence": 350, "estimated": false, "reason": null, "reason_code": null },
  "can_checkout": true
}
```

- `problems[].code`: `product_unavailable` (line removed), `out_of_stock` (line removed), `quantity_reduced` (line kept with a lower `quantity`). Lines with the same product and grind are merged.
- `collection.allowed` is `true` only when every line is from one roaster that has collection enabled; then `collection.roaster` is `{ id, name, area, postcode, collection_hours }`. Otherwise `reason_code` is `multiple_roasters`, `collection_disabled` or `empty_basket`.
- `delivery.available` is `true`, `false`, or `null` when no postcode was given yet (then `fee_pence` is the standard fee and `estimated` is `true`). `reason_code`: `postcode_needed`, `postcode_invalid`, `outside_delivery_area`.
- `delivery_fee_pence` and `total_pence` reflect the `fulfilment` you sent (the fee is `0` for `collect`).

### `POST /api/checkout`

Creates the order as `pending_payment`, reserves the stock and starts a payment. Rate limited (10 per minute per IP).

```json
{
  "items": [{ "product_id": "guji-natural", "quantity": 2, "grind": "Filter" }],
  "fulfilment": "delivery",
  "customer": { "name": "Ada Lovelace", "email": "ada@example.com", "phone": "020 7946 0958" },
  "address": { "line1": "1 Mare Street", "line2": "Flat 2", "city": "London", "postcode": "E8 4RP" },
  "delivery_notes": "Leave with the neighbour at number 3",
  "accept_terms": true
}
```

| Field (also the `fields` key on a 422) | Rules |
|----------------------------------------|-------|
| `items`, `items.<index>.product_id`, `items.<index>.quantity`, `items.<index>.grind` | as for the quote |
| `fulfilment` | `collect` or `delivery` (required) |
| `customer.name` | 1 to 100 characters, one line |
| `customer.email` | valid email, up to 254 characters |
| `customer.phone` | 7 to 20 digits; spaces, `+`, `-`, brackets allowed |
| `address` | required when `fulfilment` is `delivery`; ignored for `collect` |
| `address.line1` | 1 to 120 characters |
| `address.line2` | optional, up to 120 characters |
| `address.city` | 1 to 60 characters |
| `address.postcode` | full UK postcode in a delivery area (`E8 4RP`) |
| `delivery_notes` | optional, up to 500 characters |
| `accept_terms` | must be exactly `true` |

Anything else in the body (prices, totals, status) is dropped before it is looked at.

Response `201`:

```json
{
  "order_ref": "OS-Y47XF3R",
  "access_token": "8xgYLKP6lJpQkrGhMCy_4j1j8cRUpvSddtVq7f2uXCQ",
  "payment_url": "/pay/demo/OS-Y47XF3R?token=8xgYLKP6lJpQkrGhMCy_4j1j8cRUpvSddtVq7f2uXCQ",
  "expires_at": "2026-11-25T14:02:45.275Z"
}
```

The `access_token` is shown only here; the server keeps just a hash. Treat it like a password for that one order.

Errors: `422 validation_error`; `409 basket_changed` (unlike the quote, checkout never silently adjusts a basket: re-quote and let the customer confirm); `409 collection_unavailable`; `429 rate_limited`; `503 payment_unavailable`.

### `GET /api/orders/:ref?token=...`

The customer's view of their order. A wrong token, a missing token and an unknown reference all give the same `404 not_found`. Sent with `Cache-Control: no-store`.

```json
{
  "order": {
    "ref": "OS-Y47XF3R",
    "status": "paid",
    "created_at": "2026-11-25T13:32:45.275Z",
    "paid_at": "2026-11-25T13:32:45.356Z",
    "expires_at": null,
    "fulfilment": "collect",
    "customer": { "name": "Test Person", "email": "test@example.com", "phone": "020 7946 0000" },
    "items": [
      { "product_id": "guji-natural", "name": "Guji Natural", "roaster_name": "Climpson & Sons", "grind": "Filter", "unit_price_pence": 1250, "quantity": 2, "line_total_pence": 2500 }
    ],
    "subtotal_pence": 2500,
    "delivery_fee_pence": 0,
    "total_pence": 2500,
    "currency": "GBP",
    "collection": { "roaster": { "id": "climpson-and-sons", "name": "Climpson & Sons", "area": "Hackney", "postcode": "E8", "collection_hours": "Mon to Fri 9am to 4pm" } },
    "delivery": null,
    "payment_mode": "demo",
    "payment_url": null
  }
}
```

- `status`: see [Order status transitions](#order-status-transitions) for the meanings.
- `expires_at` and `payment_url` are set only while the status is `pending_payment`.
- For delivery orders `collection` is `null` and `delivery` is `{ address_line1, address_line2, city, postcode, delivery_notes }`.
- Item names and prices are snapshots taken at checkout; they do not change if the catalogue changes later.

### Mailing list

No email is sent by this server yet. An email provider must be connected (see the README). In demo mode the confirmation and unsubscribe links are written to the server log at info level so the flow can be tried.

#### `GET /api/subscribe/consent-text`

```json
{ "consent_text": "Yes, email me One Shelf news about new coffees and roasters. I can unsubscribe at any time using the link in every email.", "version": "2026-11" }
```

Show exactly this text as the label of an **unticked** checkbox next to the email field. The server stores the same wording with the sign-up as the record of consent.

#### `POST /api/subscribe`

Body: `{ "email": "reader@example.com", "consent": true, "source": "footer" }`. `consent` must be exactly `true`. `source` is optional: `footer` (default), `checkout`, `home`, `other`.

Response `202`, identical whether or not the address was already on the list:

```json
{ "ok": true, "message": "Thanks. Check your inbox for a link to confirm your subscription." }
```

Errors: `422 validation_error` (`fields.email`, `fields.consent`), `429 rate_limited` (5 per hour per IP).

#### `GET /api/subscribe/confirm?token=...` and `GET /api/unsubscribe?token=...`

These two `GET`s change state. That is the deliberate, standard exception for links opened from an email (a mail program cannot send a `POST`); they are the only `GET`s in the API that change anything. Both need an unguessable token and are safe to repeat.

A browser is redirected (`303`) to `/?newsletter=confirmed`, `/?newsletter=unsubscribed` or `/?newsletter=invalid`. A client that sends `Accept: application/json` gets `{ "ok": true, "status": "confirmed" }` (or `"unsubscribed"`), or `404 not_found` for a bad token.

Subscriber statuses: `pending` (signed up, not yet confirmed) → `confirmed` → `unsubscribed`. Signing up again after unsubscribing starts over at `pending`.

### `GET /media/:name`

Uploaded images. `name` must match `^[a-f0-9]{32}\.webp$`. Always `Content-Type: image/webp` with `X-Content-Type-Options: nosniff`. Anything else is `404`.

---

## Demo payment pages

Only present when `PAYMENT_PROVIDER=demo`. Server-rendered; the front ends do not build these.

| Method and path | What it does |
|-----------------|--------------|
| `GET /pay/demo/:ref?token=` | Page that says "Demo payment: no money is taken", shows the total and two buttons. `404` page for a bad ref or token. |
| `POST /pay/demo/:ref/pay` (form field `token`) | Marks the order `paid`, then `303` to `/order.html?ref=&token=`. |
| `POST /pay/demo/:ref/fail` (form field `token`) | Marks the order `cancelled` and puts the stock back, then `303` to `/order.html?ref=&token=`. |
| `GET /pay/demo.css` | Stylesheet for the page. |

Both buttons go through the same internal `markPaid` / `markFailed` path a real provider's webhook will use. With `PAYMENT_PROVIDER=stripe` the only payment route is `POST /api/webhooks/stripe`, which answers `501 not_configured` until the Stripe provider is implemented.

---

## Admin API

All under `/api/admin`. Everything except `login` needs the session cookie; every `POST`/`PUT`/`PATCH` also needs the `x-csrf-token` header (see [the flow](#admin-sign-in-cookie-and-csrf-flow)). All responses are `Cache-Control: no-store`. Every state-changing call writes an audit log entry with before and after snapshots.

Common errors on every admin endpoint: `401 unauthorized`, `403 csrf_invalid`, `403 origin_forbidden`, `422 validation_error`, `404 not_found`.

### Session

#### `POST /api/admin/login`

Body `{ "email": "you@example.com", "password": "..." }`. Rate limited: 5 attempts per 15 minutes per IP + email (`429 rate_limited`).

`200` (also sets the session cookie):

```json
{ "admin": { "id": 1, "email": "you@example.com" }, "csrf_token": "wvcWN5PD-t-e9_4kgDaiVTfOLk6X-D-vhQ69wJrjdAOuztk8AgRM" }
```

Any failure at all: `401` `{ "error": { "code": "invalid_credentials", "message": "Invalid email or password" } }`.

#### `GET /api/admin/me`

```json
{
  "admin": { "id": 1, "email": "you@example.com", "last_login_at": "2026-11-25T13:32:45.475Z" },
  "csrf_token": "kIVMjSlL-ZqVpnnA4zaNioNiD7g10xsdAOCxb5PhVhtyKg5X2olk",
  "session": { "idle_timeout_minutes": 30, "absolute_timeout_hours": 12, "started_at": "2026-11-25T13:32:45.475Z" }
}
```

#### `POST /api/admin/logout`

No body. `200 { "ok": true }`. Deletes the session and clears the cookie.

#### `POST /api/admin/password`

Body `{ "current_password": "...", "new_password": "..." }`. The new password needs at least 12 characters and must not be on the built-in list of common passwords. `200 { "ok": true, "csrf_token": "..." }`: all other sessions for this admin are signed out, this browser gets a new session, and you must switch to the returned token. `422` with `fields.current_password` or `fields.new_password`.

### Orders

#### `GET /api/admin/orders`

| Query | Meaning |
|-------|---------|
| `status` | one order status |
| `from`, `to` | `YYYY-MM-DD`, inclusive, by creation date in UTC |
| `q` | matches part of the order ref, email or customer name |
| `limit` | 1 to 200, default 50 |
| `offset` | default 0 |

Newest first.

```json
{
  "orders": [
    { "id": 1, "ref": "OS-Y47XF3R", "status": "paid", "customer_name": "Test Person", "email": "test@example.com", "fulfilment": "collect", "total_pence": 2500, "item_count": 2, "created_at": "2026-11-25T13:32:45.275Z", "paid_at": "2026-11-25T13:32:45.356Z", "version": 2 }
  ],
  "total": 1, "limit": 50, "offset": 0
}
```

#### `GET /api/admin/orders/:id`

```json
{
  "order": {
    "id": 1, "ref": "OS-Y47XF3R", "status": "preparing",
    "allowed_transitions": ["ready_for_collection", "cancelled", "refunded"],
    "customer_name": "Test Person", "email": "test@example.com", "phone": "020 7946 0000",
    "fulfilment": "collect",
    "collection_roaster": { "id": 5, "name": "Climpson & Sons", "area": "Hackney" },
    "address_line1": null, "address_line2": null, "city": null, "postcode": null, "delivery_notes": null,
    "items": [
      { "product_id": 5, "roaster_id": 5, "name": "Guji Natural", "roaster_name": "Climpson & Sons", "grind": "Filter", "unit_price_pence": 1250, "quantity": 2, "line_total_pence": 2500 }
    ],
    "subtotal_pence": 2500, "delivery_fee_pence": 0, "total_pence": 2500,
    "payment_provider": "demo", "payment_ref": "demo_OS-Y47XF3R",
    "admin_notes": "",
    "created_at": "2026-11-25T13:32:45.275Z", "paid_at": "2026-11-25T13:32:45.356Z", "expires_at": "2026-11-25T14:02:45.275Z",
    "version": 3,
    "audit": [
      { "id": 4, "admin_id": 1, "admin_email": "you@example.com", "action": "order.status_changed", "entity": "order", "entity_id": "1",
        "before": { "status": "paid", "version": 2, "paid_at": "2026-11-25T13:32:45.356Z", "payment_ref": "demo_OS-Y47XF3R" },
        "after": { "status": "preparing", "version": 3, "paid_at": "2026-11-25T13:32:45.356Z", "payment_ref": "demo_OS-Y47XF3R" },
        "created_at": "2026-11-25T13:33:10.120Z" }
    ]
  }
}
```

`allowed_transitions` lists exactly the statuses the server will accept next; build the action buttons from it. `audit` is newest first; entries made by the system (payment, expiry) have `admin_id: null`.

#### `POST /api/admin/orders/:id/status`

Body `{ "status": "preparing", "version": 2 }`. Returns `{ "order": ...full detail... }`.

Errors: `409 invalid_transition` (not in `allowed_transitions`), `409 stale_version`. Moving to `cancelled` puts the order's stock back.

#### `POST /api/admin/orders/:id/notes`

Body `{ "admin_notes": "Rang the customer", "version": 3 }` (up to 2000 characters; replaces the notes). Returns the full order. `409 stale_version`. Customers never see these notes.

### Products

Admin product shape:

```json
{
  "id": 5, "roaster_id": 5, "roaster_name": "Climpson & Sons", "slug": "guji-natural", "name": "Guji Natural",
  "origin_country": "Ethiopia", "origin_region": "Guji", "process": "Natural", "varietal": "Heirloom", "altitude_m": 2100,
  "roast_level": 2, "brew": "both", "notes": ["Blueberry", "Cocoa nib", "Violet"],
  "flavour": { "acidity": 7, "sweetness": 8, "body": 5, "fruit": 9, "floral": 6, "roast": 3 },
  "weight_g": 250, "price_pence": 1250, "stock": 32, "image_url": null, "tint": "#B0668D",
  "status": "active", "version": 1,
  "created_at": "2026-11-25T13:30:01.000Z", "updated_at": "2026-11-25T13:30:01.000Z"
}
```

| Field | Rules | On create |
|-------|-------|-----------|
| `roaster_id` | id of an existing roaster | required |
| `name` | 1 to 100 characters | required |
| `slug` | lowercase letters, numbers, hyphens; unique | optional (made from the name) |
| `origin_country` | 1 to 60 characters | required |
| `origin_region`, `process`, `varietal` | up to 80 / 60 / 80 characters | optional (empty) |
| `altitude_m` | whole number 0 to 6000, or `null` | optional (`null`) |
| `roast_level` | whole number 1 to 5 | required |
| `brew` | `espresso` \| `filter` \| `both` | required |
| `notes` | exactly three strings, each 1 to 30 characters | required |
| `flavour` | `acidity`, `sweetness`, `body`, `fruit`, `floral`, `roast`; each a whole number 0 to 10 | required |
| `weight_g` | 50 to 5000 | optional (250) |
| `price_pence` | whole number 0 to 100000 | required |
| `stock` | whole number 0 to 100000 | optional (0) |
| `tint` | `#RRGGBB` | optional |
| `status` | `draft` \| `active` | optional (`draft`) |

Numbers must be JSON numbers, not strings.

| Method and path | Body | Result |
|-----------------|------|--------|
| `GET /api/admin/products` | query: `status` (`draft`\|`active`\|`archived`), `roaster_id`, `q` | `{ "products": [...], "count": 24 }`, all statuses, with exact `stock` |
| `GET /api/admin/products/:id` | | `{ "product": {...} }` |
| `POST /api/admin/products` | fields above | `201 { "product": {...} }` |
| `PATCH /api/admin/products/:id` (`PUT` is the same) | any subset of the fields **plus `version`** | `{ "product": {...} }`; `409 stale_version` |
| `POST /api/admin/products/:id/archive` | `{ "version": n }` | status becomes `archived` (hidden from the shop, kept for old orders) |
| `POST /api/admin/products/:id/restore` | `{ "version": n }` | status becomes `draft` (publish it by patching `status: "active"`); `409 invalid_transition` if it is not archived |
| `POST /api/admin/products/:id/image` | `multipart/form-data`, one file in a field named `image` | `{ "product": {...} }` with the new `image_url` |

A duplicate slug or unknown roaster is a `422` with `fields.slug` / `fields.roaster_id`. An archived product's `status` cannot be changed by `PATCH` (`409 invalid_transition`); use restore.

**Image upload**: send a `FormData` with the file under `image` and do **not** set `Content-Type` yourself (the browser adds the boundary); do send `x-csrf-token`. JPEG, PNG or WebP, up to 5 MB. The server checks the actual bytes (the file name and declared type are ignored), re-encodes to WebP at up to 1600px and gives it a random name. Errors: `415 unsupported_image` (not a real JPEG/PNG/WebP; SVG is never accepted), `413 file_too_large`, `415 unsupported_media_type` (not multipart), `400 bad_request` (no file).

### Roasters

Admin roaster shape:

```json
{
  "id": 5, "slug": "climpson-and-sons", "name": "Climpson & Sons", "area": "Hackney", "postcode": "E8",
  "lat": 51.537, "lon": -0.061, "description": "Broadway Market roots and bright, fruit-forward espresso.",
  "bag_color": "#F4F1EA", "label_color": "#F4F1EA", "label_ink": "#C4361F",
  "image_url": "/media/ef34fb0a720a4df9221b28dae759aee6.webp",
  "collection_enabled": true, "collection_hours": "Mon to Fri 9am to 4pm",
  "active": true, "version": 1, "active_products": 2
}
```

`active_products` is only present in the list. Required on create: `name` (up to 80), `area` (up to 60), `postcode` (district or full UK postcode), `lat` (49 to 61), `lon` (-9 to 3). Optional: `slug`, `description` (up to 400), `bag_color`, `label_color`, `label_ink` (`#RRGGBB`), `collection_enabled` (boolean, default `true`), `collection_hours` (up to 120).

| Method and path | Body | Result |
|-----------------|------|--------|
| `GET /api/admin/roasters` | | `{ "roasters": [...] }`, active and inactive |
| `GET /api/admin/roasters/:id` | | `{ "roaster": {...} }` |
| `POST /api/admin/roasters` | fields above | `201 { "roaster": {...} }` |
| `PATCH /api/admin/roasters/:id` (`PUT` is the same) | any subset **plus `version`** | `{ "roaster": {...} }`; `409 stale_version` |
| `POST /api/admin/roasters/:id/deactivate` | `{ "version": n }` | `active: false`; the roaster and all its coffees disappear from the shop |
| `POST /api/admin/roasters/:id/reactivate` | `{ "version": n }` | `active: true` |
| `POST /api/admin/roasters/:id/image` | multipart, field `image` | as for products |

### Delivery zones

A zone is the letters at the start of a postcode (`E`, `SE`, `TW`) with a fee. Delivery is offered only where an active zone exists. Only London areas known to the postcode table (E, EC, N, NW, SE, SW, W, WC, TW) can resolve to a zone.

| Method and path | Body | Result |
|-----------------|------|--------|
| `GET /api/admin/delivery-zones` | | `{ "zones": [{ "postcode_prefix": "E", "fee_pence": 350, "active": true }] }` |
| `PUT /api/admin/delivery-zones/:prefix` | `{ "fee_pence": 350, "active": true }` (`active` defaults to `true`; fee 0 to 10000) | `{ "zone": {...} }`; creates or updates. `prefix` is one or two letters. |

### Subscribers

| Method and path | Notes |
|-----------------|-------|
| `GET /api/admin/subscribers` | query: `status` (`pending`\|`confirmed`\|`unsubscribed`), `limit`, `offset`. Returns `{ "subscribers": [{ "email", "status", "consent_at", "consent_source", "consent_text", "unsubscribed_at" }], "total", "limit", "offset" }` |
| `GET /api/admin/subscribers.csv` | Same columns as a CSV download (`Content-Disposition: attachment`). Link to it with a plain `<a href download>`; it is a `GET`, so the cookie is enough. Only email people whose status is `confirmed`. |

### Audit log

`GET /api/admin/audit?entity=&entity_id=&limit=&offset=`

`entity` is one of `order`, `product`, `roaster`, `delivery_zone`, `admin_user`; `entity_id` is the record's id (the prefix for zones). Both optional. Newest first.

```json
{
  "entries": [
    { "id": 12, "admin_id": 1, "admin_email": "you@example.com", "action": "product.updated", "entity": "product", "entity_id": "5",
      "before": { "price_pence": 1250, "stock": 32, "status": "active", "version": 1 },
      "after": { "price_pence": 1300, "stock": 32, "status": "active", "version": 2 },
      "created_at": "2026-11-25T14:00:00.000Z" }
  ],
  "limit": 50, "offset": 0
}
```

(`before` / `after` hold the full record snapshot; shortened here. `before` is `null` for creations.)

Actions: `order.status_changed`, `order.notes_changed`, `order.payment_paid`, `order.payment_failed`, `order.expired`, `product.created`, `product.updated`, `product.archived`, `product.restored`, `product.image_changed`, `roaster.created`, `roaster.updated`, `roaster.deactivated`, `roaster.reactivated`, `roaster.image_changed`, `delivery_zone.created`, `delivery_zone.updated`, `admin.login`, `admin.logout`, `admin.password_changed`, `admin.created_cli`, `admin.password_reset_cli`.

### Summary

`GET /api/admin/summary`

```json
{
  "orders_by_status": { "pending_payment": 0, "paid": 0, "preparing": 1, "ready_for_collection": 0, "out_for_delivery": 0, "completed": 0, "cancelled": 0, "refunded": 0, "expired": 0 },
  "needs_action": 1,
  "low_stock_products": [{ "id": 20, "slug": "mogiana-natural", "name": "Mogiana Natural", "stock": 2, "roaster_name": "Volcano Coffee Works" }],
  "today": { "date": "2026-11-25", "timezone": "UTC", "orders": 1, "paid_orders": 1, "revenue_pence": 2500 }
}
```

- `needs_action`: orders that are `paid`, `preparing`, `ready_for_collection` or `out_for_delivery`.
- `low_stock_products`: active products with 3 or fewer left (including sold out).
- `today`: orders created today (UTC day). `revenue_pence` adds up the totals of today's orders that are paid and not cancelled, refunded or expired.

---

## Order status transitions

| Status | Meaning |
|--------|---------|
| `pending_payment` | Order created, stock reserved, waiting for payment (30 minutes). |
| `paid` | Payment confirmed. Waiting for the roaster to start. |
| `preparing` | Being packed. |
| `ready_for_collection` | Collection orders: ready at the roastery. |
| `out_for_delivery` | Delivery orders: on its way. |
| `completed` | Collected or delivered. |
| `cancelled` | Stopped before completion. Stock was put back. |
| `refunded` | Money returned to the customer. |
| `expired` | Never paid within the time limit. Stock was put back. |

Allowed moves (anything not listed is refused with `409 invalid_transition`):

| From | To | Who | Stock |
|------|----|-----|-------|
| `pending_payment` | `paid` | payment provider only (never an admin) | stays reserved |
| `pending_payment` | `cancelled` | admin, or a failed payment | restored |
| `pending_payment` | `expired` | automatic sweep, 30 minutes after creation | restored |
| `paid` | `preparing` | admin | |
| `paid` | `cancelled` | admin | restored |
| `paid` | `refunded` | admin | not restored |
| `preparing` | `ready_for_collection` | admin, collection orders only | |
| `preparing` | `out_for_delivery` | admin, delivery orders only | |
| `preparing` | `cancelled` | admin | restored |
| `preparing` | `refunded` | admin | not restored |
| `ready_for_collection` | `completed` | admin | |
| `ready_for_collection` | `cancelled` | admin | restored |
| `ready_for_collection` | `refunded` | admin | not restored |
| `out_for_delivery` | `completed` | admin | |
| `out_for_delivery` | `cancelled` | admin | restored |
| `out_for_delivery` | `refunded` | admin | not restored |
| `completed` | `refunded` | admin | not restored |
| `cancelled` | `refunded` | admin, only if the order had been paid | already restored; not added again |
| `refunded`, `expired` | (none) | | |

Notes:

- `cancelled` and `refunded` record what happened; **they do not move money**. Refund the customer at the payment provider, then set the status. To cancel a paid order and return the goods to stock, use `cancelled` and then `refunded`. Use `refunded` directly when the coffee is not coming back (already sent, damaged).
- The expiry sweep runs when the server starts and every minute after.
- The demo payment page's "Pay" button counts as the payment provider.

---

## Rate limits

Counted per IP address in the server's memory. Over the limit: `429 rate_limited` with a `retry-after` header.

| What | Default | Environment variable |
|------|---------|----------------------|
| Everything | 300 per minute per IP | `RATE_LIMIT_GLOBAL_MAX` |
| `POST /api/admin/login` | 5 per 15 minutes per IP + email | `RATE_LIMIT_LOGIN_MAX` |
| `POST /api/checkout` | 10 per minute per IP | `RATE_LIMIT_CHECKOUT_MAX` |
| `POST /api/subscribe` | 5 per hour per IP | `RATE_LIMIT_SUBSCRIBE_MAX` |
| `POST /api/admin/password` | 10 per 15 minutes per IP | (fixed) |

Responses include `x-ratelimit-limit`, `x-ratelimit-remaining` and `x-ratelimit-reset`. A page that fires many requests at once (for example one quote per keystroke) should debounce.
