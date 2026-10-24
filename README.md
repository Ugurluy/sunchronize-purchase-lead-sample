# Sunchronize: `purchaseLead` (one request, end to end)

Sunchronize is live on iOS, a product I co-founded and develop: a Flutter app for solar panel owners plus a Firebase backend (Cloud Functions in TypeScript, Firestore). Panel owners request a cleaning; the request becomes a **lead** for a cleaning company. The company spends **one credit** to unlock the lead and contact the customer.

This folder is the backend for that single flow, copied from the real repository. Files marked "Excerpt" contain only the parts this flow uses, and the project IDs in `auth.ts:16–17` are placeholders. Below, each of the 9 task items is mapped to the code.

## Where the request comes in and where the response goes out

| | File | Line |
|---|---|---|
| Request any client sends | `POST purchaseLead` with `Authorization: Bearer <Firebase ID token>` and body `{"leadId": "..."}`. In production this is the Flutter app (not included). | — |
| **Request comes in** | `functions/src/leads/leads.ts` | 10 `export const purchaseLead = onRequest(...)` |
| **Response goes out** | `functions/src/leads/leads.ts` | 216 (credit taken, or already unlocked inside the transaction), 102 / 128 (already unlocked / demo), 223–232 (errors) |

## Request and response

```bash
curl -X POST "$PURCHASE_LEAD_URL" \
  -H "Authorization: Bearer $FIREBASE_ID_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"leadId": "AbC123xyz"}'
```

`$PURCHASE_LEAD_URL` is the deployed function's HTTPS URL; `$FIREBASE_ID_TOKEN` is the token the Firebase Auth SDK gives a signed-in user.

Every response the function can return (`functions/src/leads/leads.ts`):

| Status | Body | When | Line |
|---|---|---|---|
| 200 | `{ ok: true, status: "unlocked", leadId, creditsRemaining, demoActive: false }` | One credit taken, lead unlocked | 216 |
| 200 | `{ ok: true, status: "already_unlocked", leadId, creditsRemaining, demoActive }` | Lead was already unlocked before the transaction; nothing charged | 102 |
| 200 | `{ ok: true, status: "already_unlocked", leadId, creditsRemaining, demoActive: false }` | A concurrent request unlocked the lead inside the transaction; nothing charged | 216 |
| 200 | `{ ok: true, status: "demo_unlocked", leadId, creditsRemaining, demoActive: true, demoExpiresAt }` | Company is in a demo period; nothing charged | 128 |
| 400 | `{ error: "missing_leadId" }` | No `leadId`, or not a string | 56 |
| 400 | `{ error: "invalid_leadId" }` | `leadId` is not a plain document ID | 60 |
| 401 | `{ error: "unauthorized" }` | Missing or invalid ID token | 31 |
| 402 | `{ ok: false, error: "no_credits", creditsRemaining, demoActive: false }` | Balance is 0 before the transaction | 140 |
| 402 | `{ ok: false, error: "no_credits" }` | Balance reached 0 inside the transaction | 227 |
| 403 | `{ error: "forbidden_origin" }` | Browser origin not on the allowed list | 24 |
| 403 | `{ error: "forbidden_role" }` | Role claim is present and is not company or admin | 44 |
| 403 | `{ error: "not_company" }` | No company document for this user | 70 |
| 403 | `{ error: "not_your_lead" }` | Lead belongs to another company | 93 |
| 404 | `{ error: "lead_not_found" }` | No lead with this ID | 86 |
| 405 | `{ error: "method_not_allowed" }` | Not a POST | 19 |
| 429 | `{ error: "too_many_requests" }` | More than one call per 2 s from this user | 37 |
| 500 | `{ ok: false, error: "server_error" }` | Anything else (no internal details) | 231 |

## The path of one request (`functions/src/leads/leads.ts`)

1. 18–26: only POST (405) and only known browser origins (403).
2. 29–33: verify the Firebase ID token → 401 if missing or invalid.
3. 35–39: throttle, one call per 2 s per user → 429.
4. 41–46: a role claim other than company or admin → 403. A token with no role claim passes here and is stopped at step 6 if the user has no company document.
5. 48–62: `leadId` must be present and a plain document ID (letters, digits, `_`, `-`) → 400.
6. 64–95: read the company (403 if none) and the lead (404 if none, 403 if it belongs to another company).
7. 97–147: already unlocked → 200; demo period → unlock for free; no credits → 402.
8. 149–214: **transaction**: re-read both documents, re-check ownership and the unlock state, take one credit, unlock the lead, write the audit entry. All or nothing. Returns `{ charged, creditsRemaining }`.
9. 216–222: return the balance read inside the transaction. Status is `"unlocked"` only when a credit was taken, otherwise `"already_unlocked"`.
10. 223–232: log the error, map `no_credits` to 402, everything else to 500.

## Endpoints and how each is protected

| Surface | Who can call it | Protection |
|---|---|---|
| `POST purchaseLead` (HTTPS function) | Anyone on the internet | Firebase ID token (`auth.ts:42`), role claim (`leads.ts:41–46`), company doc must exist (`leads.ts:69`), lead must belong to the caller (`leads.ts:92`, re-checked in the transaction at `:166`), per-user throttle (`auth.ts:68`) |
| Firestore `companies/{id}` from the app | Signed-in users | `firestore.rules:9–39`; clients can never change `credits` (`:17`, `:25`) |
| Firestore `leads/{id}` from the app | Signed-in users | `firestore.rules:45–106`; clients can never change `revealed`, `unlockedBy`, `purchasedAt` (`:103–105`) |

The function uses the Admin SDK, which bypasses the rules by design; the rules are what stop the app from granting itself credits or unlocking a lead directly.

## How to run the tests

Requirements: Node 22, Java 21+ and the Firebase CLI (`npm i -g firebase-tools`).

```bash
cd functions
npm install
npm test
```

`npm test` compiles the TypeScript and runs `test/purchase_lead.test.js` against the local Firestore and Auth emulators, with a `demo-` project, so no credentials or internet access to Firebase are needed.

| Test | What it proves |
|---|---|
| `test/purchase_lead.test.js:75` | 0 credits → 402 `no_credits`, the lead stays locked, no audit entry |
| `:86` | A lead addressed to another company → 403, the caller is not charged |
| `:101` | Unknown lead → 404 |
| `:110` | A `leadId` such as `x/y` → 400 `invalid_leadId` before any database read |
| `:119` | Success takes exactly one credit, a repeat call does not charge again, and exactly one audit entry with balance 3 → 2 exists |
| `:147` | A lead already unlocked by this company → 200 `already_unlocked`, `creditsRemaining` is the current balance, nothing charged, no audit entry |

Not covered: two calls at the same instant. The throttle answers the second with 429 before it reaches the transaction, so the `charged: false` branch (`leads.ts:169–171`) is not exercised. The test at `:147` covers the pre-check at `:101`.

## Where to find each of the 9 required task items

1. **Error handling**: early returns with specific codes (`leads.ts:18–147`, full list in "Request and response"); one try/catch (`leads.ts:28`, `:223–232`). Of the errors thrown inside the transaction (`:154`, `:157`, `:167`, `:174`), only `no_credits` is mapped to 402 (`:226`). The others return 500 `server_error` with no internal details.
2. **Error logging**: Cloud Logging via `firebase-functions/logger`: `leads.ts:36`, `:43` (user ID, role), `:224` (error message only). Never logged: the token, the request body, emails, customer contact details. Business audit trail: `credits.ts:46–70`.
3. **Clean code**: descriptive names, early returns, stable error codes the app switches on. I'll walk through what I would clean up in the interview.
4. **Database credentials**: `functions/src/index.ts:4` `initializeApp()` with no arguments: the Admin SDK uses the Cloud Functions service account (Application Default Credentials). No key file exists in the repository. The only config value, `ADMIN_UIDS` (`auth.ts:5`, not used by this flow), is a deploy-time parameter read from a `.env` file, which is gitignored (`.gitignore:4–5`). This flow uses no secrets.
5. **Login and permissions**: there is no password check on my server because Firebase Auth stores and verifies passwords. The server verifies the signed ID token on each request (`auth.ts:42`): signature, expiry, audience, issuer. The company is identified from the token (`leads.ts:65`), never from the request body. Permissions: role claim (`:41–46`), company document exists (`:69`), lead ownership (`:92`, again inside the transaction at `:166`), credits checked inside the transaction (`:173`). Note: users choose `company` or `customer` themselves at signup (a separate function, not included), so the role claim is a coarse filter; ownership and credits are the real checks.
6. **Object-oriented design**: mostly does not apply: the backend is functions in modules, not classes. Layers: handler (`leads.ts`), shared auth helpers (`auth.ts`), credit audit (`credits.ts`), status constants (`lead_statuses.ts`). Shared helpers are reused by other handlers in the real repo, which is how duplication is avoided across endpoints. In the app (not included), one HTTP client class adds the ID token to every request so no screen handles tokens itself.
7. **Authentication and authorization**: see the endpoints table. The origin check (`auth.ts:63–66`) is not a security control: requests without an `Origin` header pass, so it only filters browsers.
8. **Database access**: Firestore, not SQL, so there are no query strings to inject into. Documents are addressed with `.doc(id)`, and because a `/` in an ID would change which path is read, `leadId` is checked against `^[A-Za-z0-9_-]{1,128}$` first (`leads.ts:59–62`). The transaction is `runTransaction` (`leads.ts:149–214`): all reads come before the writes, and Firestore may run the callback again on a conflict, so the callback only reads and queues writes (no response, no logging). Client access control lives in `firestore.rules`. In SQL I would use prepared statements (`UPDATE companies SET credits = credits - 1 WHERE id = $1 AND credits > 0`), insert the audit row and update the lead inside `BEGIN … COMMIT`, and treat 0 affected rows as "no credits".
9. **General good practice**: emulator tests above; input validation is the leadId presence and format check (leads.ts:55–62). Dependencies: npm audit --omit=dev reports 10 issues (3 high). I checked each against how this code uses the library: the node-forge and uuid issues are not reachable here (node-forge only parses the service-account key; uuid is only called as v4() without a buffer). The body-parser denial-of-service issue comes through express in firebase-functions, which is not used to serve requests in a deployed function (the platform’s Functions Framework does that), and it has a non-breaking fix via npm audit fix. The firebase-admin 12 → 14 upgrade is a major version that I would do in its own change. Deploy in the real repo: GitLab CI deploys main after building; it does not yet run tests or lint. I would add test and lint stages, require a reviewed merge request, and deploy to a staging project first.