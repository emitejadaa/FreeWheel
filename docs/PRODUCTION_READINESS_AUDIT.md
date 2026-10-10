# Production Readiness Audit — FreeWheel backend

Date: 2026-10-10 · Branch: `claude/production-readiness-audit` · Scope: everything
under `src/`, `api/`, `scripts/`, `prisma/`, `test/`, CI/deploy configuration and
the Python `docverify-api/` service.

This document has three parts, kept separate on purpose:

- **Part A — Security findings**
- **Part B — Correctness and production-readiness findings**
- **Part C — Code quality and maintainability findings**

Every finding has a status: **Fixed** (changed on this branch, with a test where
the behavior is testable), **Documented** (a decision or a change that needs an
owner outside this branch) or **Accepted** (intentional, explained).

---

## 0. Method and baseline

What was run before touching anything:

| Check | Command | Baseline result |
| --- | --- | --- |
| Type check | `npx tsc --noEmit` | clean |
| Build | `npm run build` | clean |
| Lint (src + scripts) | `eslint "{src,apps,libs,scripts}/**/*.ts"` | 0 errors, 1 warning (floating promise in a spec) |
| Lint (test + api) | `eslint "test/**/*.ts" api/index.ts` | 417 errors, 107 warnings (all `no-unsafe-*` on supertest bodies; not covered by `npm run lint`) |
| Format | `prettier --check` | 10 files off (9 under `test/`, `api/index.ts`) |
| Unit + e2e | `npm test` against a disposable Postgres 16 | 701/702 pass once `PAYMENTS_PROVIDER=mock` (see B8); 1 environment-dependent failure (see B9) |
| Dependencies | `npm audit --omit=dev` | 9 advisories (1 critical, 6 high) |
| Secrets | `git grep` + history search for live keys / DSNs with passwords | nothing found |

Static analysis for dead code was done with a reference scan (every exported
symbol and every public service method, searched across `src`, `test`, `scripts`
and `api`), then each hit was confirmed by hand — including dependency
injection, dynamic access and script usage — before removal.

### Architecture map

- **Entry points.** `api/index.ts` (Vercel function) and `src/main.ts` (local /
  long-running) both call `createServer()` in `src/app.factory.ts`, which builds
  Express (helmet, CORS, raw body for the Stripe webhook, JSON parser), boots
  Nest lazily on the first request and caches it. `configureApp()` holds the
  pipes/filters shared with the e2e harness.
- **Modules (NestJS, one folder per domain).** auth, users, vehicles, listings
  (+ price change), availability, bookings, payments (+ money/ pure policy,
  providers/ Stripe·mock·unconfigured), ledger (double-entry), contracts (PDF),
  claims (damage claims), reviews, reports, favorites, conversations, media
  (Cloudinary), verification (email/phone codes + identity documents via the
  Python reader), vehicle-verification, admin, ai (Groq proxy), email (Gmail
  SMTP), sms, health, retention (PII purge), jobs (daily cron), common (guards,
  rate limit, crypto, filters, utils), prisma.
- **Data.** PostgreSQL through Prisma 6; migrations in `prisma/migrations`,
  pre-push fixes in `prisma/premigrate`, applied on deploy by
  `scripts/deploy-migrate.js` (postinstall on Vercel).
- **Background work.** One Vercel cron (`GET /internal/cron/daily`, guarded by
  `CRON_SECRET`): expires unanswered damage claims, settles bookings whose
  inspection window closed, retries owner payouts, purges expired document
  photos.
- **External services.** Stripe (test mode only, guarded), Cloudinary, Gmail
  SMTP, Twilio (optional), Groq, the `docverify-api` Python service (async,
  callback with a single-use token).

Overall the codebase is in good shape: strict TypeScript with no `any`, no
lint/type suppressions, server-side money math, a double-entry ledger,
persistent rate limiting, field encryption, signed Stripe webhooks, consistent
ownership helpers and a large e2e suite. The findings below are the gaps that
remained.

---

## Part A — Security findings

| ID | Severity | Area | Finding | Status |
| --- | --- | --- | --- | --- |
| A1 | High | `POST /ai/transcribe` | **SSRF.** Any logged-in user could make the server `fetch()` an arbitrary `http(s)` URL (internal hosts, metadata endpoints) and the whole body was buffered before the 20 MB size check. | Fixed |
| A2 | High | `POST /media/assets` | **Broken object-level authorization.** Any logged-in user could register a `VEHICLE_PHOTO` with `entityType: "vehicle"` and *another user's* `entityId`; listings, favorites and bookings then showed the attacker's (arbitrary-URL) image on the victim's public listing. | Fixed |
| A3 | Medium | `EmailService` | **HTML injection in transactional email.** Display names, vehicle brand/model, cancellation reasons and admin notes were interpolated into email HTML unescaped, so a user could inject links/markup into mail sent by FreeWheel to the counterparty (phishing from a trusted sender). | Fixed |
| A4 | Medium | `consumeVerificationCode`, pending registration | **Attempt limit bypass by concurrency.** The `attempts < maxAttempts` check and the increment were separate statements, so N parallel guesses all passed the check. Bounded by route rate limits, but the per-code limit was not a real limit. | Fixed |
| A5 | Medium | `VerificationService` | `VERIFICATION_CODE_IN_RESPONSE=true` (with the default mock SMS provider) returned the phone code in the HTTP response in any environment, including production — phone verification without owning the phone. | Fixed (refused when `NODE_ENV=production`) |
| A6 | Medium | `POST /ai/chat` (public) | No bound on the `messages` array or its size: an anonymous caller could push very large prompts through our Groq key (cost abuse). | Fixed (max 40 messages, 48 000 serialized chars) |
| A7 | Medium | `app.factory.ts` final error handler | Errors raised before Nest (malformed JSON, oversized body) were answered **503 `API_NO_DISPONIBLE`** with the parser's message, and Nest bootstrap failures returned their raw message (which for Prisma includes the DB host) to any client. | Fixed (4xx parser errors keep their status with a generic message; bootstrap details only outside production, with an `errorId` to find the log line) |
| A8 | Low | `AdminBootstrapService` | `ADMIN_EMAILS` promoted matching accounts even if the email was never verified (legacy accounts). | Fixed (requires `emailVerifiedAt`) |
| A9 | Medium | `npm audit` (production deps) | Critical `proxy-addr` (IP spoofing via IPv4-mapped trust subnet), high `multer` (via `@nestjs/platform-express`), moderate `body-parser`/`qs`. | Fixed with `npm audit fix`, lockfile only, all within the ranges in `package.json` (`proxy-addr` 2.0.8, `@nestjs/platform-express` 11.2.7 → `multer` 2.4.0, `body-parser` 2.3.0, `qs` 6.16.0, `nodemailer` 8.0.11). See A10 for the rest. |
| A10 | Medium | `nodemailer` 8.x | 11 advisories, fixed only in 10.x (major). The app only uses `createTransport({ service: "gmail" })` + `sendMail` with server-built HTML and validated recipients, so the reachable surface is small. | Documented — upgrade to 10.x in its own change and smoke-test real delivery. `deepmerge-ts` (via the Prisma CLI config loader) is build-time only. |
| A11 | Medium | Google OAuth callback | The session JWT is delivered in the **query string** (`/auth/google/callback?token=…`), so it can land in browser history, proxy/CDN logs and `Referer`. | Documented — needs a coordinated front-end change (URL fragment or one-time code exchange). |
| A12 | Low | `GET /health/env` (public) | Reveals which protections are configured (encryption key, cron secret, CORS mode, admin count). Values are never exposed, but it is reconnaissance data. | Accepted for now (it is the operators' only window into the deploy). Recommend gating it behind an admin JWT or a token in production. |
| A13 | Low | CORS | Without `CORS_ORIGINS`, strict mode also accepts any `*.vercel.app` origin, and production defaults to `report-only` (allow + log). Tokens travel in `Authorization`, so this mainly protects the public AI routes' quota. | Documented — set `CORS_ORIGINS` and `CORS_STRICT=true` once the report-only log is clean. |
| A14 | Low | Logging | Login failures, registrations and password-reset requests log the email address in clear text. | Documented — mask or hash emails in logs if logs leave the EU/AR jurisdiction or are shared. |
| A15 | Low | `docverify-api` (Python) | Without `DOCVERIFY_TOKEN` the service accepts anyone and posts results to any caller-supplied `callback_url` (SSRF from that host). Intentional for the local demo page. | Documented — always set `DOCVERIFY_TOKEN` on any reachable deployment. |
| A16 | Info | `POST /media/assets` | Asset URLs are any `https` URL (not restricted to our Cloudinary cloud). After A2 only the owner can attach them to their own vehicle, so the remaining risk is an owner linking external images in their own listing. | Documented |

Verified as sound (no change needed): JWT algorithm pinned to HS256 on sign and
verify; production refuses missing/example/short `JWT_SECRET`; tokens issued
before a password change are revoked; login lockout + constant-time responses;
Stripe webhook signature verified on the raw body and live-mode events refused
in test deploys; mock payments refused in production; cron endpoint uses a
constant-time secret comparison and fails closed; identity documents are
`authenticated` Cloudinary assets with server-built `public_id`s; analysis
callback uses a hashed single-use token; field encryption is AES-256-GCM with
key rotation; ownership checks on every mutation route; admin self-review is
forbidden on money and verification decisions; Prisma queries are parameterized
(the only raw SQL uses tagged templates).

---

## Part B — Correctness and production-readiness findings

| ID | Severity | Area | Finding | Status |
| --- | --- | --- | --- | --- |
| B1 | High | Stripe webhook | **Events lost after a failed processing attempt.** The `StripeEvent` row (the dedup key) was inserted *before* processing. If processing threw, Stripe retried, the retry hit the unique key and was answered `duplicate: true` — the event was never applied (refunds, disputes and `account.updated` have no other recovery path). A crash mid-processing had the same effect. | Fixed — the claim is released when processing fails, and a claim left unprocessed for 10 minutes can be retaken. |
| B2 | High | `PaymentsService.payOwner` | **Double payout under concurrency.** The transfer's idempotency key was built from the caller's reference (`settle:<booking>`, `retry:<owner>:<amount>`), so two settlements of the same owner running together (two parties pressing "settle" on two bookings, or a settle racing the daily cron) each transferred the *whole* owed balance. | Fixed — the key is derived from the ledger state (owner, owed balance and number of entries in the owner's payable account, read in one query, plus the UTC day), and the request no longer carries the caller's reference, so concurrent attempts send identical requests and collapse into one Stripe transfer; a duplicate ledger posting no longer writes a second payout record. |
| B3 | Medium | `BookingsService` state machine | Transitions were read-check-write: concurrent requests could apply the same transition twice (e.g. two `accept`s regenerate the QR codes and the first response returns a dead code) and two overlapping requests accepted at the same time could **double-book** a car. | Fixed — `accept`, `reject`, `ready-for-pickup`, `confirm-pickup` and `confirm-return` are conditional updates (409 `BOOKING_STATE_CHANGED` when they lose); `accept` takes a per-listing advisory transaction lock while it re-checks availability. |
| B4 | Medium | Malformed requests | Malformed JSON → 503, oversized body → 503 (see A7). Monitoring counted client mistakes as outages. | Fixed (400 / 413) |
| B5 | Low | `GET /payments/bookings/:id/ledger` | The admin branch (`isAdmin` adds IP/UA/payload) was unreachable for admins who are not a party to the booking (participant check ran first → 403). | Fixed |
| B6 | Low | Bookings vs listings photos | Booking cards ordered vehicle photos by upload time, listings by the owner's chosen order, so the cover photo differed between "My bookings" and the listing. | Fixed — bookings reuse `ListingsService.getPhotosByVehicleIds`. |
| B7 | Low | Cancellation refunds | When the refund fails, the booking is cancelled anyway and the response says "Lo reintentamos", but no job retries failed cancellation refunds (`settledAt` stays null). | Documented — needs a product decision (cron retry vs. admin queue). |
| B8 | Low | `.env.test.example` | Set `PAYMENTS_PROVIDER="stripe"` while CI uses `mock`; a fresh local setup failed 31 e2e tests with 503s. | Fixed |
| B9 | Low | Client IP | Socket addresses came back as `::ffff:127.0.0.1` or `127.0.0.1` depending on the host stack, so the stored `initiatedIp` and one e2e assertion were environment-dependent. | Fixed — `clientIp()` normalizes IPv4-mapped IPv6. |
| B10 | Low | `onIntentFailed` | A failed `CHECKOUT` intent marks the payment record `FAILED` but leaves `booking.paymentStatus` at `PENDING` (only legacy `SENA`/`BALANCE` flip it). Possibly intentional (the renter retries on the same booking). | Documented — confirm intended UX. |
| B11 | Low | Scalability | Admin lists (`/admin/users`, `/admin/listings`, `/admin/bookings`) and conversation messages are unpaginated. | Documented |
| B12 | Low | `onChargeRefunded` | A full refund of *any* record (e.g. a captured deposit) marks the whole booking `REFUNDED`. | Documented |
| B13 | Low | Rate limiting | The in-memory throttler keyed on the raw IP while the persistent limiter groups IPv6 by /64. | Fixed — both use `ipRateLimitKey()` (moved to `client-ip.util.ts`, now unit-tested). |
| B14 | Low | `BookingsService.cancel` | Still read-check-write: money is distributed first, then the status is written. A concurrent double cancel is money-safe (Stripe idempotency keys and ledger keys dedupe the refund and the postings) but can write a duplicate `REFUND` record row and send the emails twice. Making it conditional needs the claim-before-refund ordering decided together with B7. | Documented |

---

## Part C — Code quality and maintainability findings

### C1. Unused or obsolete code (removed — every item confirmed unreferenced, including DI, scripts and tests)

| Item | Why it was dead |
| --- | --- |
| `src/common/utils/with-timeout.util.ts` | No importer. |
| `IsArgentinePhone` decorator | Superseded by `IsPhone` (`phone.validator.ts`); never applied. |
| `corsEstricto()` | Comment claimed it served the env report and tests; neither uses it. |
| `VERIFICATION_REASON_CODES`, `reasonAction()`, `PROBLEMAS_NUESTROS` | Never read; `PROBLEMAS_NUESTROS` documented behavior the code does not consult. |
| `MediaService.createPresignedUpload()` | Stub that only threw `NotImplemented`; no route. |
| `PaymentsService.refundOnCancel()` | "Keeps the old name" alias with no caller. |
| `EncryptionService.isEncrypted()`, `blindIndex()` (+ derived `indexKey`) | No caller; vehicle plates are deduplicated with an advisory lock instead. |
| `UsersService.create()` | No caller (registration writes through Prisma in a transaction). |
| `AppService` ("Hello World!") | Framework placeholder; `GET /` stays (scripts and tests use it as liveness) and answers from the controller. |
| `STRIPE_API_VERSION`, `STRIPE_CONNECT_ENABLED` | Documented in `.env.example`, CI and `env-check` but never read. |
| `IDENTITY_REVIEW_MODE`, `IDENTITY_REVIEW_TIMEOUT_MS` in `env-check` | Obsolete flow; made `npm run check:env` report them as missing. |
| `test:functional:deployed` script | Identical to `test:functional`. |

### C2. Redundancy

- **Fixed:** the user → request-payload mapping was duplicated in both JWT
  strategies (now `UsersService.toCurrentUser()`, next to `toSafeUser()`). Booking photo lookup duplicated the listings query with a different
  order (B6). Client-IP keying lived in the rate-limit guard while the throttler
  used another rule (B13).
- **Documented:** person-name / vehicle-label formatting is implemented four
  times (`BookingsService`, `PaymentsService` ×2 inline, `ClaimsService`) with
  slightly different fallbacks; `AvailabilityService.assertListingOwner` /
  `findListing` duplicate `assertOwner` / `assertFound`. Consolidating them
  touches user-visible email text, so it was left for a change that can be
  reviewed with the copy.

### C3. Files and responsibilities

The folder layout is coherent (one Nest module per domain, DTOs under `dto/`,
pure policy code next to its service, e.g. `payments/money/`,
`bookings/cancellation-policy.ts`). The weak spot is size:

| File | Lines | Notes |
| --- | --- | --- |
| `payments/payments.service.ts` | ~3 000 | Intents, webhook handlers, settlement, payouts, refunds, cancellation, ledger admin, Connect onboarding and notification email in one class. |
| `verification/identity/document-verification.service.ts` | ~1 560 | Submission, analysis request/callback, admin review, account status. |
| `email/email.service.ts` | ~1 120 | 18 templates. |
| `vehicle-verification/vehicle-verification.service.ts` | ~1 040 | |

Recommended split for `PaymentsService` along existing seams (each already has
its own section header): `PaymentWebhookHandler` (dispatch + `on*` handlers),
`SettlementService` (settle, payOwner, retryPendingPayouts, captureDamage,
release), `CancellationSettlementService` (cancelAndSettle, refundRenter),
leaving intents/status in `PaymentsService`. **Deliberately not done here**: it
is the money path, the split is a large diff, and it should land on its own with
the e2e payment suite as the safety net.

Reorganized on this branch: the Express-level error handler moved out of
`app.factory.ts` into `src/common/filters/express-error.handler.ts`, next to
`AllExceptionsFilter`, so all error-to-response mapping lives in one folder; IP
normalization and rate-limit keying moved from the rate-limit guard into
`src/common/utils/client-ip.util.ts`.

### C4. Naming and comments

- Identifiers mix Spanish and English inside the same files
  (`registrarLoginFallido`, `claveDeIp`, `findBookingWithUsers`). Renaming is
  pure churn with merge-conflict cost, so it is **documented, not changed**;
  new code should follow the language of the file it lives in.
- Comments are long and narrative. Most explain *why* (security reasoning,
  legal constraints, incidents) and are worth keeping. Outdated or misleading
  ones were fixed where found: `UsersModule` (mentioned a removed service and
  field), `sinDevolverStatuses` and the return flow (returns now go to
  `INSPECTION`, not `COMPLETED`), `PricingService` (owners are paid at
  settlement, and the insurance belongs to the insurer), the VERIFIED criteria
  in `@RequireVerifiedAccount` and `BookingsController`, the e2e harness
  (claimed the backend never reads documents), Prisma `DamageClaimStatus`
  (duplicated doc line).

### C5. Documentation and configuration drift

- `README.md` described CORS as wide open, payments as mock-only, the old
  vercel.json `builds` format, a JWT secret fallback that production now
  refuses, a 24h token default (code: 7d), "the backend never calls the document
  reader" (it does, with a callback), the two-step deposit/balance payment and a
  return that completes the booking (it opens a 48h inspection window). Fixed.
- `backend.md` "Riesgos conocidos" / "Estado" / "Pendientes" listed issues that
  are already solved (JWT fallback, open CORS, missing auth rate limits, plain QR
  previews) and missed the current ones. Those sections now point here.
  The rest of `backend.md` (2 000 lines of module-by-module reference) was not
  re-verified line by line — **documented** as remaining debt.
- `.gitignore` excluded `docs/` and every `*.md`; this file is whitelisted.
  `!VARIABLES-VERCEL.md` whitelists a file that does not exist.

### C6. Type safety and tooling

- No `any`, no `@ts-ignore`, no `eslint-disable` in TypeScript. Good.
- The one baseline lint warning (floating promise in
  `google-auth.guard.spec.ts`) is fixed; Prettier now passes on `src`, `test`,
  `scripts` and `api` (one formatting-only commit).
- `npm run lint` only covers `src` and `scripts` and runs with `--fix`; `test/`
  has 411 `no-unsafe-*` errors (417 at baseline; untyped supertest bodies)
  that nobody sees.
  **Documented**: either type the response bodies in the helpers or relax
  `no-unsafe-*` for `test/**` explicitly — do not leave it silently unlinted.
- `prisma/schema.prisma` has `@@index([email])` on `User`, redundant with
  `@unique`. Needs a migration; **documented**.

### C7. Testing

- **Added:** 26 regression tests — A1/A6 (`test/ai.e2e-spec.ts`), A2
  (`test/listings.e2e-spec.ts`), A3 (`email.service.spec.ts`), A4 (two
  concurrency tests in `test/auth.e2e-spec.ts`), A5
  (`verification.service.spec.ts`), A7/B4 (`express-error.handler.spec.ts`),
  A8 (`admin-bootstrap.service.spec.ts`), B1 and B2 and B5
  (`test/payments.e2e-spec.ts`), B3 and B6 (`test/bookings.e2e-spec.ts`), B9/B13
  (`client-ip.util.spec.ts`). The concurrency and money-path tests (A4, B1, B2,
  B3) were run against the previous implementation and fail there (e.g. B2:
  the owner ends up paid three times for one debt), so they guard the actual
  defect, not the new code's shape.
- `listeningServer()` was added to `test/helpers/app.ts`: supertest re-listens
  the server per request, and parallel requests on an idle server reset each
  other (`ECONNRESET`).
- Gaps that remain (documented): the Express-level stack in `createServer()`
  (helmet, CORS, parsers, lazy boot) is not exercised by the e2e harness, which
  builds a plain Nest app via `configureApp()`; the daily cron end-to-end is
  only unit-tested; `docverify-api/` has no tests.

---

## Remaining risks and recommended next steps (ordered)

1. A11 — move the OAuth token out of the query string (needs the front end).
2. A10 — upgrade `nodemailer` to 10.x in its own change.
3. B7 — decide how failed cancellation refunds are retried.
4. A13 — turn CORS strict once the report-only log shows only known origins.
5. C3 — split `PaymentsService` along the seams above.
6. C6 — bring `test/` under lint.
7. A12 — gate `/health/env` in production.

## Verification log

Run on the final tree of this branch, against a disposable Postgres 16:

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` (src) and `-p test/tsconfig.json` | clean |
| `npm run build` | clean |
| `eslint "{src,apps,libs,scripts}/**/*.ts" api/index.ts` | 0 errors, 0 warnings |
| `prettier --check` src, test, scripts, api | clean |
| `npm test` (unit + e2e, `--runInBand`) | **57 suites, 728 tests, all passing** (baseline: 702, one failing) |
| `prisma validate` | valid |
| `npm run check:env` | no variables reported missing (baseline reported 2 obsolete ones) |
| `npm audit --omit=dev` | 4 high left: `nodemailer` (A10) and `deepmerge-ts` via the Prisma CLI |
| Manual probe of `createServer()` | malformed JSON → 400 `INVALID_JSON`; 9 MB body → 413 `PAYLOAD_TOO_LARGE` (both were 503) |

Behavior and contract notes for reviewers:

- New error responses: 409 `BOOKING_STATE_CHANGED` (lost a concurrent booking
  transition), 400 `INVALID_JSON` / 413 `PAYLOAD_TOO_LARGE` (were 503),
  400 on `/ai/transcribe` for non-Cloudinary URLs, 400 on `/ai/chat` beyond 40
  messages or 48 000 characters, 403/404 on `POST /media/assets` for someone
  else's or a missing vehicle.
- `GET /` now answers `{ "name": "FreeWheel API", "status": "ok" }` instead of
  the string `Hello World!` (every known caller only checks the 200).
- In production the 503 for a failed boot returns `errorId` + `at` instead of
  the raw error message.
- A correct verification code now also counts as one attempt (it is reserved
  before comparing); sequential behavior is unchanged (5 attempts per code).
- No database schema change and no migration on this branch (the only edit to
  `schema.prisma` is a duplicated `///` doc line).
