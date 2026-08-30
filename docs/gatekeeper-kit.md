# Implementation Plan: Gatekeeper Kit (`@gadgets/gatekeeper-kit`)

This is the implementation plan for the gatekeeper kit: a workspace library that lets a new
gatekeeper be written as a TypeScript spec plus service-specific sessions, instead of ~400–500
lines of hand-copied plumbing.

**Status.** Layer 1 (§4, the leaf modules) has landed, and its §4 sections are reconciled against
the shipped signatures — where the two ever disagree, the code and its tests win. Layer 2 (§5, the
assembly) and §7 steps 8–16 are still proposal: nothing consumes the kit yet, so no gatekeeper has
been ported and none of §5's ergonomics have met a real consumer. Two things to read before writing
either: §4.8's key-layout tables and port-time obligations, before pointing the journal at any
existing gatekeeper's keys; and §5.6's credential-projection requirement, which is a capability
boundary the whole corpus holds and the assembly could quietly drop.

## 1. Introduction & high-level intent

Every OAuth gatekeeper in this repo repeats the same block of code with the provider's name
swapped in: the browser-facing fetch handler that drives the OAuth redirect dance, a `UserAccount`
Durable Object holding a two-stage nonce machine and token storage, a `GatekeeperVendor`
entrypoint, a `GatekeeperUser` entrypoint that maps resource URLs to facet classes, verifier
minting, configurator dispatch, a pending-action store, and observer bookkeeping. Compare
`packages/gatekeeper-github/src/github.ts:931-1333` with
`packages/gatekeeper-supabase/src/supabase.ts:267-672`: the two are the same machine. The
security-critical parts (nonce lifecycle, approval-queue ordering, observer admission) are exactly
the parts a new gatekeeper author is most likely to get subtly wrong.

The kit is one new workspace package, `packages/gatekeeper-kit`, with **two strictly separated
layers**:

- **Layer 1 — leaf modules.** Small, standalone primitives behind per-file subpath exports:
  connect nonces and the two-stage handshake, browser status pages, a credential-expiry latch,
  HTTP error classification, credential storage with refresh coalescing, observer strategies, a
  durable action journal, pure simulation helpers, a TTL cache, and RPC cursors. Each is usable on
  its own; none requires the assembly layer.
- **Layer 2 — the assembly.** A `gatekeeperKit<Env, Creds, Exports>()` factory producing a typed
  spec (`define`, `resource`), pluggable auth strategies (`oauth2`, `tokenAuth`, or a hand-written
  `AuthStrategy`), an HTTP handler, and four abstract base classes (`KitVendorBase`,
  `KitUserAccountBase`, `KitUserBase`, `KitGatekeeperBase`) that a gatekeeper subclasses under its
  own export names. The bases contain only sequencing; every provider decision (token exchange,
  refresh, revocation, error classification, scopes, URL grammar, session API) stays in the
  consumer package.

The escape hatch is structural. A gatekeeper that outgrows the assembly implements the canonical
`workshop-shared/gatekeeper` interfaces by hand and keeps using whatever leaf modules still fit;
`packages/mcp-shared` already proves the two styles coexist in one repo.

Provider *policy* and shared *sequencing* are deliberately separated. The kit never decides what a
provider error means or which scopes to request; it does own the order of operations — nonce
transitions, callback handoff, rollback when `complete()` fails, refresh coalescing, and the
races between connect, refresh, and revoke. Today that sequencing exists in at least three
divergent forms (supabase's in-flight refresh promise, google's `#credentialUpdate` chain,
ironclad's generation counter in the internal repo), which is how sequencing bugs multiply.

### v1 scope decisions (agreed)

- **New package `@gadgets/gatekeeper-kit`**, private, non-deployable (no `wrangler.jsonc`).
  `@gadgets/backend-utils` is not touched; it stays a logging/observability package with no
  `workshop-shared` dependency.
- **Parity proof: port `gatekeeper-supabase`** to the assembly, keeping every export name and the
  entire `wrangler.jsonc` (including migrations) byte-identical, and keeping live account DO
  storage readable through explicit legacy-key options.
- **Second consumer: `mcp-shared`** drops its private copies of the nonce and HTML modules in
  favor of the kit's leaf modules. No other existing gatekeeper is modified; follow-up PRs port
  them one at a time.
- **Cloudflare Access stays out.** Internal gatekeepers authenticate through Cloudflare Access;
  that flow lives in the internal repo and will later be expressed as an `AuthStrategy`
  implementation. The seam is designed for it (see §5, `./auth`), but no Access code ships here.
- **Simulation primitives ship pure and unwired.** `createSimulationView`, `replaySimulation`, and
  `ProvisionalIds` land as tested leaf modules; no gatekeeper is ported to them in this change.
- **The `write-gatekeeper` skill is rewritten kit-first** in the same change, since the skill is
  the primary manual for agent-authored gatekeepers.
- Explicit follow-ups, not in scope: repo conformance checks over gatekeeper `wrangler.jsonc`
  files, a `create-gatekeeper` generator, ports of the remaining gatekeepers, and the batch
  `applyActionsThrough` action contract (its journal-shaped prerequisites are built here).

## 2. Background: relevant existing code

| Concern | Location |
|---|---|
| Canonical gatekeeper RPC contract | `packages/workshop-shared/src/gatekeeper.ts` (`GatekeeperVendor` :445, `GatekeeperUser` :567, `Gatekeeper` :698, `ApprovalQueue` :934) |
| Reference OAuth boilerplate (the duplication) | `packages/gatekeeper-supabase/src/supabase.ts:267-672`, `packages/gatekeeper-github/src/github.ts:931-1333` |
| Shared-base precedent (symbol hooks, undecorated bases) | `packages/mcp-shared/src/user.ts:30-38`, `src/facet.ts`, `src/account.ts`, `src/http.ts` |
| Facet instantiation via `ctx.facets`, props-complete classes | `packages/workshop-backend/src/overseer.ts` (`addGatekeeper`), `user.ts:1666-1691` (policy chokepoint) |
| Build-time RPC validation | `capnweb-validate` (`wrangler.jsonc` build command in every gatekeeper; vite plugin in workerd test configs) |
| workerd test harness + facet access from tests | `packages/gatekeeper-cloudflare/vitest.worker.config.ts`, its `__tests__/` `TestHooks` DO |
| `ctx.exports` typing | generated `worker-configuration.d.ts` `Cloudflare.GlobalProps` (e.g. `packages/gatekeeper-supabase/worker-configuration.d.ts:6-12`, `packages/gatekeeper-mcp/src/env.d.ts`) |
| Cursor implementations to generalize | `packages/gatekeeper-github/src/github.ts:809-929` |
| Existing simulation shapes (design inputs) | `packages/gatekeeper-homeassistant/src/simulation.ts`, `packages/gatekeeper-confluence/src/confluence-actions.ts`, `packages/gatekeeper-notion/src/notion-actions.ts` |
| Agent-facing authoring guide to rewrite | `.agents/skills/write-gatekeeper/SKILL.md`, `SKELETON.md` |

## 3. Concepts & terminology

- **Leaf module:** a Layer-1 primitive with no dependency on the assembly. Declares the narrowest
  structural KV surface it needs (`get`/`put`/`delete`/`list` subsets of
  `DurableObjectStorage["kv"]`), never the full storage type.
- **Assembly:** the Layer-2 spec, strategies, HTTP handler, and base classes. Built only on leaf
  modules.
- **Auth strategy:** the pluggable object that turns a verified connect attempt into stored
  credentials. The kit ships `oauth2` and `tokenAuth`; Cloudflare Access and other exotic flows
  implement the same interface elsewhere.
- **Grant death:** a provider response that proves the stored grant is gone. For OAuth this is an
  RFC 6749 §5.2 token-error response — HTTP 400, or 401 for client authentication, or an
  `invalid_grant`/`invalid_token` error code. A 403 WAF page, a 404, an unexpected redirect, a
  malformed 2xx, or a network failure is infrastructure, and must never destroy stored
  credentials. Strategies signal grant death by throwing `CredentialsExpiredError`; everything
  else propagates with credentials intact.
- **Identity fencing:** a refresh result is committed only if the stored credential record is
  still the one the refresh started from, so a stale refresh cannot clobber a newer reconnect.
- **Attempt generation:** a random value stored when a connect attempt starts and re-checked after
  every `await` inside the attempt. `revoke()` and a newer attempt clear it, so a token exchange
  that races a revoke can never write credentials back after `deleteAll()`.
- **Expiry latch:** the `"expiredNotified"` flag that keeps `credentialsExpired()` to one
  notification per expiry. The latch is set only after the callback RPC succeeds; a crash
  mid-notification re-notifies later (harmless per the contract), whereas a latch claimed before
  the RPC could be stranded set and silence every future expiry.
- **Observer strategies A–D:** the four admission policies from the `write-gatekeeper` skill —
  private-only, single-unit ACL check, tracked data sets with forward exclusion, and open.

## 4. Layer 1: leaf modules

Each module is a subpath export (`@gadgets/gatekeeper-kit/<name>`), mirroring
`packages/mcp-shared/package.json`.

One spec discipline applies to every section below: a behavioral sentence must name the surface
that carries it in the adjacent method list. Behavior with no named carrier is a spec bug (three
instances were found this way: `markApplied`, `resolved`, and the retention derivation).

### 4.1 `./connect-nonce`

```ts
export const NONCE_BYTES = 32;
export const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
export const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
export const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;
export const ACCESS_TOKEN_SAFETY_MS = 60 * 1000;
export function hexEncode(bytes: Uint8Array): string;
export function generateNonce(): string;                       // hex over crypto.getRandomValues
export function constantTimeEqual(a: string, b: string): boolean;  // crypto.subtle.timingSafeEqual
export type TimedNonce = { value: string; expiresAt: number };
export function isLiveNonce(stored: TimedNonce | undefined, presented: string, now: number): boolean;
```

`constantTimeEqual` uses the native `crypto.subtle.timingSafeEqual` after an encoded-length check
(the length is public: every nonce is 64 hex characters). The native API exists only in workerd,
which is why this module's tests run in the workerd vitest project (§6).

`isLiveNonce` fails closed on a malformed stored record: a non-string or empty `value`, an empty
`presented`, or a non-finite `expiresAt` all deny. An absent `value` encodes to the same empty
buffer an empty `presented` does, so a corrupt record would otherwise admit — and a capability
check may not have a fail-open branch. The encoder is module-scoped, since this runs on the auth
path.

### 4.2 `./connect-handshake`

The two-stage connect nonce machine that every OAuth gatekeeper currently re-implements
(`supabase.ts:380-425` is representative). Function-based so partial adopters can take only
`isLiveNonce` or only the constants.

```ts
export const NONCE_KEY = "nonce";               // unchanged from every current gatekeeper
export type ConnectStage = "initiation" | "oauth";
export type StoredNonce<Extra extends object = Record<never, never>> =
  TimedNonce & { stage: ConnectStage } & Extra;   // Extra may not redeclare value/expiresAt/stage
export function putInitiation(kv, initiationNonce: string, now: number): void;
export function advanceToOAuth(kv, initiationNonce: string, now: number): string | null;
export function advanceToOAuth<Extra extends object>(   // naming Extra requires passing it
  kv, initiationNonce: string, now: number, extra: Extra & NonceExtra): string | null;
export function claimOAuth<Extra extends object>(
  kv, oauthNonce: string, now: number): StoredNonce<Extra> | null;
```

`advanceToOAuth` verifies the initiation nonce (constant time, TTL, stage) and mints the
oauth-stage nonce in one synchronous step, so exactly one concurrent caller can advance a given
attempt. `claimOAuth` is one-shot: it deletes the record on success and returns it so callers can
read `Extra` fields (PKCE verifier, requested scopes). The stored shape is a superset of the
`StoredNonce` every existing OAuth gatekeeper writes, so records from live accounts stay readable
(`mcp-shared` is the exception: `account.ts:118` also carries a `"connecting"` stage, which step 12
leaves in place) —
which is why `Extra` stays flat rather than nested under a property: the reserved keys (`value`,
`expiresAt`, `stage`) are intersected onto `advanceToOAuth`'s `extra` parameter, which both
excludes them statically and rejects them at runtime, instead of changing the shape. The exclusion
lives on the parameter rather than the `Extra` constraint: as a constraint it is a weak type, which
defeats inference and collapses `StoredNonce<Extra>` to `never`.

### 4.3 `./connect-pages`

The browser pages a gatekeeper serves during connect: "connected, close this window", "link
expired", and an error page with a reason. Exports `escapeHtml`, `htmlResponse(body, status = 200)`,
`SELF_CLOSING_HTML`, `INVALID_LINK_HTML`, `errorPageHtml(title, detail)`, and `PAGE_STYLE`.

**Deliberate divergence from the worktree module:** `htmlResponse` also sets
`Cache-Control: no-store`, `Content-Security-Policy: frame-ancestors 'none'`,
`Referrer-Policy: no-referrer`, and `X-Content-Type-Options: nosniff`. Connect pages open in their
own tab and are never framed (the srcDoc-framed surfaces are gatekeeper app UIs, a different module
entirely), a connect URL carries a nonce that must not leak via `Referer`, and an error page
interpolating provider text must not have that text sniffed into another content type. `no-store`
is there because the URL's path segment *is* the bearer capability and the page may echo account
identifiers, so a shared cache holding either turns a one-shot link into a readable artifact; the
Marketo branch sets it (`connect-ui.ts:32-40`) and every OAuth gatekeeper in this repo omits it.
They belong on the helper rather than each call site for the same reason `PAGE_STYLE` does: a
vendor form inherits all four without remembering them. This flows on to mcp-shared's connect form
at step 12.

`connectMutationError(req, { contentType })` classifies a browser mutation on one of those
capability URLs, answering `"cross-origin"`, `"unsupported-content-type"`, or `undefined`; the
caller renders its own refusal, since Marketo answers JSON 403/415 while a form-based flow answers
HTML. A **missing** `Origin` is refused, not waved through: browsers send it on every POST, so its
absence means a non-browser caller on a URL whose whole authority is that a browser followed a
link. This is the third copy of the same check — Marketo's `checkMutation`, and
`workshop-backend/src/client-errors.ts:100-104` — and homeassistant, which accepts POSTs on its
connect route, has none.

`contentType` names a media type and is compared **exactly**, parameters dropped and case folded.
Substring matching looks equivalent and is not: `application/jsonp` contains `application/json`,
and so does the parameter in `text/plain; x=application/json`, while a genuine
`multipart/form-data; boundary=…` still has to pass.

`PAGE_STYLE` is a shared page frame whose palette tokens (light and dark) are copied from
`packages/workshop-frontend/src/styles.css`, exposed as CSS variables so a gatekeeper with a form
(the `tokenAuth` strategy, or a hand-written page) can extend it. These pages open in their own
tab, outside the Workshop, so they cannot use Tailwind or Kumo; only the base palette is copied,
never the deployment's admin-chosen accent. Vendor-specific wording stays in the vendor:

```ts
const NOT_CONFIGURED_HTML = errorPageHtml(
  "Supabase Gatekeeper Not Configured",
  "Please configure a Supabase OAuth app client ID and secret for this gatekeeper.");
```

### 4.4 `./credential-expiry`

```ts
export async function notifyCredentialsExpiredOnce(
  kv, callback: Fetcher<GatekeeperConnectCallback> | undefined, vendorId: string): Promise<void>;
export function clearCredentialExpiryLatch(kv): void;
```

`notifyCredentialsExpiredOnce` never throws (callers await it and then throw their own "please
reconnect" message, which a broken stored callback must not replace with an RPC error). It marks
the latch **only after** `callback.credentialsExpired()` resolves — and only if no reconnect re-armed
it meanwhile, which would otherwise silence the new credentials' first expiry. Concurrent callers
dedupe onto one in-flight notification *per arm*, so a caller arriving after a re-arm gets its own
notification rather than the one already awaiting a callback for the credentials just replaced. That
entry is released by the caller that installed it, never by the notification itself: a stub that
throws before returning a promise settles inside the frame that started it, and a release attempted
there would run before the entry existed — leaving a resolved one behind that silences the arm.
"Never throws" includes its own storage reads: a failing latch must not replace the caller's
reconnect message either. The ordering matters: claiming the latch before the
RPC leaves a crash window in which the latch is set but nobody was notified, permanently
silencing the account. With mark-on-success, the worst crash outcome is a duplicate notification,
which the `GatekeeperConnectCallback` contract explicitly tolerates. Failures log `warn` with
event `credentials.expiry.notify.failed` and the caller's `vendorId` via
`@gadgets/backend-utils/logger` (component `"gatekeeper.connect"`). Existing stored `true` latch
values remain honored.

The latch key is `"expiredNotified"` — unchanged from every current gatekeeper — but **module-private
rather than exported**: every latch in both corpora is that literal, ports adopt the two functions
above, and no external writer remains, so exporting it only invites one. The compat test restates
the literal, which is what fences a rename against live accounts.

### 4.5 `./http-errors`

`HttpError(status, message)`, `isNoAccessError(e)`, and `probeAccess(check)`. `isNoAccessError`
returns true only for a numeric `status` property of 401, 403, or 404 — never by parsing message
text, which could match a code embedded in a 5xx body. Errors without one of those statuses must
be rethrown by callers, never treated as "no access". `probeAccess` wraps an ACL probe in exactly
that policy.

`probeAccess`'s callback **must throw** to report failure; the resolved value is never inspected.
That makes one misuse silent, so it is called out on the function: `probeAccess(() => fetch(url))`
reports *access* for a 403, because `fetch` resolves for HTTP errors. The API client checks the
response and throws an `HttpError` carrying the status — which is what all nine internal callers
below already do. Typing the callback `Promise<void>` would not close it: TypeScript accepts any
return type in a `void` position, so `() => fetch(url)` still assigns.

This module stays, and the evidence is worth recording so a later pass does not re-litigate
deleting it as consumerless: the internal repo's `gatekeeper-shared/src/observers.ts:27-56` exports
this exact trio, and nine internal gatekeepers call `probeAccess` from their verifiers (backstage,
gitlab, ironclad, jira, kibana, prometheus, sentry, slo-directory, zinc; clickhouse uses
`isNoAccessError` inline). Public google, github, and confluence do the same 401/403/404
classification ad hoc. Ports consume it directly.

### 4.6 `./credentials`

Durable credential storage and the refresh discipline, for the `UserAccount` DO side and the
consumer side respectively:

```ts
export class CredentialsExpiredError extends Error {
  constructor(message: string, opts?: { cause?: unknown });
}

export class CredentialCoordinator<Creds> {                  // lives in the UserAccount DO
  constructor(kv, opts: {                // keys are fixed: "credentials", plus ":identity" and
    expiresAt?(c: Creds): number | undefined;      // ":migrated" beside it
    refreshSkewMs?: number;              // default ACCESS_TOKEN_SAFETY_MS
    upgrade?(kv: Pick<CredentialsKv, "get">):          // lazy legacy-key migration, READS ONLY:
      { credentials: Creds; legacyKeys: readonly string[] } | undefined;   // names the keys it
                                         // reassembled the grant from, and the coordinator deletes
                                         // them after the canonical record exists. Retired by
                                         // clear(), so a clear() (or a restart after one) cannot
                                         // resurrect a grant since replaced or revoked
  });
  stored(): Creds | undefined;   // mints an identity for a record that predates them, so credentials
                                 // and a fence are always surfaced together
  commit(creds: Creds): void;    // rotates the identity, THEN writes the record
  clear(): void;                 // retires the migration, rotates the identity (rather than
                                 // deleting it), THEN drops the record
  identity(): string;            // random per write; opaque, equality only — a counter is reset by the
                                 // deleteAll() in revoke()/alarm(), which would reissue a fence value
                                 // from the revoked grant. "" = never surfaced, and never a fence
  fresh(refresh: (current: Creds) => Promise<Creds>): Promise<Creds>;
}

export class CredentialSource<Creds> {          // held by User entrypoint / facet / verifier
  constructor(opts: {
    account: () => AccountCredentialStub<Creds>;   // { getCredentials(): Promise<{ creds, identity }>; noteCredentialsExpired(identity) }
    isAuthError(e: unknown): boolean;              // grant death only, never a per-resource denial
    expiredMessage: string;
    vendorId?: string;                             // log attribution
  });
  get(): Promise<Creds>;       // instance-cached and coalesced (see supabase.ts:925-951); keeps the identity alongside
  run<T>(fn: (creds: Creds) => Promise<T>): Promise<T>;   // hands the call its creds, captures their identity
}
```

There is no `key` option and no `cacheTtlMs`. No consumer in either corpus needs a different
canonical key — a split or foreign legacy layout migrates through `upgrade()`, the mechanism
supabase and any `cfAccessToken`-cohort port already require regardless — and the only
consumer-side cache precedent is supabase's fixed 30s, while google and slack derive freshness from
the credential's own expiry, a different shape a TTL number cannot express (§10).

The migration marker is written by `clear()` and by an `upgrade()` that found nothing, and nowhere
else. While a canonical record exists, `stored()` never consults the migration path, so the marker
only has to be durable once that record is gone — and `clear()` is the only kit path that removes
it. (The `deleteAll()` behind `revoke()` wipes the legacy keys too, so an upgrade re-run after one
finds nothing and re-marks.) Keeping it off `commit()` saves a KV write per successful refresh.

`clear()` writes it **whether or not an `upgrade` is configured**. Conditioning it on the option
saved one write on a path taken once per disconnect, and bought a trap: a deployment that ships the
kit without a migration and adds `upgrade` in a later release would find no marker on an account
that had since disconnected, re-run the migration against whatever legacy keys that disconnect left
behind, and resurrect a grant the user revoked.

**Write order is load-bearing in both mutators.** An implicit Durable Object transaction is atomic
against machine failure but is *not* rolled back by a throw, so the order decides what an unusually
placed storage failure leaves behind. The fence goes first: `commit()` rotating before it publishes
can only lose the new record, with every in-flight refresh already fenced out, whereas publishing
first could leave the new record readable under the *old* fence and let a stale refresh commit
straight over a reconnect. `clear()` follows the same rule with the record last, which closes two
resurrection paths rather than one — dropping the record first can bring it back either from an
in-flight refresh whose fence still matches, or from an `upgrade()` re-run that the not-yet-written
marker permits. Both orders are pinned by tests that fail if the statements are swapped back.

`fresh()` returns the stored credentials when they are outside the skew window; otherwise it
coalesces concurrent callers onto one in-flight refresh. It is identity-fenced on **both paths**:
it snapshots the stored record before awaiting, and commits a result only if the store still
holds that exact record — on a mismatch it returns the newer stored credentials when present and
throws `CredentialsExpiredError` when the store was cleared. The failure path carries the same
fence, but **only for grant death**: a `CredentialsExpiredError` propagates when the identity is
still current and otherwise re-reads the store (newer credentials → return them; cleared →
propagate), so grant A's stale death can never expire grant B. Every other refresh error propagates
untouched (grant death vs. infrastructure, §3) — fencing those would swallow an outage that raced a
reconnect, and reclassify one that raced a `clear()` as expiry. Refresh is not
transactional against provider-side rotation: a crash between the provider rotating a token and
`commit()` persisting it can lose the new token. The README documents this; nothing in the API
may promise otherwise.

`CredentialSource.run` resolves the credentials, hands them to the operation, and captures their
identity before awaiting it. When `isAuthError(e)` is true it calls
`account().noteCredentialsExpired(identity)` with that captured value — reading it back after the
failure would report whichever identity a concurrent refetch had since installed, expiring the
grant that replaced the one the call used — and throws `new Error(expiredMessage, { cause: e })`.
The account hop is itself wrapped, so its failure cannot replace `expiredMessage`; everything else
passes through.

**`isAuthError` is the one classifier the agent can aim.** It decides that a *grant* is dead, and
the agent chooses which operations run — so a classifier matching bare 401/403 lets it retire a
healthy connection by requesting one resource the grant does not cover, and the user is prompted to
reconnect something that never broke. Per-resource denials are `isNoAccessError`'s job (§4.5); this
one wants the provider's credential-invalid signal, the same RFC 6749 §5.2 doctrine
`CredentialsExpiredError` carries on the refresh path. The option's doc comment says so, and the
skill rewrite (§7 step 16) repeats it where config authors will be reading.

That invalidation drops the **in-flight** fetch as well as the cached record. The fetch was started
against the credentials the failure just reported dead, so leaving it in place would let a caller
arriving afterwards await it and receive them anyway; a caller already awaiting it is in the same
position as any caller holding credentials when they die, and handles its own auth failure.

### 4.7 `./observers`

The observer-verification primitives, plus the strategy objects the assembly consumes.

```ts
export function asVerifier<T>(user: unknown): T;    // the one sanctioned cast, with justification
export const OBSERVER_DENIED: string;               // default denial text
export type ObservationCheck = { excludeObservers?: string[]; commit(): void };

export type ObserverTrackerOptions<V> = {
  kv;
  setPrefix?: string;                   // observed-set records; default "observed:"
  canonicalSetId?(setId: string): string;             // identity when omitted; applied once, at entry
  verifyBaseline?(verifier: V): Promise<void>;        // throwing coarse membership check
  hasSetAccess(verifier: V, setIds: readonly string[]): Promise<boolean[]>;   // batched; copied
  denyMessage?(setId: string): string;                // default OBSERVER_DENIED
  maxTrackedSets?: number;              // default 1000; refuses to reveal set 1001
  concurrency?: number;                 // default 6; concurrent verifier round trips
};
export class ObserverTracker<V> { addObserver; removeObserver; prepareObservation; observerIds }
export class ObservationGate implements Disposable { authorize; [Symbol.dispose] }  // owns the dup
```
`addObserver` awaits `verifyBaseline` first — the consumer throws its own baseline error, so the kit
never has to decide what a non-`true` answer meant (`aclObservers` takes the answering shape instead,
and admits only a literal `true`) — then verifies the observer against every tracked set, looping
and re-reading until no unchecked sets remain, so sets that appear mid-check are also verified — and
only then persists the verifier under `observer:<id>`. It throws `denyMessage(setId)` naming the
first failing set.
`prepareObservation(sets)` marks
newly-revealed sets `"pending"` before any `await` (so a concurrent `addObserver` sees them),
batch-checks every stored observer, and returns `excludeObservers` plus a `commit()` that
promotes the sets to `"observed"` only after the overseer authorizes the observation.

The observer prefix is `"observer:"` and is **not** configurable: every tracker in both corpora
(public linear, notion, confluence, slack, supabase, context, google; internal
`gatekeeper-shared/src/observers.ts`) stores verifiers there, and only the set family varies —
`observedProject:`, `observedCollection:`, `observedTeam:`, `observedItem:`,
`trackedConversation:`, `observed:` — which is what `setPrefix` exists for, so the ported supabase
organization binding keeps reading its existing `observedProject:` rows. The constructor throws
when `setPrefix` overlaps `"observer:"` in either direction, which also rejects the empty prefix:
overlapping families scan into each other, returning set ids as verifier keys and handing stored
verifiers to `hasSetAccess` as set ids. A stored `true` always reads as "observed" with no opt-in
flag — the kit never writes `true`, its only source is a legacy record, and in every corpus case
that means observed.

`hasSetAccess` is batched because real oracles are: supabase answers N project refs with one
`/v1/projects` call. Because it is batched, **a verdict array whose length disagrees with the
question denies or excludes, in either direction.** A short answer already denied by reading
`undefined !== true`; an answer *longer* than the question used to admit, since the surplus entries
were never looked at — and index position is the only thing tying a verdict to a set, so a length
the oracle disagrees about invalidates every verdict in the array, not merely the extras. Google
asserts the same invariant before reading a batch result
(`gatekeeper-google/src/observers.ts:51-55`); the kit denies rather than throwing on the exclusion
path, so one broken verifier cannot fail an entire read. A verifier that *throws* is excluded the
same way and logged at `warn`: a stored stub outlives the workspace that supplied it, and rejecting
the batch would fail every observation this binding makes from then on.

**Each call gets its own copy of the batch.** Chunking it destructively —
`while (ids.length) ids.splice(0, N)` — is a legal oracle: it returns one verdict per set, in
order, which is the whole contract, and an oracle whose provider caps ACL lookups has to chunk
somehow. Shared, that array is a data leak rather than a style problem: the exclusion check
compares the verdict count against the *same* array the oracle emptied, so the comparison passes
vacuously and every observer after the first is admitted to sets nothing verified it against —
while the honest verifier, whose answer no longer matches the emptied question, is the one
excluded. A per-call `slice()` is one allocation beside a round trip the same loop is already
making, and it makes the fence independent of oracle etiquette. `readonly string[]` records the
intent for a port author; because method parameters are bivariant it does not enforce it, which is
why the copy is the mechanism and the type is only the documentation.

`addObserver` writes the verifier only if no `removeObserver` for that id landed while its ACL
checks were in flight, and throws when one did — a quiet return would report an admission that did
not happen, and an untracked observer is excluded from nothing. The counter is in memory: the only
caller a removal can overtake is an admission parked in this instance, and an eviction ends it.

The four strategies and the session-side gate:

```ts
export interface ObserverStrategy {
  addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void>;
  removeObserver(id: string): Promise<void>;
  prepare?(setIds: string[]): Promise<ObservationCheck>;
  observerIds?(): string[];        // present only where observers are retained
}
export function privateObservers(message: string): ObserverStrategy;                       // A
export function aclObservers<V>(opts: {                                                    // B
  hasAccess(v: V): Promise<boolean>;   // answers rather than throws; only `true` admits
  denyMessage?: string;
}): ObserverStrategy;
export function trackedSetObservers<V>(opts: ObserverTrackerOptions<V>): ObserverStrategy; // C
export function openObservers(): ObserverStrategy;                                         // D

export function escapeObservationValue(value: string): string;
export class ObservationGate {
  constructor(queue: RpcStub<ApprovalQueue>, strategy: ObserverStrategy,
    options?: { sanitize?(text: string): string });
  authorize(description: ObservationDescription, setIds?: string[]): Promise<void>;
}
```

`ObservationGate.authorize` runs `strategy.prepare(setIds)` when present, calls
`queue.authorizeObservation({ ...description, excludeObservers })`, and invokes `commit()` only
after authorization succeeds. Sessions call the gate for every read instead of the raw queue.

`escapeObservationValue` flattens newline runs to a space and backslash-escapes the Markdown
control characters, for interpolating a provider-controlled string — an issue title, a document
name — into a description. Marketo escapes exactly this set (`session.ts:1701-1709`) and google
flattens newlines (`google.ts:1186-1188`); github and homeassistant interpolate provider titles
raw, which is a provider-authored line break or list marker rendered as the gatekeeper's own
prose in the approval UI. When the gate is constructed with `sanitize`, it applies it to `title`
and `description` before the exclusion merge, so a consumer wires it once per session rather than
at every read site. There is deliberately **no default**: `ObservationDescription.description` is
Markdown by contract (`workshop-shared/src/gatekeeper.ts:1054-1058`), and escaping every
description wholesale would destroy the structure a session composed on purpose — so the choice
belongs to the consumer that knows whether its descriptions are authored Markdown or plain
provider sentences.

### 4.8 `./actions`

The durable action journal (sequential IDs, staged/pending lifecycle) and kind-based dispatch,
shaped so the batch `applyActionsThrough` contract can be layered on later without rework.

The module's scope follows the corpus test: **reject's variance lives inside a handler body, which
dispatch can absorb; revert's variance lives in record lifecycle, which it cannot.** So apply and
reject are declarative here, while revert is a facet-level seam (§5.9) whose behavior is ordinary
consumer TypeScript — five gatekeepers today have five incompatible revert/retention behaviors,
and the kit does not model irreducible variance.

```ts
// `SerialTaskQueue` lives in its own module -- see §4.12.

export type JournalKeys = {
  nextIdKey?: string;                       // default "pending:nextActionId"
  recordPrefix?: string;                    // default "pending:action:" — disjoint from nextIdKey
};
type JournalState =                                     // internal; the kit writes all five
  "staged" | "pending" | "claimed" | "failed" | "applied";
export type JournalRecord<A> =                          // returned by get(); error only on "failed"
  { state: JournalState; action: A; error?: string };
export class ActionJournal<A> {
  constructor(kv, opts?: JournalKeys & { upgradeRecord?(raw: unknown): A; maxPending?: number });
  // records carry a version marker; an unmarked one goes to upgradeRecord rather than being trusted
  allocate(action: A): number;              // sequential id, state "staged"; throws at maxPending
  markSubmitted(id: number): void;          // "staged" → "pending"
  markClaimed(id: number): void;            // "staged" | "pending" → "claimed"
  restorePending(id: number): void;         // "claimed" → "pending"
  markFailed(id: number, error: string): void;    // → "failed", terminal; only reject clears it
  rollbackSubmission(id: number): void;
  get(id: number): JournalRecord<A> | undefined;  // any state; checks both tiers
  remove(id: number): void;
  retain(id: number, action?: A): void;     // post-apply write: retained record first, then the delete
  isRetained(id: number): boolean;          // tier membership — trustworthy where open consumer states are not
  listPending(): SimulationRecord<A>[];     // "pending" + "claimed", ascending id; feeds createSimulationView
}
export function stageAction<A>(journal, queue: RpcStub<ApprovalQueue>,
  action: A, description: ActionDescription): Promise<number>;

export type RejectResult = void | { restart?: boolean };   // restart = re-run the submitting turn
export type ResolveOutcome = "applied" | "rejected" | "failed" | "reverted";

export class ActionApplyError extends Error {   // thrown by an apply handler: terminal, not retryable
  constructor(message: string,                  // display-safe; becomes the stored answer
    options?: { effect?: "unknown" | "partial" | "none"; cause?: unknown });
  readonly effect: "unknown" | "partial" | "none";      // default "unknown"
}
export const APPLY_OUTCOME_UNKNOWN_MESSAGE: string;     // the answer an orphaned claim is failed with

export function defineActions<H, M extends Record<string, unknown>>(defs: {
  [K in keyof M]: {
    kind?: ActionKind;
    autoApprovable?: boolean;
    claimBeforeApply?: boolean;             // at-most-once for an irreversible provider call
    apply(payload: M[K], host: H): Promise<void | { action?: M[K] }>;
    reject?(payload: M[K], host: H): Promise<RejectResult>;
  }
}, opts?: {
  retainApplied?: boolean;                  // explicit; default false — facet base asserts revert-hook consistency (§5.9)
  vendorId?: string;                        // log attribution; the assembly threads spec.id
  afterResolve?(host: H, outcome: ResolveOutcome): void | Promise<void>;
}): ActionSet<H, M>;

export type BoundActionSet<M> = {
  submit(queue: RpcStub<ApprovalQueue>, kind, payload, description): Promise<number>;  // NOT queued
  apply(id: number): Promise<void>;         // both run on `queue`, one resolution at a time;
                                            // void for an already-applied id
  reject(id: number): Promise<RejectResult>;
  autoApprovableKinds(): ActionKind[];
  readonly retainsApplied: boolean;
  resolved(outcome: ResolveOutcome): Promise<void>;
  readonly queue: SerialTaskQueue;          // the facet's revert hook joins THIS queue (§5.9)
};
export type ActionSet<H, M> = {   // declarations are module-scoped, the journal and host per-facet
  bind(journal: ActionJournal<TaggedAction<M>>, host: H): BoundActionSet<M>;
};
```

The default keys are the dominant corpus family — supabase, google, backstage, and excalidraw all
use exactly `pending:nextActionId` and `pending:action:` — so a port in that cohort passes no key
options at all and its raw legacy records flow through `upgradeRecord` as designed. Ports outside it
override (ironclad `pending:`, github `action:`). Because the defaults are now a live-storage
contract, the test asserting those literals is load-bearing rather than a tautology.

**Resolution is serialized, and the queue is part of the contract.** The overseer can deliver two
callbacks for one action id concurrently: `approveAction` checks `state !== "pending"` and then
awaits `#getClientProfile()` before dispatching (`overseer.ts:9485-9495`), with the Durable Object's
input gate open across that await — and `applyPendingAction`'s own comment states that validating
the record is the caller's responsibility. Its single-flight drainer guards concurrent auto-approval
*drains* only, so manual-plus-drain and two manual approvals both reach the gatekeeper. Without a
queue, `resolvable(id)` is a time-of-check/time-of-use window wrapped around a provider call, i.e. a
double effect on the provider with one journal record to show for it.

This is an inherited corpus-wide hole, not a kit regression: supabase has the identical shape
(`supabase.ts:1092-1107` — get, `await runQuery`, remove), and no *public* gatekeeper has a
serialization primitive at all. Two places in either repo defend, and both do it differently:
`mcp-shared` takes a synchronous `applying` claim over the same TOCTOU
(`action-store.ts:130-162`), and ironclad checks an `applied:${id}` idempotency marker before
applying (`ironclad.ts:869`). The kit is the first place the fix can be written once for every
port, which is why it is here rather than left to each facet.

`queue` is exposed rather than hidden because revert is a facet seam. A second queue beside this one
would serialize apply-vs-apply and revert-vs-revert while leaving **apply-vs-revert** interleaved,
which is the pair where one side reads back what the other rewrote. A facet runs its revert hook as
`actions.queue.run(hook)`, and must never call `apply`/`reject` from inside a `run` callback: they
claim this same queue and would wait on their own predecessor. `submit` stays deliberately off it
(see the staged-record fix options above).

There is deliberately **no** `put(id, record)` and no `listUnresolved()`. No corpus journal lets
outside code write arbitrary states into a live record, and `put(id, { state: "applied" })` on one is
a re-apply footgun; cascade rejection everywhere enumerates *pending* records only (github's
`#listPendingActions`, and the pending scans in linear, notion, confluence, and spotify). For the
same reason `JournalState` is internal and closed rather than an open `(string & {})` union: no
consumer stamps its own state.

**Known gap the Layer 2 port must close: staged records are invisible to cascade rejection.**
`stageAction` leaves the record `staged` while it awaits `submitAction`, and `listPending()`
deliberately excludes staged records — so a cascade-rejection handler resolving parent A cannot see
dependent B during that window, and B becomes pending after A and its provisional resource are
gone.

This is a regression against the corpus, and a wider one than first recorded here. Every action
path in both repos persists the record **before** yielding at the approval-queue RPC — linear
(`linear.ts:1116-23`), notion (`notion-actions.ts:1015-21`), confluence
(`confluence-actions.ts:424-27`), supabase (`supabase.ts:892-907`, where presence under
`pending:action:` *is* pending), and google on every one of its action paths — and **four of the
five also roll the record back if submission throws** (notion, confluence, supabase, google;
linear alone does not). So the earlier justification in this section, that the kit "trades that
visibility for rollback on submission failure, which linear does not have", was wrong: the corpus
majority has both, and no trade was necessary to get rollback.

What `staged` does buy is narrower than that, and worth stating precisely: the corpus pattern's
orphan window is a **crash** between the write and the rollback, which leaves a visible pending
record the overseer never heard of (linear's is permanent unless a later rejection sweeps it,
`linear.ts:1615-18`), whereas a staged orphan is invisible to every scan — silently leaked storage
instead of a phantom approval. That is a real difference, but it is orphan cosmetics against
cascade correctness, so the corpus pattern is the better trade on the axis that matters.

Two bounds keep this off the Layer 1 critical path: the window is a single overseer round-trip
against human reject latency, and the consequence is caught downstream, since
`ProvisionalIds.requireResolved` exists precisely to reject an unbound provisional target — the
orphan degrades to a failed apply with a clear message and a retained record, not to corruption.

The fix is one of two, and the choice needs the fixture (§7 step 11) in front of us rather than an
argument here:

1. **Converge on the corpus pattern.** Write `pending` before the await and keep the rollback, which
   is exactly what notion, confluence, supabase and google do. Cascade rejection then sees the
   record throughout, and the residual is the crash-orphan above.
2. **Serialize submission with resolution.** The facet base already owns one queue per bound
   resource (`BoundActionSet.queue`), and `submit` is deliberately off it. Putting submit on that
   same queue makes the interleaving impossible by construction, at the cost of queueing submits
   behind a slow apply.

Exposing `listUnresolved()` is *not* on that list: a consumer that can enumerate staged records will
eventually try to resolve one, and `staged` means the overseer has not yet been told the action
exists.

The journal is **two-tier**: staged/pending records live under `recordPrefix`, and a retained
applied record moves to a sibling retained prefix, so `listPending()`'s scan stays bounded by
genuinely pending records no matter how many applied records accumulate. `get(id)` checks both
tiers, **preferring the retained one**, `listPending()` skips an id the retained tier holds, and the
`maxPending` scan does not count one against the cap. All three readers, because the rule is an
invariant and not a convenience: the record is applied, so a reader treating it as pending is wrong
in whatever way that reader can be wrong — and the capacity scan's way is to hold a queue slot for
good, refusing allocations for a user whose approval queue is empty.
That is not belt-and-braces: `retain` writes the applied record before deleting the pending one
(so an interrupted move never loses the record), which means a failed delete leaves the id in both
tiers — and the applied copy is the true one, since it carries the apply-time artifacts a revert
hook reads back. Resolving the duplicate the other way would hand a revert the pre-apply payload
and keep projecting an effect the provider has already made real. GC of the retained tier is
deliberately consumer-side policy: retention is inherently unbounded and retirement caps are
per-vendor (only github has one today).

**The key layouts a port must reconcile (verified across both corpora, not inferred).** The kit's
defaults fit the largest cohort, but neither the counter convention nor the retention layout is
universal, and both mismatches are silent. Whoever ports a gatekeeper checks it against these two
tables *before* pointing the journal at existing keys.

*Counter convention* — what the stored number means:

| Convention | Gatekeepers | Kit |
| --- | --- | --- |
| Next unused (`?? 1`, store `id + 1`, return `id`) | supabase, google, notion, confluence, backstage, cf-wiki, ironclad, jira, salesforce — 9 | **this is `allocate()`** |
| Last issued (`(?? 0) + 1`, store and return it) | github, linear, spotify — 3 | incompatible |

Adopting a last-issued counter key as `nextIdKey` **re-issues the last ID and overwrites its
pending record** — after which the overseer can approve one description while the journal
dispatches another payload. No runtime check can catch it (N-as-next and N-as-last are the same
byte), so those three ports must migrate the counter `+1` in the same commit that adopts the
journal. Key name and convention vary independently — `pending:nextActionId`, `seq:action`,
`counter:action`, `pending:nextId`, `nextActionId` all appear — so a port picks both, separately.

*Retention layout* — where an applied record lives:

| Layout | Gatekeepers | Kit |
| --- | --- | --- |
| None: deleted on apply | supabase, google, cf-wiki, ironclad — 4 | `retainApplied: false` |
| In-place `state`/`status` field on one prefix | notion, confluence, linear — 3 | not expressible |
| Second-tier records under an independent prefix | github (`action:` → `retiredAction:`) — 1 | shape matches, key does not |
| Derived sibling `retained:${recordPrefix}` | none | `retainApplied: true` |

So the derived prefix, justified above as "the shape github already uses", generalizes exactly one
gatekeeper and matches *no* existing key: github's retained records sit at `retiredAction:${id}`,
not `retained:action:${id}`, and its `#getLiveActionRecord` fallback (`github.ts:1880-1881`) is what
would stop finding them. That port needs a `retainedPrefix` option — added *then*, designed against
its one real consumer, rather than shipped now with none. Watch two traps in the tally: ironclad's
`applied:${id}` holds `true`, not a record (`ironclad.ts:831-890` — an idempotency marker, then the
pending record is deleted), so it maps to no-retention plus the journal's existing resolution
dedupe; and the in-place trio is the *plurality of retainers*, so the first of those ports chooses
between an N-key migration to tiered (buying the O(pending) scan that in-place listing gives up —
linear filters its whole history at `linear.ts:1136`) and adding the in-place store as a second
strategy. `JournalState` already carries the `state` field that makes the latter mechanical; what
it does not settle is whether `reverted` is a journal state or facet-private, which is the §5.9
revert question and the reason this is not a slot the kit cuts in v1.

**Other port-time obligations, recorded here because no leaf can enforce them.** None is a Layer 1
defect; each is either additive later or a fact about one provider that only bites on its own port.

| Obligation | Who it affects | Why it is deferred |
| --- | --- | --- |
| **Ordering credential mutations against `revoke`.** A refresh in flight when `revoke()` wipes storage mints a token the identity fence correctly discards — leaving live provider-side authority nobody stored. Google serializes its four credential paths on one FIFO chain (`google.ts:405-427`), and even it leaks one error-path `kv.delete("refreshToken")` outside the chain (`:524-530`). | every port with a refresh flow | `revoke()` is not in the kit — the account base owns it (§5.6), and can serialize its own RPC methods. `coordinator.fresh()` already coalesces concurrent refreshes; the coordinator needs no queue of its own. |
| **Baseline re-checks on the exclusion path.** `verifyBaseline` runs at admission only, so an observer who later loses the binding-wide grant keeps observing. Google's batch result carries it per call — `{ baselineAllowed, allowed[] }` (`gatekeeper-google/src/observers.ts:48-49`) — and excludes on `!baselineAllowed` (`:206-215`). | google port first | Expressible today by folding the baseline into `hasSetAccess` (return all-`false`), so this is a documentation gap rather than a missing capability. Note google's baseline is a recorded *resource grant* (`resources.ts:203-205`), not org membership, and it *excludes* rather than removing the observer. |
| **`maxTrackedSets` is a default, not a corpus constant.** 1000 comes from google's generic default, but its concrete Drive tracker overrides to **2000** (`drive-observers.ts:49-53`), sized against `ceil(N/100)` subrequests. | supabase, notion, linear ports, which had no cap at all | A port inherits a bound it never had; the number is per-provider and belongs in that port's options. |
| **Consumer cache vs. refresh skew.** `CredentialSource` caches for a fixed 30s. That is safe only because the coordinator's default skew (`ACCESS_TOKEN_SAFETY_MS`, 60s) exceeds it — a port setting `refreshSkewMs: 0` can be handed a token with seconds left and serve it for 30. | any port narrowing the skew | Keep `refreshSkewMs` above the 30s consumer cache, or project an `expiresAt` the source can read. |
| **Re-fetch after a reported expiry.** `run()` invalidates its cache and then awaits `noteCredentialsExpired`; a concurrent `get()` in that window re-fetches the same dead grant from an account that has not been told yet, and caches it. | all | Self-healing and bounded: the next use 401s and re-reports. Costs a redundant round of 401s, never a wrong authorization. A "known-dead identity" marker on the source would close it. |
| **Corrupt-record blast radius.** A throwing `upgradeRecord` propagates out of `#coerce`, so one unreadable legacy record makes `listPending()` throw and blinds the whole simulation overlay rather than dropping that entry. | ports supplying `upgradeRecord` | Both behaviours lose something — a throw blinds everything, skipping hides one pending action from its user — so pick it with a real corpus of legacy records in view. |
| **Cross-activation replay of a settled action.** A non-retaining `apply` deletes the only durable record, and `appliedHere` is activation-local, so if the DO is evicted before the overseer persists the callback result its retry throws `Unknown pending action` for an effect that succeeded. Retained sets are already idempotent here; `claimBeforeApply` sets are not, since success still removes the record. | every port with `retainApplied: false` | The fix is a durable applied-marker tier, i.e. exactly the unbounded retention the kit deliberately made consumer policy (ironclad's `applied:${id}` is that marker, capped per-vendor). The consequence is a misleading error on a rare retry, never a double effect — the provider call does not re-run. Choose the shape with a port's retention policy in view. |
| **Reject replay loses `{ restart: true }`.** `reject` removes the record before its verdict reaches the overseer, and the idempotent replay from a later activation answers `undefined` — so an agent whose simulated state the rejection changed is not restarted. | ports whose reject handlers return `restart` | Persisting resolution *outcomes* is the same durable-marker decision as the row above, and the failure degrades to a stale agent turn rather than a wrong effect. Both rows want one answer, not two. |
| **The expiry latch re-arms with two writes.** `clearCredentialExpiryLatch` clears the boolean and writes a fresh arm. Were the second to fail alone, an in-flight notification for the replaced credentials would match the surviving arm and latch the new ones — the one *silencing* failure in a module whose every other window fails toward a harmless duplicate notification. | every port with a refresh flow | Both writes are adjacent, awaitless and constant-size, so one implicit transaction carries them and no trigger separates them; the function's doc comment states that adjacency as the invariant to preserve. Every candidate fix is worse than the window: swapping the order makes the silence deterministic, and one combined record breaks the plain-boolean compatibility the latch key promises. If a port ever needs it, the escape is a single record holding arm and notified together. |

`stageAction` encodes the one ordering every gatekeeper must get right: allocate the record,
`submitAction(id, description)`, then mark it submitted — and roll the record back and rethrow if
submission fails. `ActionSet.bind(journal, host)` returns a `BoundActionSet` with
`submit(queue, kind, payload, description)`, `apply(id)`, `reject(id)`, a readonly
`retainsApplied` (the resolved retention flag the facet base's assert reads, §5.9),
`autoApprovableKinds()` (filtered to `autoApprovable: true`, deduplicated by tag), and
`resolved(outcome)` — the facet base's way to fire `afterResolve(host, "reverted")` after its
revert hook, since the hook is closed over inside `defineActions`. There is no `revert(id)`
here — see §5.9. `implementsRevert` on the submitted `ActionDescription` stays caller-supplied, as in every existing
gatekeeper, but the two policy fields do not: `actionKind` comes from the definition, and
`autoApprovable` is the AND of the definition's and the action's. Siblings may share a `kind.tag`, so
a call-site verdict could otherwise ride an opt-in the user granted a different kind; the per-action
verdict may only narrow what the kind declared. `defineActions` rejects a definition that claims
`autoApprovable` without declaring a `kind`: it would carry a caller-supplied tag while never
appearing in the reported set, so its only possible match is a sibling's opt-in. The journal's
overridable keys are validated at construction — an empty record prefix, a counter inside either
record prefix, or a record prefix containing its own retained tier all throw.

Resolution lookups (`apply`/`reject`) find records in **any** state, not just `pending`: the DO
output gate holds the outgoing `submitAction` RPC until the preceding `allocate()` write commits,
so a crash before `markSubmitted` persists still leaves a durable `staged` record the overseer
will legitimately resolve (github's own `applyAction` accepts `"staged"`). Only `listPending()`
filters to `pending` (plus `claimed`, below). `apply(id)` with a missing record throws
`Unknown pending action: ${id}`. On a **retained** record the two verbs diverge: `apply` returns
void and does nothing, because the effect and the journal write both already happened and the only
caller who can be asking is the overseer's retry after crashing before its own state write —
reporting a failure there gives the user an error about an action that succeeded. `reject` still
throws "no longer pending" (github's semantics), because the retained record is what a revert hook
reads back and a stray rejection would destroy it. Either way the guard is `isRetained`, not the
open state string. A non-retaining set keeps the reject guard through an in-memory set of the ids
it applied, since the overseer can deliver approve and reject for one id concurrently and a reject
finding no record would otherwise report success for an action the provider ran.
On success the kit performs a **single atomic post-apply write**: the handler's returned
`{ action }` (apply-time artifacts such as created entity ids — the linear/notion pattern) merged
with the state transition — record removed, or moved to the retained tier as `"applied"` when
`retainApplied`. One writer by construction; handlers never write the journal mid-apply. An apply
that throws leaves the record so the user can retry (matching supabase) unless it threw
`ActionApplyError`, which is terminal (below), and either way still fires
`afterResolve(host, "failed")` — a partial provider effect is exactly when caches are most stale.
`reject(id)` is idempotent for an id the journal never had or already dropped: optional handler,
record removed, no-op. That is what lets the overseer retry after crashing before its own state
write, and why the applied-id guard above is per-activation rather than stored.
`afterResolve` fires once per resolution with the outcome; it exists because every corpus
gatekeeper invalidates caches after resolution and the big ones repeat it per branch (github calls
`#clearCaches()` in every switch arm), where one forgotten branch is a silent stale read. The hook
is **best-effort and carries no authority**: the kit awaits it (so post-resolution reads see fresh
caches) but catches and logs a throwing hook at `error` — it must never mask an apply error's
display-safe message with an invalidation stack, nor convert a provider-side success plus a
completed journal write into a caller-visible failure. The journal write precedes the hook, so a
manufactured failure could never reach a re-apply anyway (the retry hits the resolution guard);
the catch confines the damage to zero.

**Apply is at-least-once by default**, and `claimBeforeApply` is the opt-out. Without it the
provider call can succeed and the process crash before the journal write, and the overseer's retry
re-applies — fine for an idempotent write, wrong for one that charges a card. With it the journal
is moved to `claimed` *before* the handler runs, so the three outcomes are distinguishable in a
later activation: a plain throw restores `pending` (the handler classified the failure retryable),
an `ActionApplyError` records `failed` with its display-safe message (terminal — every later
attempt is answered from the record with no provider call, and only a rejection clears it), and a
claim nobody in this activation wrote is converted to `failed` with
`APPLY_OUTCOME_UNKNOWN_MESSAGE`, which says the call went out and its outcome is unknowable rather
than guessing either way. `claimed` records still project into simulation — an in-flight dispatch
is part of the world a read describes — while `failed` ones deliberately do not.

**Only the handler is caught**, and the boundary is load-bearing. The post-apply journal write sits
outside that `catch`: by then the provider effect has landed, so treating a storage failure as
retryable and restoring `pending` would offer the user a second irreversible apply — the exact
thing the claim exists to prevent. The claim survives instead, and the next attempt reports the
unknown outcome. No invalidation hook fires on that path either, since the write that would have
justified one is what failed; the following resolution's `failed` covers it.

The earlier claim here that "no gatekeeper solves this" was wrong: `mcp-shared/src/action-store.ts`
persists its claim before any external I/O and converts an orphaned claim into a `failed,
retryable = 0` record (`:1-2, 9-12, 43-71`), and ironclad's `applied:${id}` marker is the same
idea one step later. This is that mechanism, generalized. Marketo's finer answer — per-provider
`partial`/`nothing-changed` labels and a batch-result classifier — stays consumer policy on top of
it; `ActionApplyError.effect` is the field a consumer composes that text from.

`maxPending` bounds the pending tier itself: an agent looping on an action nobody approves would
otherwise grow it without limit, so `allocate` counts the unresolved records and throws before
writing. `failed` records are excluded from the count, since rejecting one is how it is cleared and
counting them would wedge the queue for a user with nothing left to approve. But exclusion alone
would just move the growth: failed records sit under the *scanned* prefix, so a run of terminal
failures would make every later allocation and every simulation scan more expensive. The same
`allocate` scan therefore drops the oldest failures past the same bound — the newest failure is
the one the user still has on screen — which keeps that scan bounded by what it enforces.
mcp-shared caps and prunes the same way (`MAX_PENDING_ACTIONS = 50`, `MAX_RETAINED_ACTIONS = 100`,
`#prune()`). And a retaining gatekeeper owns retirement of its retained tier (above).

Pruning is guarded on the excess being positive, which reads like a redundant check and is not: a
negative `slice` end counts back from the array's own length, so under the bound `slice(0, -n)`
silently drops the oldest failures instead of nothing — worst at one below the cap, and invisible
at a cap of 2, the only value for which no failure count reaches that band.

### 4.9 `./simulation`

Pure projection helpers extracted from the shapes already present in homeassistant, confluence,
notion, jira, and spotify. No storage, no wiring into the assembly.

```ts
export type SimulationRecord<Action> = { readonly id: number; readonly action: Action };
export function createSimulationView<Action, Target>(
  records: readonly SimulationRecord<Action>[],
  targets: (action: Action) => Iterable<Target>,
): Readonly<{                                       // frozen; readonly function properties, since
  all: () => readonly SimulationRecord<Action>[];   // an RPC-reachable object may not hand out a
  forTarget: (target: Target) => readonly SimulationRecord<Action>[];   // mutable method table
}>;

export type SimulationStep<State> =
  | { kind: "applied"; value: State }
  | { kind: "known-no-effect" }
  | { kind: "unsupported"; reason: string };
export type SimulationResult<State, Action> =
  | { kind: "complete"; value: State; appliedCount: number }
  | { kind: "incomplete"; value: State; appliedCount: number;
      unsupported: SimulationRecord<Action>; reason: string };
export function replaySimulation<State, Action>(base, records, apply): SimulationResult<State, Action>;

export class ProvisionalIds<Id extends string> {
  constructor(kv, options: {
    namespace: string;
    isProvisional?(id: Id): boolean;   // classifies an unknown id, so requireResolved can tell
  });                                  // "not ours" from "not bound yet"; it throws without one
  allocate(format: (sequence: number) => Id,        // keys `${ns}seq:provisional`
    options?: { kind?: string }): Id;               // tagged: also keys `${ns}kind:${id}`
  bind(provisional: Id, real: Id): void;            // keys `${ns}prov:${id}`
  resolve(id: Id): Id;                              // identity for unknown or provider ids
  isResolved(id: Id): boolean;
  kindOf(id: Id): string | undefined;
  requireResolved(id: Id, options?: { expectedKind?: string }): Id;
}
```

`requireResolved` is the confluence/notion "reject an unbound provisional target" pattern, which
every caller would otherwise re-express as its own `if (!isResolved(...)) throw`.

**`isProvisional` is enforced where IDs are created, not only where they are read.** Supplying it
makes `allocate` reject a formatter whose output it does not classify as provisional, and makes
`bind` reject the pair in both directions — a real ID as the key would shadow a provider ID for
every later `resolve()`, and a provisional ID as the value would resolve one provisional to another
and defeat `requireResolved`. Without those checks a badly-chosen formatter mints IDs
indistinguishable from provider ones, and `resolve()` hands an unbound provisional straight to the
provider as though it were ready — a failure that surfaces as an inexplicable provider error far
from its cause. The corpus formatters all prefix `~` (github `~${n}`, linear `~${n}`,
`~comment:${n}`), which is exactly the convention a classifier encodes; the guards are skipped
entirely when no classifier is supplied, so they cost nothing to a consumer that does not need
`requireResolved`.

**A provisional ID may carry its logical kind, and a reference may demand one.** A provisional ID
is a bare string, so nothing stops a caller passing a provisional comment id where a page id was
meant; `resolve` returns it unchanged and the provider answers with an error naming neither the
wrong kind nor the caller that supplied it. Tagging is durable and opt-in (`allocate(format,
{ kind })`, read back by `kindOf`), and `requireResolved(id, { expectedKind })` refuses a mismatch
with `${id} is a ${actual}, not a ${expected}.` before the unbound-provisional check runs — a
mistyped reference is a reference error whether or not it happens to be bound yet. An ID with no
recorded kind (a real provider ID, or an untagged provisional) skips the check, so this costs
nothing to a consumer with one entity type. Marketo carries a `LogicalKind` on every provisional
(`marketo.ts:1261-1291`) and github hand-rolls per-kind prefixes plus per-kind lookups
(`github.ts:139-142, 1956-1981`) — two independent consumers of the same idea.

**A conflicting rebind throws, and it is not classifier-gated.** Apply is at-least-once (§4.8), so a
create whose journal write was lost is re-applied and the provider answers with a *second* entity.
Overwriting the binding would silently retarget every queued action that resolves that provisional
and orphan the entity the earlier apply created, so `bind` refuses a different provider ID for an
already-bound provisional and stays a no-op for the same one — the retry's own path. A duplicate the
user can see and delete beats a mutation aimed at the wrong resource, and unlike the direction
checks this one reads the stored binding rather than the shape of the IDs, so it holds for a
consumer that supplies no classifier.

`createSimulationView` sorts once by action ID, indexes each action under every target it affects
(deduplicated per record), and returns frozen snapshots. `replaySimulation` folds records in
order; `known-no-effect` continues, and the first `unsupported` stops replay, because projecting
later actions onto a state already known to be wrong produces confident nonsense. Provider
reducers stay in each gatekeeper as pure functions; the kit deliberately ships no generic
collection overlay and no recursive ID substitution.

`ProvisionalIds` namespaces are a **disjointness convention, not a checked one**: bindings are keyed
`${namespace}prov:${id}` with no separator between the two consumer-supplied parts, so two instances
in one DO whose namespaces are prefixes of each other can collide (`("", "prov:~1")` and
`("prov:", "~1")` both land on `prov:prov:~1`). Left unchecked
deliberately — unlike `setPrefix` in §4.7, there is no fixed kit prefix for a consumer prefix to
overlap with, only sibling namespaces the consumer chose, and no DO in either corpus holds more than
one `ProvisionalIds`. Length-prefixing would change the documented key layout to defend against a
consumer colliding with itself.

### 4.10 `./cache`

`KvTtlCache` — `cached<T>(key, ttlMs, load)` and `bumpGeneration()`, constructed with `(kv)`. There
is no public `get`/`put` pair: a read-then-store cache whose two halves are separately callable puts
the generation fence in the caller's hands, and the fence is the whole point. `cached()` reads the
generation before `load()` and again after, and stores only if it did not move — so a fetch that
started before a `bumpGeneration()` is handed to the caller that asked for it (which asked before
the change) and deliberately not written. Values live inside the generation that `bumpGeneration()`
invalidates wholesale, the pattern `SupabaseCache` uses at `supabase.ts:777-806` to drop cached
schema after a mutating statement applies.

The `"cache:"` prefix is fixed rather than a `namespace` option: cache families in the corpus are
key *segments* within one namespace (github `cache:<kind>:`, notion `cache:page:`/`cache:db:`,
supabase `cache:entry:`), so a per-kind segment belongs in the caller's own `key`, and per-family
freshness is already per-read through `cached(key, ttlMs, …)` (notion's 30s/60s/1h split). No DO in
either corpus runs two separate durable TTL caches needing distinct namespaces.

A stale or generation-mismatched entry is an ordinary **miss**, left where it is: the generation
counter lives under a stable key, so a bump never grows the keyspace, and the next fill overwrites
the entry. That narrows `CacheKv` to `get`/`put` — no `delete`.

**Deferred, deliberately: `cached()` does not coalesce concurrent misses.** Two callers missing the
same key each run `load()`, and the later-started one can store first, after which the earlier
overwrites it with older data and a fresh `fetchedAt` — stale for the full TTL. The generation fence
(`cache.ts:52`) already kills the variant that matters: if a mutating statement bumped between the
two loads, *both* writes are rejected. What survives is two loads of the same not-invalidated
provider metadata where the older wins, bounded by their completion skew. Note the obvious fix does
not fit the usage pattern — supabase constructs `new SupabaseCache(this.ctx.storage.kv)` per call
(`supabase.ts:1023`), so an instance-local in-flight map would be a no-op there. If this is ever
worth closing, the stateless form is the one to use: capture `Date.now()` before the load and skip
the write if the stored entry is already fresher than the fill started.

### 4.11 `./cursors`

`ArrayCursor<T>`, `StreamingCursor<T>` and `TokenCursor<T>`, all extending `RpcTarget` and
implementing the `Cursor<T>` contract from `workshop-shared/gatekeeper`, generalized from
`gatekeeper-github/src/github.ts:809-929`. `StreamingCursor` owns provider cursor state, fetches
pages lazily, and applies optional overlay/filter/map steps. Three rules it does not inherit from
that prior art: only an **empty** page ends the walk (providers cap page size below what was asked
for — Cloudflare's own `/accounts` answers 20 to a request for 100 — so treating a short page as the
end silently omits every later record); `next()` is serialized on a `SerialTaskQueue` (§4.12), since
two un-awaited callers racing on the page counter would return one page twice and skip the next; and
a failure past the provider call is **terminal**,
because a throw from `overlay`/`filter` abandons a batch the page counter has already moved past,
so resuming would skip records. The provider call itself is the exception, marked by the gate's
`fetch`: a rejection there happens before any paging state moves, so the page is simply asked for
again. Latching that too would make a transient 5xx cost a token-paged caller the entire walk,
since the position lives in the cursor and not in their hands. Latching stays the default — a call
routed around `fetch` counts as having moved state — so the failure that has to be reasoned about
is the one that is safe to be wrong about. A
fixed internal cap of 50 consecutive pages bounds pages that yield **no usable item**, so a page the
filter empties cannot loop forever. It is not an option: google's `CursorPager` hard-codes its own
bound, internal cf-wiki loops unbounded (a hang on a broken provider), and nobody tunes it per
resource — it is a safety bound, not policy. Reaching it with items already buffered returns them
instead of throwing, since only `null` ends the stream; the counter resets per call, so a caller
that asks again spends another window, but the throw that ends the last one latches the cursor like
any other failure. It does not detect a provider that ignores
the page argument and keeps answering with rows, which resets the count and yields duplicates
instead of ending. That needs an item identity the cursor does not have, and no page ceiling
substitutes for one — a walk long enough to paginate is long enough to trip it. Injected simulation
items merge by `comparator` and skip overlay/filter: they are already in output shape, and dropping
one the caller injected would hide it. They merge at the position of every fetched item, filtered
ones included — sort position does not depend on visibility, and waiting for a survivor would bury
them behind a run of filtered pages. The options are a union — either the fetcher already returns
the session type, or it returns something else and `map` is required — so the identity case is
checked rather than assumed. Both are undecorated, and a decorator would add nothing: on a server
target `@validateRpc()` validates incoming arguments, and `next()` takes none (returns are checked
caller-side by `validateStub<T>()`). A consumer wanting one anyway declares
`@validateRpc<Cursor<Item>>() class ItemCursor extends ArrayCursor<Item> {}` locally.

`TokenCursor<T>` is the same cursor for a provider that pages by opaque continuation token rather
than page number — marketo's `nextPageToken`/`moreResult`, notion, confluence, cloudflare, and
mcp-shared's client, five of the corpus providers. It is a separate class, not a widened numeric
`fetchPage` signature, because **the exhaustion rule inverts**: only an absent `nextToken` ends the
walk, and an empty page carrying one is an ordinary idle window in an activity stream. A cursor
that inferred the end from an empty page — as page-number paging must — would silently truncate,
which is exactly the data loss marketo's own pager documents (`types.d.ts:357-358`, pinned by
`marketo.test.ts:2999-3007`). The empty string is a **valid** token, so exhaustion is
`nextToken === undefined` and nothing else; mcp-shared learned the same thing
(`client.ts:628-679`).

Two rules follow from the token being opaque. A page whose `nextToken` equals the token it was
*asked* to continue from throws: the provider is ignoring the token, and the walk would otherwise
re-fetch that page until a cap. Only the immediately-prior token is compared — an unbounded
seen-set would grow with the walk it is meant to protect — and the first page, asked `undefined`,
is exempt by construction. And barren accounting splits in two, both bounded by the same 50: a page
the provider returned **empty** is its own pacing, so at the cap `next()` returns the buffer *even
when empty*, because `[]` is a legal non-terminal page (only `null` ends a `Cursor`) and the next
call resumes the walk with its own window; a page whose items were all **filtered out locally** is
`StreamingCursor`'s barren case and still throws `Fetched 50 consecutive pages without a usable
item.` when nothing is buffered. Everything else — the failure latch, the `SerialTaskQueue` around
`next()`, the `map` union, `overlay`/`filter`, and the injected merge — is shared: the injected
merge is one module-private helper both cursors hold, while the fill loops stay separate, since
their exhaustion and barren policies are the whole difference between them and a
policy-parameterized base class would be longer than both.

### 4.12 `./serial-queue`

```ts
export class SerialTaskQueue { run<T>(op: () => T | Promise<T>): Promise<T> }
```

Its own module because two unrelated leaves need it — the action journal serializes resolution so one
action cannot be applied twice (§4.8), and `StreamingCursor.next()` serializes paging so two callers
cannot claim one provider page (§4.11). Both had mutable state behind an await, and both had
hand-rolled the same gate with the same reasoning in a comment, which is the point at which a second
copy becomes a parallel mechanism that drifts. Nothing else in either corpus has this primitive.

A **gate** rather than a chain of results: the promise stored for the next caller settles regardless
of outcome, so a rejection neither blocks later operations nor leaves an unhandled rejection behind.
Specifically not a tail-chain (`this.#gate = this.#gate.then(op).then(noop, noop)`), because `.then`
adopts an async operation's already-rejected promise through a deferred thenable-adoption microtask,
leaving it momentarily handlerless — and workerd reports that eagerly where Node waits for the queue
to drain. Validated 2026-08-29 in an isolated `@cloudflare/vitest-pool-workers` sandbox at compat
date 2026-02-02: the tail-chain passes under Node and reports `Unhandled Rejection` under workerd
for an operation that rejects before its first await. That difference is why the queue keeps
`__tests__/workerd/serial-queue.test.ts` beside the Node one.

Callers await or return what `run` hands back; an unattached rejecting promise is reported unhandled
like any other. `run` claims the gate before its first await, so concurrent callers cannot capture
the same predecessor, and a nested `run` on the same queue deadlocks by construction — see the
warning on `BoundActionSet.queue`.

### 4.13 `./auth-retry`

```ts
export type AuthRetryOptions<Token> = {
  getToken(options: { forceRefresh: boolean; staleToken?: Token }): Promise<Token>;
  isAuthError(error: unknown): boolean;          // the provider rejecting the credential, not 5xx
  onPersistentAuthError?(error: unknown): void | Promise<void>;   // the grant itself is dead
  vendorId?: string;
};
export function withAuthRetry<Token, T>(options: AuthRetryOptions<Token>,
  run: (token: Token) => Promise<T>): Promise<T>;
```

`CredentialSource.run()` has exactly two outcomes: pass the call through, or report the account
expired. That is right for the five gatekeepers whose 401 means the grant is gone (supabase,
github, linear, spotify, homeassistant), and wrong for the four that mint a short-lived derived
bearer from a longer-lived grant, where a 401 usually means *that bearer* is stale. All four
hand-roll the same single retry: marketo (`marketo-api.ts:462-477`), google
(`auth-retry.ts:100-141`, which additionally force-refreshes with the rejected token's identity),
notion (`notion-api.ts:1022-1052`) and confluence (`confluence-api.ts:527-550`).

One retry, never a loop — a credential the provider rejects twice is not going to be accepted on a
third attempt, and a loop turns a dead grant into a burst of token mints. `run` therefore executes
**at most twice** and must be replayable, which the doc comment states and which means building the
request inside it rather than passing a prepared one. `staleToken` carries the rejected token into
the refresh so a shared cache can skip a redundant mint when another caller already advanced it
(google's shape). `onPersistentAuthError` fires only when the *second* attempt fails an auth check,
which is where a consumer reports expiry — so the expiry notification is no longer racing an
ordinary stale-bearer 401. A throwing callback is logged (`auth-retry.report.failed`) and never
masks the auth error the caller has to see. A non-auth error at either attempt propagates
immediately: transport failures and 5xx are not credential problems, and retrying them here would
double every provider outage.

**A failing `getToken` is not this module's to report.** If the forced refresh itself dies —
`invalid_grant` from the token endpoint — the error propagates without `onPersistentAuthError`
firing, which looks like a gap and is not: `getCredentials()` on the account base already turns a
still-current `CredentialsExpiredError` from refresh into `noteCredentialsExpired()` (§5.6), and
that path holds the credential *identity* the notification is fenced on. `withAuthRetry` has no
identity, so reporting there would be the unfenced duplicate notification the fence exists to
reject — a stale notifier stepping on a reconnect. `onPersistentAuthError` is for the one verdict
only the API call can deliver: a credential the provider minted and then refused.

This closes the "401 retry" obligation the §4.8 table used to record as deferred; the two
credential rows that remain there (consumer cache versus refresh skew, and re-fetch after a
reported expiry) are unchanged behavior.

### 4.14 `./endpoint`

```ts
export function normalizeVendorOrigin(raw: string, options: {
  hostPattern: RegExp;              // anchored, non-global, non-sticky; tested against url.host
  label: string;                    // names the endpoint in the thrown message
  requireHttps?: boolean;           // default true
}): string;                         // the origin: no path, query, userinfo or fragment
```

For the operator-pasted endpoint an instance-hosted vendor needs (marketo's `<munchkin>.mktorest.com`,
a self-hosted Confluence, a Home Assistant on someone's LAN). Marketo validates against an anchored
allowlist (`config.ts:91-110`); homeassistant checks the scheme and nothing else
(`homeassistant.ts:317-322`), so today an operator can point it at any host that speaks HTTP,
including one the Worker reaches but the operator cannot. Returning the **origin** rather than the
input is the part that matters as much as the allowlist: a pasted URL carrying a path, a query
parameter, or userinfo would otherwise be stored and later concatenated with an API path.

The pattern is tested against `url.host`, which includes an explicit port, so an anchored pattern
refuses `host:8443` unless it names the port — stated on the option, because a pattern written
against the hostname is a silent widening otherwise. A `g` or `y` pattern is refused outright,
because `RegExp.test` advances `lastIndex` on those: the same endpoint would be accepted, then
refused, then accepted. Nondeterminism keyed on call count is the worst failure this leaf could
have, and it is a programming error rather than bad input, so it throws on every call instead of
every other one. Thrown messages name the `label` and never
echo the input, since the input reaches an operator-visible error page and may carry a token in its
query. mcp-shared's endpoint **blocklist** (`endpoint.ts:17-45`) is deliberately not re-homed here:
it is MCP-scoped SSRF defence with its own trust boundary, and moving it would churn shipped code
for no new consumer.

## 5. Layer 2: the assembly

### 5.1 `./spec`

```ts
export type KitEnv = { BASE_URL?: string; CLIENT_ID?: string; CLIENT_SECRET?: string };
export type KitAccountProps = { userObjectId: string };
export type KitLogger = { warn(msg: string, fields?: object): void;
                          error(msg: string, fields?: object): void };
export function getBaseUrl(env: KitEnv, id: string): string;
export function svgLogoUrl(svg: string): string;
// `Public` is what a facet/configurator may hold; `Grant` is what the account DO stores (§5.6).
export type AccountHandle<E, Public> = { env: E; creds: CredentialSource<Public> };

export function gatekeeperKit<E extends KitEnv, Grant, X, Public = Grant>(): {
  define(spec: GatekeeperSpecInput<E, Grant, X, Public>): GatekeeperSpec<E, Grant, X, Public>;
  resource<P extends Record<string, unknown>>(def: {
    supported: SupportedResource;
    tsType: string;                    // exported name in the effective types text (§5.10)
    hookTsType?: string;               // ditto, for resources whose sessions register hooks
    suggestedBindingName: string;      // e.g. "SUPABASE_PROJECT" — the resource *type*, not instance
    resolve?(url: URL): P | null;
    facet?(exports: X, props: KitAccountProps & P): DurableObjectClass<Gatekeeper<unknown>>;
    configurator?(h: AccountHandle<E, Public>): ResourceConfiguratorFrame;
    types?: string;                    // per-resource slice; default spec.types (§5.10)
  }): ResourceDef<E, Grant, X, Public>;
};

export type GatekeeperSpecInput<E, Grant, X, Public = Grant> = {
  id: string;                        // vendor id; names the dev BASE_URL default and log vendorId
  vendor: VendorDescription;         // the canonical type, reused directly
  auth: AuthStrategy<Grant, E>;      // the strategy mints and refreshes the *stored* grant
  account: {
    describe(h: AccountHandle<E, Public>): Promise<AccountDescription>;
    authenticatedEmail?(h: AccountHandle<E, Public>): Promise<string | null>;  // absent → null
  };
  resources: readonly ResourceDef<E, Grant, X, Public>[];
  types: string;                     // the types.txt text
  notConfigured?: { title: string; detail: string };
  logger?: KitLogger;
};
```

The factory is curried so the type parameters are written once per gatekeeper. **`Grant` and
`Public` are separate on purpose**: the strategy mints, refreshes and revokes the stored grant,
while everything reachable from a facet, configurator or verifier holds only the projection §5.6's
`publicCredentials` produces. Writing one letter for both is what would carry refresh material
across the RPC boundary, so the two are threaded apart from `gatekeeperKit()` down. `Public = Grant`
is the honest default for a gatekeeper with no refresh flow (github), and an explicit instantiation
rather than something to fall into. `X` is the
consumer's generated `Cloudflare.Exports` (from `wrangler types`), which is how spec closures like
`facet: (exports, props) => exports.SupabaseGatekeeperImpl({ props })` type-check without a cast;
the kit's own source never references the `Cloudflare` namespace. `define()` freezes the spec and
validates it: unique `urlPattern`s, a non-empty id, and — for every resource — that `tsType` and
`hookTsType` name exports of the effective types text (§5.10). `resource()` exists to infer `P`
from `resolve` and thread it into `facet`'s props parameter, then erase it. `getBaseUrl` returns
`env.BASE_URL ?? "http://localhost:8787/gatekeeper/${id}"` with trailing slashes stripped via the
existing `stripTrailingSlashes` from `workshop-shared/gatekeeper`. `notConfigured` defaults its
title to `${vendor.displayName} Gatekeeper Not Configured`.

### 5.2 `./auth` — the strategy seam

```ts
export type BeginResult = { redirectUrl: string } | { html: string };
export type AttemptMetadata = { connect?: GatekeeperConnectOptions; [key: string]: unknown };
export type StrategyAccountStub = { completeAuth(payload: unknown, state: string): Promise<boolean> };

export interface AuthStrategy<Creds, E extends KitEnv = KitEnv> {
  configured(env: E): boolean;
  routes(req: Request, ctx: { env: E; baseUrl: string; relPath: string; url: URL;
    accountForId(id: string): StrategyAccountStub }): Promise<Response | null>;
  begin(ctx: { env: E; baseUrl: string; accountId: string; state: string;
    metadata: AttemptMetadata; kv;            // "auth:"-namespaced view of account storage
    deliver(creds: Creds): Promise<void>;
    waitUntil(p: Promise<unknown>): void }): Promise<BeginResult>;
  obtain(ctx: { env: E; baseUrl: string; payload: unknown; metadata: AttemptMetadata;
    kv }): Promise<Creds>;
  refresh?(creds: Creds, ctx: { env: E }): Promise<Creds>;   // CredentialsExpiredError on grant death only
  revoke?(creds: Creds, ctx: { env: E }): Promise<void>;
  isAuthError(error: unknown): boolean;      // runtime API classification (CredentialSource.run)
  expiredMessage: string;
  expiresAt?(creds: Creds): number | undefined;
  refreshSkewMs?: number;
  // Layer 1's exact contract: names the keys it read, and never deletes them itself.
  upgradeStoredCredentials?(kv): UpgradedCredentials<Creds> | undefined;
}
```

The seam covers three known shapes: redirect flows with a provider callback (`oauth2`), form
flows with no provider round trip (`tokenAuth`), and poll-based flows that complete from inside
the DO — the Cloudflare Access CLI flow returns a redirect from `begin` while scheduling
`waitUntil(poll().then(deliver))`, and serves its transfer proxy from `routes`. `deliver` is
therefore fenced on its own: it captures the attempt generation and no-ops if a revoke or a new
attempt overtook it, since a poll flow commits after `begin` returned and the account's post-begin
re-check cannot cover it.

`upgradeStoredCredentials` is passed straight through as `CredentialCoordinator`'s `upgrade`, so it
takes that hook's shape and not a narrower one: `{ credentials, legacyKeys }`, reads only, with the
coordinator performing the deletes *after* the canonical record is written (§4.6). Returning bare
credentials would invite the hook to reap its own keys, and a Durable Object's implicit transaction
is not rolled back by a throw — so a hook that deleted first and then threw on a malformed record
would leave the account with no grant and nothing to retry from. The one contract, stated once.

A strategy that needs durable state beyond credentials (a DCR client registration, a PKCE
verifier) keeps it in its namespaced `kv` view, keyed by state — not in attempt metadata: that
record is written by `advanceToOAuth` before `begin` runs, and DO KV structured-clones on `put`, so
a value minted inside `begin` cannot reach it by mutation.

### 5.3 `./auth-oauth2`

```ts
export function oauth2<Creds, E extends KitEnv = KitEnv>(config: {
  authorizeUrl: string | ((env: E) => string);
  clientCredentials?(env: E): { id: string; secret: string } | undefined;  // default env.CLIENT_ID/SECRET
  scopes?: { full: string[]; auth?: string[]; param?: string; join?: string };
  extraAuthorizeParams?: Record<string, string>;
  pkce?: boolean;                                        // S256; verifier lives in the strategy's kv view, keyed by state
  exchange(ctx: { code: string; redirectUri: string; client: { id: string; secret: string };
    env: E; codeVerifier?: string; requestedScopes?: string[] }): Promise<Creds>;
  refresh?; revoke?; isAuthError; expiredMessage; expiresAt?; refreshSkewMs?;
  upgradeStoredCredentials?;
}): AuthStrategy<Creds, E>;
```

Behavior is byte-compatible with the handlers it replaces (`supabase.ts:267-334`,
`github.ts:931-1004`): `begin` returns a 302 to the authorize URL carrying `client_id`,
`redirect_uri = ${baseUrl}/oauth`, `state = ${accountId}:${stateNonce}`, scope/PKCE/extra params;
`routes` handles exactly `GET /oauth` — an `error` query parameter yields a 400 plain-text
"authorization failed, please restart the connection flow" response, missing or malformed
`state`/`code` yield 400, and otherwise it calls `accountForId(doId).completeAuth({ code },
nonce)` and renders `SELF_CLOSING_HTML` or `INVALID_LINK_HTML`. `scopes.auth` is the sign-in-only
subset used when `GatekeeperConnectOptions.scopes === "auth"`. The README instructs config
authors to wrap provider refresh calls so only 400/401/`invalid_grant`/`invalid_token` become
`CredentialsExpiredError` and everything else rethrows untouched.

### 5.4 `./auth-token`

`tokenAuth<Creds, E>(config)` for user-pasted secrets (the shape internal gatekeepers like sentry
need): `begin` returns `{ html }` — a minimal form styled with `PAGE_STYLE`, fields from
`config.fields: { name, label, secret?: boolean }[]`, a hidden `state`, posting to
`${baseUrl}/connect/${accountId}`; `routes` handles that POST and calls
`completeAuth(formFields, state)`; `obtain` delegates to
`config.validate(fields, env): Promise<Creds>`, and a validation throw renders `errorPageHtml`.
`configured` is always true; no refresh or revoke by default.

### 5.5 `./http`

```ts
export function handleGatekeeperHttp<E extends KitEnv, Creds>(req: Request, opts: {
  env: E;
  spec: GatekeeperSpec<E, Creds, any>;
  accountForId(id: string): AccountStub<Creds>;
  routes?(req: Request, url: URL, relPath: string): Promise<Response | null>;
}): Promise<Response>;
```

Routing order: base-path guard (throws on a mismatched prefix, preserving current behavior at
`supabase.ts:270-273`); the initiation link `/<64-hex DO id>/<64-hex nonce>` — when
`spec.auth.configured(env)` is false it renders the spec's not-configured page, otherwise it calls
`accountForId(doId).beginAuth(nonce)` and renders the redirect, the strategy's HTML, or
`INVALID_LINK_HTML` for null; then `spec.auth.routes`; then the consumer's `routes` escape hatch;
then 404.

### 5.6 `./account` — `KitUserAccountBase<E, Creds, Public>`

An abstract `DurableObject<E>` subclass. Configuration arrives through a symbol-keyed hook —
symbols cannot be dispatched over RPC, following `mcp-shared/src/user.ts:31-38`:

```ts
export const kitAccountConfig: unique symbol;
protected abstract [kitAccountConfig](): {
  spec: GatekeeperSpec<E, Creds, any>;
  mintUser(): Fetcher<GatekeeperUser>;     // e.g. this.ctx.exports.GatekeeperUserImpl({ props })
};
```

Public loopback-RPC methods and their sequencing:

- `setCallback(callback, initiationNonce, options?: GatekeeperConnectOptions)` — stores the
  callback under `"callback"`, connect options under `"connectOptions"`, `"ephemeral"` when
  `options?.scopes === "auth"`; `putInitiation`; mints and stores a fresh random
  `"attemptGeneration"`; sets a `CONNECT_TIMEOUT_MS` self-destruct alarm when no credentials
  exist.
- `prepareReconnect(nonce)` — sets `"reconnecting"`, `clearCredentialExpiryLatch`,
  `putInitiation`, fresh `"attemptGeneration"`.
- `beginAuth(nonce)` — `advanceToOAuth` with `{ connect }` metadata, then `strategy.begin`; after
  `begin`'s awaits, re-checks `"attemptGeneration"` and returns null on mismatch (rendered as an
  invalid link). Returns the `BeginResult` otherwise.
- `completeAuth(payload, state)` — `claimOAuth`, then `strategy.obtain`, then re-checks
  `"attemptGeneration"` and returns false on mismatch. This closes the revoke race: a `revoke()`
  that ran during the token exchange has already cleared the generation, so the exchange result
  is discarded instead of resurrecting credentials after `deleteAll()`. On success:
  `coordinator.commit`, `clearCredentialExpiryLatch`, clear `"attemptGeneration"`; then
  `callback.credentialsRestored()` when reconnecting, else `callback.complete(mintUser())` with
  credential rollback if `complete()` throws (the github pattern at `github.ts:1120-1127`);
  ephemeral sign-in accounts arm a 2-minute self-destruct alarm, everything else
  `deleteAlarm()`s.
- `getCredentials()` — `coordinator.fresh(strategy.refresh)`, projected through
  `config.publicCredentials` and returned as `{ creds, identity }` (the coordinator's current
  credential identity, reissued on every `commit`/`clear`). A still-current
  `CredentialsExpiredError` from refresh triggers `noteCredentialsExpired()` and rethrows as the
  strategy's `expiredMessage`; any other refresh error rethrows with credentials intact. **The
  projection is not optional — see below.**
- `noteCredentialsExpired(identity)` — no-ops unless `identity` matches the coordinator's
  current one (a stale notifier lost the race to a reconnect); otherwise delegates to
  `notifyCredentialsExpiredOnce` with `vendorId = spec.id`.
- `revoke()` — clears `"attemptGeneration"` first, then best-effort `strategy.revoke` (failures
  log `error` with event `oauth.grant.revoke.failed`), `deleteAlarm()`, `deleteAll()`.
- `alarm()` — `deleteAll()` when no credentials exist or the account is ephemeral.

Storage keys owned by the base: `"callback"`, `"nonce"`, `"reconnecting"`, `"expiredNotified"`,
`"credentials"`, `"connectOptions"`, `"ephemeral"`, `"attemptGeneration"`. The first four match
every existing OAuth gatekeeper, so live accounts keep working across a port.

**Refresh material must not cross the account boundary.** `AuthStrategy.refresh(creds)` and
`revoke(creds)` (§5.2) take `Creds`, so for any gatekeeper with a refresh flow `Creds` *is* the
stored grant, refresh token included. `getCredentials()` is called by the User entrypoint, every
facet, and every verifier, and `CredentialSource` caches what it returns for 30s in each of them —
so returning the coordinator's `Creds` unprojected would hand long-lived refresh authority to every
consumer and cache it there. That is a capability regression against the whole corpus, not a
theoretical one: **0 of 5** OAuth gatekeepers checked return refresh material over that boundary.
Each returns a narrow projection and refreshes *inside* the account DO — supabase
`{ token, expiresAt }` (`supabase.ts:80-83, 469-479`), github the access token string
(`github.ts:1141-1147`), google `{ token, expires }` (`google-api.ts:42-45`), linear and notion
access-token strings (`linear.ts:601-620`, `notion.ts:419-427`), with notion's separate
`refreshCredentials()` RPC still keeping the refresh token in the DO.

So the config hook requires a projection, and its return type — not `Creds` — is what the consumer
side is generic over:

```ts
protected abstract [kitAccountConfig](): {
  spec: GatekeeperSpec<E, Creds, any>;
  mintUser(): Fetcher<GatekeeperUser>;
  /** What a facet/verifier may hold. Omit nothing sensitive: this crosses the RPC boundary. */
  publicCredentials(creds: Creds): Public;
};
```

Layer 1 already permits this and needs no change: `CredentialCoordinator<Creds>`,
`AccountCredentialStub<Creds>`, and `CredentialSource<Creds>` are three *independent* type
parameters that merely share a letter, so `CredentialCoordinator<Grant>` in the DO alongside
`CredentialSource<AccessToken>` in the facet already type-checks today. The leak would be introduced
here, by wiring the two to one type — which is precisely why this is written down before §5.6 is
built. `KitUserAccountBase<E, Creds, Public>` gains the third parameter; where a gatekeeper has no
refresh flow (github), `Public = Creds` is a legitimate instantiation, not a default to fall into.

### 5.7 `./vendor` — `KitVendorBase<E>`

Abstract `WorkerEntrypoint<E>` with hook `[kitVendorConfig](): { spec; accounts():
DurableObjectNamespace<…> }`. Implements `describe()` (returns `spec.vendor` as-is),
`connectAccount(callback, options?)` (`newUniqueId`, `generateNonce`, `setCallback`, returns
`{ url: `${getBaseUrl(env, spec.id)}/${id}/${nonce}` }`), `getSupportedResources()`
(`spec.resources.map(r => r.supported)`), and `getTypeScriptTypes()` (`spec.types`).

### 5.8 `./user` — `KitUserBase<E, Creds, X>`

Abstract `WorkerEntrypoint<E, KitAccountProps>` with hook `[kitUserConfig](): { spec; exports():
X; account(): AccountStub<Creds> }`. The typed `exports()` closure is what lets the default
resolver call `def.facet(exports(), props)` without a cast. Implements:

- `describe` / `getAuthenticatedEmail` via `spec.account.*` with a lazily built `AccountHandle`
  (a `CredentialSource` over `account()`).
- `getSupportedResources`.
- Default `getGatekeeperClassFor(url)`: the first resource whose `resolve(new URL(url))` returns
  non-null wins, yielding `{ class: def.facet(exports(), { userObjectId, ...props }), resource:
  def.supported }`; no match throws `Unsupported ${spec.vendor.displayName} URL: ${url}`.
  Gatekeepers with irregular URL grammars (github's repo-with-refinements, email's mailbox
  claiming) override the method; it is a normal public method on the subclass.
- `startResourceConfigurator(pattern)`: matches `def.supported.urlPattern` exactly and returns
  `def.configurator(handle)`; unknown patterns throw, as today.
- `revoke` / `reconnect` via the account stub; `reconnect` returns a fresh initiation URL.
- `ensureResources` returns `{}` (override for scope-expanding vendors).
- **Abstract `getVerifier()`** — every consumer implements it (with `@skipRpcValidation()`, since
  Fetcher returns cannot be validated), because the verifier class and its props are
  vendor-specific.

### 5.9 `./facet` — `KitGatekeeperBase<E, Props extends KitAccountProps, Session>`

Abstract `DurableObject<E, Props>` with hook `[kitFacetConfig](): { spec; resource:
ResourceDef<…>; observers: ObserverStrategy; actions?: BoundActionSet<any> }`, invoked per call so
the hook can branch on `this.ctx.props` (supabase: project bindings return the project def and
`aclObservers`, organization bindings the organization def and `trackedSetObservers`). Implements
`getTypeScriptTypes` (`resource.types ?? spec.types`), `getAutoApprovableActions`
(`actions?.autoApprovableKinds() ?? []`), `applyAction`/`rejectAction` (dispatch straight to
`actions`, which already serializes both on the queue it owns — §4.8 — and throwing when no actions
are configured), `addObserver`/`removeObserver` (delegating to the strategy), a protected
`observationGate(queue)` helper that `.dup()`s the queue and binds the strategy, and a protected
`resourceDescription(dynamic: { url: string; title: string; snippet: string; hasSlashCommands?:
boolean }): ResourceDescription` helper that merges the def's static `tsType`/`hookTsType`/
`suggestedBindingName` with the live fields. `describe()` and `startSession(queue)` stay
abstract — resource metadata lookups and the session API are the gatekeeper — but a typical
`describe()` is now one fetch plus `return this.resourceDescription({...})`.

**The hook returns activation-scoped values; it must not construct them.** `actions` and
`observers` both carry in-memory state that is the whole point of them: `BoundActionSet` owns the
`SerialTaskQueue` every resolution is ordered on plus the `appliedHere`/`claimedHere` sets, and
`ObserverTracker` owns the admission/removal fence. A hook calling `defineActions(...).bind(...)` or
`trackedSetObservers(...)` inline — the shape a per-call hook invites — hands every call a fresh
queue and empty sets, which silently voids both guarantees while every test still passes. So the
hook resolves them from instance fields, built once per activation and memoized per `ctx.props`
when a facet serves more than one resource kind; the base's own doc comment says so, and the
fixture asserts two concurrent `applyAction` calls share one queue.

**The revert seam.** Revert behavior is not declarative (see §4.8's doctrine): the base implements
`revertAction(id)` as `actions.queue.run(...)` — the very queue `apply`/`reject` run on (§4.8) —
dispatching to a `protected revert?(id: number): Promise<void | { message?: string; canRetry?:
boolean; restart?: boolean }>` hook → throw not-implemented when the hook is absent. The consumer's
hook is ordinary TypeScript reading the journal directly (`journal.get(id)`, switch on kind —
github's and linear's existing `revertAction` bodies port nearly verbatim), but the *seam* stays
kit-owned: revert-vs-apply is the most race-sensitive pair in the corpus (notion's
`laterConflictingApplied` ordering check assumes non-interleaving), so a hand-written public
method skipping the queue would be a concurrency regression. Retention consistency is enforced
by an **assert, not derivation** — the consumer calls `bind(journal, host)`, which has no channel
for the facet's hook, and behavior must live on a named surface: at hook-return the base throws
a named config error when a revert hook is present, actions are configured, and
`actions.retainsApplied` is false. Same guarantee (you cannot ship revert without retention) and
it fails on the first facet call, i.e. in every test; `retainApplied: true` without a hook stays
legal (notion-style overlay/history retention). After the hook completes, the base fires
`afterResolve(host, "reverted")`, so the invalidation hook covers all resolution sites.
Overriding the public `revertAction` itself bypasses both the queue and the assert — that is the
"you own everything" tier, not the intended hatch.

### 5.10 The agent type contract

`types.d.ts` remains the hand-authored source of truth, unchanged by the kit. Its JSDoc is the
agent's entire documentation for the session API, and it is the artifact reviewed at the
`write-gatekeeper` skill's Phase-1 STOP gate before any implementation exists, so the kit never
generates it — not from session implementations, and not from the spec. The `types.txt →
types.d.ts` symlink also stays: the worker imports the symlink as a Text module and hands it to
`spec.types`, which makes the runtime text and the compile-time declarations identical by
construction.

What the kit adds is enforcement of the seams that are stringly today:

- **Name integrity.** `ResourceDescription.tsType` must name an export of the returned types text
  (`workshop-shared/gatekeeper.ts` requires this; nothing checks it today, and a drifted name
  breaks the agent's type database at runtime). Under the kit the names live in the resource def
  next to the slice they must exist in, and `define()` throws at module init when
  `tsType`/`hookTsType` does not match an `export interface|type|class` declaration in
  `resource.types ?? spec.types`. A regex-level check, deliberately: it catches renames and
  typos, and a full TS parse would buy little because shape agreement is enforced elsewhere.
- **Shape integrity.** Session implementations declare `implements` against the interfaces in
  `types.d.ts` and carry `@validateRpc()`, so `capnweb-validate` validates every RPC call against
  the same declarations the agent reads. The kit does not add machinery here; it inherits it.
- **The residual gap, stated honestly:** TypeScript cannot verify that the exported *name* inside
  a serialized text blob denotes the type of a given session object. The single-file symlink case
  closes it by construction (same declarations); multi-file vendors keep the parity-test pattern
  (`gatekeeper-google/__tests__/types-parity.test.ts`); the `define()` check covers name drift in
  between. This gap exists today too — the kit narrows it and documents it.

Vendor-level `getTypeScriptTypes()` returns `spec.types` (for a multi-service vendor, the
concatenation of its per-service files); each facet returns only its slice via `resource.types`,
the google pattern. Gatekeepers whose types are runtime data (the MCP connectors generate
declarations from live tool schemas) override `getTypeScriptTypes()` on their facet and skip the
static path; the `define()` name check applies only to static defs, so a def may omit
`resolve`/`facet` and carry a placeholder text without fighting the validator.

## 6. Build & validation constraints

These are load-bearing; the fixture suite (§7 step 11) exists to prove each one.

- **Named exports and migrations.** `ctx.exports.X` and `wrangler.jsonc` migrations resolve by
  export name, so consumers subclass the bases under their own names (`export class UserAccount
  extends KitUserAccountBase<Env, SupabaseCredentials> { … }`). The kit never dictates names.
- **`@validateRpc()` stays in the consumer.** `capnweb-validate build` transforms only the
  consuming package's source tree, so kit bases are undecorated and every consumer decorates its
  subclasses. `gatekeeper-mcp` proves decorated subclasses of imported generic bases transform
  correctly (`mcp.ts:242`, `:487-488`). If the transform rejects a facet subclass over the
  generic `Gatekeeper<Session>` surface, the documented explicit form
  `@validateRpc<Gatekeeper<SupabaseProject | SupabaseOrganization>>()` is the fallback.
- **workerd for nonce tests.** `crypto.subtle.timingSafeEqual` does not exist in Node, so the
  kit runs two vitest projects: `vitest.config.ts` (Node, pure modules: actions, observers,
  credentials, auth-retry, simulation, cache, connect-pages, endpoint, spec, http routing) and
  `vitest.worker.config.ts` (workerd: connect-nonce, connect-handshake, credential-expiry,
  cursors, the action queue, and the fixture). The workerd project loads
  `scripts/assert-workerd.ts` so a broken pool fails loudly. `connect-pages` and `endpoint` are
  Node suites because they assert only `Response` headers, escaped HTML, and `URL` parsing —
  `Request` and `URL` behave identically under both. `credential-expiry` and the
  `SerialTaskQueue` suite stay in workerd even though their APIs exist in Node: their subject is
  in-flight promise dedup with throwing callbacks, and workerd's eager unhandled-rejection
  reporting is a load-bearing part of what they defend (§4.8).
- **One shared KV fake, because a `Map` is not one.** Every suite takes its KV from
  `__tests__/fake-kv.ts` rather than hand-rolling a `Map`, since real `ctx.storage.kv` differs from a
  `Map` in two ways that each hide a class of bug — both established by probing workerd, not
  reasoned about. It **structured-clones on write and on read**: mutating what you passed to `put`
  does not change what is stored, `get` never returns the object written, and two `get`s of one key
  return different objects — so a reference-returning fake lets a module mutate stored state in
  place while a test still reports "one write", and would let a regression from opaque-identity
  comparison to reference equality pass. And its **`list` is lexicographic, not insertion-ordered**:
  real scans yield `…:10` before `…:2`, so an insertion-ordered fake silently satisfies any test
  that should have caught a missing numeric sort — `listPending`'s was exactly that test, and now
  fails without the sort. An RPC stub is the one value that cannot be cloned (the RPC system
  re-materializes it), and storing verifier stubs is a shipped pattern, so the fake passes a
  non-cloneable value through by reference.
- **A test that cannot fail is a finding.** Three of these were fixed rather than left: the
  `listPending` order above; the `ObservationGate` ordering test, whose `prepare` resolved
  synchronously and so could not distinguish "authorize after prepare" from "authorize before it"
  (it now parks on a resolver the test controls, and asserts the queue is untouched while it does);
  and the OAuth-claim rejections, every one of which an implementation deleting the record *before*
  validating would also satisfy, so a separate test now proves a wrong claim leaves the attempt
  claimable and a right one consumes it exactly once. The wire-visible constants
  (`NONCE_KEY`, `NONCE_BYTES`, and the four durations) are pinned as literals for the same reason:
  each is observable outside the kit, and turning ten minutes into a day is a security decision, not
  a tuning one.
- **Facets are reachable only via `ctx.facets`.** Tests drive the fixture facet through a
  `TestHooks` DO, exactly as `gatekeeper-cloudflare/__tests__` does.
- **`ctx.exports` typing** comes from each consumer's generated `Cloudflare.GlobalProps`; the
  fixture declares its own in `__tests__/fixture/env.d.ts` (the `gatekeeper-mcp/src/env.d.ts`
  pattern).

## 7. Work breakdown

Each step leaves the tree building; tests land with the module they cover. Nothing outside
`packages/gatekeeper-kit` changes before step 12.

1. **Scaffold the package.** `package.json` (name `@gadgets/gatekeeper-kit`, private, `type:
   module`, per-file `exports` map for every module in §4/§5; scripts `build`, `clean`, and
   `test:run: "vitest run && vitest run -c vitest.worker.config.ts"` as a direct script beside
   the cached Vite `test` task; dependencies `@gadgets/workshop-shared`,
   `@gadgets/backend-utils` (both `workspace:*`); devDependencies
   `@cloudflare/vitest-pool-workers`, `typescript`, `vitest`, all `catalog:`). As landed the
   scaffold is deliberately leaner than first sketched: **one** `tsconfig.json` covering `src`
   and `__tests__` on `@cloudflare/workers-types/experimental` — no `tsconfig.test.json` and no
   checked-in `worker-configuration.d.ts` to drift — and no `capnweb`, `capnweb-validate`, or
   `@types/node`, since Layer 1 has no capnweb runtime path; those arrive when the Layer-2
   fixture needs them. `vite.config.ts` re-exports the shared vitest task:
   `vitestTaskViteConfig('pnpm test:run')`. Run `pnpm install`.
2. **`connect-nonce`, `connect-handshake`, `connect-pages`, `endpoint` (§4.1–4.3, §4.14).** workerd
   tests: nonce round-trip and TTL expiry; stage transitions; exactly one concurrent
   `advanceToOAuth` succeeds per attempt; a wrong initiation nonce does not consume the attempt;
   `claimOAuth` is one-shot and returns `Extra`; legacy records without metadata are accepted.
   Node tests: `escapeHtml` and `errorPageHtml` escaping; `htmlResponse` carrying all four
   headers; `connectMutationError` refusing an absent or foreign `Origin` and an absent or wrong
   content type, and matching a content type case-insensitively and past its parameters;
   `normalizeVendorOrigin` returning a bare origin for a URL carrying path, query and userinfo,
   refusing `http:` by default and accepting it under `requireHttps: false`, refusing a non-HTTP
   scheme either way, refusing an explicit port and a suffix host against an anchored pattern, and
   never echoing the input in any thrown message.
3. **`credential-expiry` (§4.4).** workerd tests: notifies once; a failed callback leaves the
   latch unset and a later call notifies again; concurrent callers share one in-flight
   notification; the latch write happens only after the callback resolves (assert with a
   late-resolving callback); `clearCredentialExpiryLatch` re-arms.
4. **`http-errors` + `observers` (§4.5, §4.7).** Node tests with a Map-backed KV stub and fake
   verifiers: 401/403/404 classify as no-access and 5xx rethrows; a throwing `verifyBaseline`
   propagates before any `hasSetAccess` call;
   re-read-until-stable admission (a set appearing mid-check is verified before the verifier
   persists); batched oracle called once per admission round; a legacy stored `true` reads as
   observed and re-reading it is not a fresh reveal; an overlapping `setPrefix` is refused in
   either direction; per-set deny messages; pending-before-await then commit promotion; forward exclusion lists
   exactly the observers lacking access, and excludes one whose verifier throws rather than failing
   the read; `removeObserver` idempotence, and a removal mid-admission refusing the admission;
   `ObservationGate` ordering
   (`prepare` → `authorizeObservation` with `excludeObservers` → `commit`; no commit when
   authorization throws); `escapeObservationValue` flattening each newline run to one space and
   escaping every control character while leaving prose and the empty string alone; a gate
   constructed with `sanitize` delivering sanitized `title` and `description` *and* still merging
   both exclusion sources, and one constructed without it delivering the caller's own object.
5. **`credentials` (§4.6).** Node tests: skew-aware reuse; two concurrent `fresh` calls share one
   refresh; a `commit` (reconnect) during an in-flight refresh wins and `fresh` returns the newer
   credentials; a `clear` during an in-flight refresh yields `CredentialsExpiredError`; a refresh
   throwing `CredentialsExpiredError` propagates only when its snapshot is still current — after
   a concurrent `commit` it is fenced and `fresh` returns the newer credentials with no expiry
   signal; a `refreshSkewMs` override refreshes a token the default window would leave alone;
   `identity()` is reissued on every `commit`/`clear` and never repeats a wiped value — fenced
   against a **raw** wipe of both keys (what `deleteAll()` leaves), the only form that proves
   `stored()` lazily mints one for a pre-kit record; the migration is retired by `clear()` both
   before the first read and after an upgrade already adopted the grant; any other refresh error
   leaves `stored()` unchanged and rethrows; `upgrade` runs once and persists. For
   `CredentialSource`: the 30s record cache re-fetches once stale, and an auth failure drops the
   in-flight fetch so the next caller does not receive credentials already reported expired. For
   `withAuthRetry` (§4.13): the success path asks for a token once with `forceRefresh: false`; a
   non-auth error at either attempt propagates with no refresh and no report; an auth error
   refreshes with `{ forceRefresh: true, staleToken }` and returns the replay's result; two auth
   errors report the *second* one and throw it; a throwing reporter is logged and still throws the
   auth error; and with no reporter configured the second error still surfaces.
6. **`actions` (§4.8).** Node tests: sequential IDs; staged→pending transitions; the default
   keys landing records at `pending:action:<id>` with counter `pending:nextActionId` (a
   live-storage contract for the supabase/google-family ports, so those literals are
   load-bearing); `stageAction`
   rolls back when `submitAction` throws (fake queue); `apply` resolves a still-`staged` record
   (the output-gate/crash window); `listPending` ordering, and its scan staying confined to the
   pending prefix (a retained record moves tiers and `get`
   still finds it); `upgradeRecord` wraps kindless legacy records; dispatch including the
   unknown-id throw; apply-throw retains the record and fires `afterResolve("failed")`; the
   retained record carries the artifacts the handler returned;
   `retainApplied: true` marks-and-moves where the default removes; a replayed `apply` of a
   retained record resolves void without re-running the handler or firing `afterResolve` while
   `reject` on it still throws "no longer pending"; `afterResolve` fires with the
   right outcome, and a throwing hook is logged but never masks the apply error nor fails a
   successful resolution; `reject` removes and no-ops on an unknown id, but refuses one racing an
   apply that already ran; an interrupted `retain` keeps the applied record. For the claim
   lifecycle (§4.8): `listPending` projects a `claimed` record and not a `failed` one; no
   transition moves a settled record and the first stored failure message wins; `maxPending`
   refuses `allocate` and `submit` at the cap while writing nothing, and a `failed` record does not
   count against it; `claimBeforeApply` plus a plain throw restores `pending` and a second apply
   reaches the provider; an `ActionApplyError` records the failure, answers every replay from the
   record with no provider call, and is cleared only by `reject`; a claim a second bind finds
   over the same journal is converted to `APPLY_OUTCOME_UNKNOWN_MESSAGE` by both verbs without
   running a handler; and a journal write that fails *after* the handler succeeded leaves the
   record `claimed`, fires no hook, and is reported unknown on the next attempt rather than being
   rolled back to `pending`. `SerialTaskQueue`
   ordering and rejection isolation live in the **workerd** project
   (`__tests__/workerd/serial-queue.test.ts`), since rejection reporting is the subject.
7. **`simulation` + `cache` + `cursors` (§4.9–§4.11).** Node tests: view sorts once and indexes
   multi-target
   actions; replay applies in order, skips `known-no-effect`, stops at the first `unsupported`
   with the record and reason; `ProvisionalIds` allocate/bind/resolve with plain and prefixed
   formatters; a `kind` recorded by `allocate` surviving a new instance, `requireResolved`
   refusing a mismatched `expectedKind` with the exact message even while unbound, and an
   untagged or real id passing through; cache TTL and generation bump. Cursors get their **own**
   workerd suite
   (`__tests__/workerd/cursors.test.ts`) rather than waiting on step 11's fixture, since they
   extend `RpcTarget`: overlay/filter over a mocked paged API, empty-page exhaustion versus a
   short page, serialized `next()`, terminal failure, the 50-page barren default cap, and a
   simulated item surfacing through a run of filtered pages. `TokenCursor` adds: a walk mixing an
   empty-page-with-token and a `""` token yielding every item then `null` (the marketo shape); 50
   provider-empty windows returning `[]` at the cap and the walk resuming afterwards; an echoed
   token throwing and latching; locally-filtered pages throwing at the cap unless something is
   buffered; and `map` applying to raw pages. The
   fixture still exercises them, but for assembly behavior rather than first coverage.
8. **Assembly: `spec`, `auth`, `auth-oauth2`, `auth-token`, `http` (§5.1–5.5).** Node tests for
   the pure parts: `define` rejects duplicate `urlPattern`s and rejects a `tsType`/`hookTsType`
   that is not exported from the effective types text (§5.10); default resolver precedence;
   `getBaseUrl` defaulting; authorize-URL construction (state format, scope join, PKCE challenge,
   extra params); handler routing against `Request` objects and a stubbed `accountForId`
   (initiation-link shape gate, not-configured page, `/oauth` error and missing-parameter
   branches, fall-through to consumer routes, 404).
9. **Assembly bases: `account`, `vendor`, `user`, `facet` (§5.6–5.9).** Exercised end to end in
   step 11.
10. **Kit `README.md`.** Architecture and the à-la-carte doctrine; per-module docs; consumer
    obligations (named exports, migrations, decorated subclasses, `@skipRpcValidation()` on
    `getVerifier`, `env.d.ts`, `types.txt` symlink); the `AuthStrategy` contract with the
    Cloudflare Access CLI mapping sketched (redirect plus `waitUntil(poll → deliver)` plus a
    transfer-proxy route); storage-compat options for ports; the grant-death doctrine and the
    explicit warnings that credential rotation is not transactional, that action apply is
    at-least-once unless the definition sets `claimBeforeApply`, and that a retaining gatekeeper
    owns GC of its retained journal tier.
11. **Fixture gatekeeper + workerd suite.** `__tests__/fixture/worker.ts` builds a complete
    "Acme" gatekeeper the intended consumer way: `gatekeeperKit<FixtureEnv, AcmeCreds,
    FixtureExports>()`, `oauth2` against `https://acme.test` endpoints mocked with `fetchMock`
    from `cloudflare:test`, one `https://acme.test/w/:id` resource with a configurator, decorated
    `GatekeeperVendor`/`GatekeeperUserImpl`/`AcmeGatekeeperImpl` subclasses plus an undecorated
    `UserAccount`, a one-method verifier, `defineActions` with one kind, `aclObservers`, and a
    session that authorizes reads through `ObservationGate` and returns a `StreamingCursor`.
    Alongside it: a `TestHooks` DO for facet access, a `GatekeeperConnectCallback` entrypoint
    capturing `complete`/`credentialsExpired`/`credentialsRestored`, and a fake `ApprovalQueue`
    recording calls. `vitest.worker.config.ts` runs `capnwebValidate()` plus `cloudflareTest`
    (compatibility date `2026-02-02`, flags `allow_irrevocable_stub_storage` + `nodejs_als`, the
    three DOs). Tests: the full connect round trip (connectAccount URL → initiation fetch → 302
    with state → `/oauth` callback → mocked token exchange → `complete()` delivering a working
    user stub); concurrent `beginAuth` advancing exactly once; the revoke-during-obtain race
    (`beginAuth` → `revoke()` → `/oauth` callback: `completeAuth` returns false and storage stays
    empty); ephemeral sign-in self-destruct via `runDurableObjectAlarm`; reconnect →
    `credentialsRestored`; a mocked 400 `invalid_grant` refresh notifying `credentialsExpired`
    exactly once and re-notifying after a failed callback; a mocked 500 refresh propagating with
    stored credentials intact and the next `getCredentials` retrying; revoke; `getGatekeeperClassFor`
    through facet `describe`/`startSession`; observation data withheld until `authorizeObservation`
    resolves (assert ordering) with each cursor page authorized; action submit → pending →
    apply/reject including submit-failure rollback; a hand-written `protected revert(id)` hook —
    the fixture implements one reading the journal, proving the escape hatch is load-bearing —
    dispatched through the queue (interleaving asserted against a concurrent apply), bound with
    `retainApplied: true` so its record survives apply, and firing `afterResolve("reverted")`;
    the facet-base assert rejects (named config error) a revert hook whose actions don't retain;
    a stale-identity `noteCredentialsExpired` after a reconnect no-ops; with the
    hook absent, `revertAction` throws not-implemented; strategy-B observer denial. This suite is
    also the proof that decorated subclasses of the kit's generic bases survive the
    `capnweb-validate` transform.
12. **`mcp-shared` cutover.** Delete `packages/mcp-shared/src/connect-nonce.ts` and `src/html.ts`;
    re-point every import of them — `mcp-shared/src/{account,http,tools,user,util}.ts`,
    `gatekeeper-mcp/src/{mcp,connect-form}.ts`, `gatekeeper-mcp-portal/src/portal.ts` (verify the
    list with `grep -rn 'connect-nonce\|\./html' packages/mcp-shared packages/gatekeeper-mcp
    packages/gatekeeper-mcp-portal`) — at `@gadgets/gatekeeper-kit/connect-nonce`,
    `/connect-pages`, and `/credential-expiry`. Move `DEFAULT_TOKEN_LIFETIME_S = 60 * 60` local to
    `account.ts`. Replace `McpAccountBase`'s hand-rolled expiry latch with
    `notifyCredentialsExpiredOnce`/`clearCredentialExpiryLatch`, adding `protected abstract
    vendorId(): string` implemented by both connectors (`"mcp"`, `"mcp-portal"`). Keep a
    file-local pure-JS `constantTimeEqual` in `account.ts` with a comment naming the reason (its
    account tests run in Node, where `crypto.subtle.timingSafeEqual` is unavailable; every Worker
    runtime path uses the kit comparator). Drop `escapeHtml` from `util.ts` in favor of
    `connect-pages`. Add `@gadgets/gatekeeper-kit` to the three `package.json`s; update
    `mcp-shared/README.md` and `__tests__/account-endpoint.test.ts` imports.
13. **Port `gatekeeper-supabase`.** In `supabase.ts`, delete the plumbing: nonce/TTL constants
    (:65-70), `StoredNonce`/`StoredToken` (:74-83), HTML constants and nonce/base-url helpers
    (:138-191), the fetch handler (:267-334), the `GatekeeperVendor` body (:339-368), the
    `UserAccount` body (:373-544), the `GatekeeperUserImpl` body except `getVerifier` (:549-672),
    `PendingActionStore` and `SupabaseCache` (:745-806), the facet's token cache and observer
    internals (:925-1018, :1146-1187), and the action methods (:1090-1126). Replace with:
    - `type SupabaseCredentials = { accessToken: string; refreshToken: string; expiresAt: number }`.
    - A `gatekeeperKit<Env, SupabaseCredentials, Cloudflare.Exports>()` spec. The `oauth2` config
      wraps the untouched `supabase-api.ts` helpers (`exchangeAuthCode`, `refreshAccessToken`,
      `revokeRefreshToken`); its `refresh` maps `SupabaseApiError.isAuthError` (the client
      derives it from 401/403) to `CredentialsExpiredError` and rethrows everything else
      untouched, so infrastructure failures stop destroying sessions; `extraAuthorizeParams:
      { response_type: "code" }`; `expiredMessage` and the not-configured wording preserved
      verbatim; `upgradeStoredCredentials` reports the legacy keys
      `accessToken`/`refreshToken`/`accessTokenExpiresAt` as `{ credentials, legacyKeys }` and lets
      the coordinator reap them once the canonical record is written.
    - Resource defs gain the static contract fields: the project def `tsType: "SupabaseProject"`,
      `suggestedBindingName: "SUPABASE_PROJECT"`; the organization def `tsType:
      "SupabaseOrganization"`, `suggestedBindingName: "SUPABASE_ORGANIZATION"` — moved out of the
      facet's `describe()` (:1049-1067), which shrinks to metadata fetches plus
      `this.resourceDescription({...})`.
    - Thin subclasses with unchanged export names (`GatekeeperVendor`, `UserAccount`,
      `GatekeeperUserImpl`, `SupabaseGatekeeperImpl`; `SupabaseVerifier` untouched), and a
      default export wiring `handleGatekeeperHttp`.
    - `SupabaseSessionContext` (:814-913) survives, rebuilt on kit pieces: `ObservationGate`
      (project bindings `aclObservers`, organization bindings `trackedSetObservers` with
      `setPrefix: "observedProject:"` and `verifyBaseline` throwing the existing org-membership
      denial — the legacy stored `true` needs no flag — denial messages preserved verbatim from
      :1152-1179), `BoundActionSet.submit`
      (the SQL `ActionDescription` text preserved verbatim from :896-907), `KvTtlCache`, and
      `CredentialSource`.
    - The facet keeps `describe()` per resource kind (:1045-1068) and `startSession` (:1078-1084).
      Actions: `defineActions<SupabaseActionHost, { execute: StoredExecuteAction }>` whose
      `apply` preserves :1096-1108 (auth failure notes expiry and throws the "reconnect, then
      retry" message without removing the record), with `afterResolve` bumping the cache
      generation on `"applied"`. No `revert` hook and `retainApplied` unset, so records are
      removed on apply (the facet-base assert is trivially satisfied) — storage byte-identical
      to today. The dead-code
      compensating-statement message (:1120-1126) is intentionally dropped: the path is
      caller-less (`submitAction` sets `implementsRevert: false`, nothing in the repo calls
      `Gatekeeper.revertAction`), and the manual-revert path already shows the SQL via the action
      description. Journal options: `{ upgradeRecord: wrap kindless legacy records as execute }`
      only — supabase's live keys `pending:nextActionId` and `pending:action:` are the kit
      defaults (§4.8), so restating them would be noise.
    - Session implementations (:1208-1444), configurators, `types.d.ts`, and `supabase-api.ts`
      stay as they are apart from context-method renames.
14. **Port safety net.** `packages/gatekeeper-supabase/__tests__/`: Node tests for
    `upgradeStoredCredentials` (legacy keys convert and are deleted) and the journal's
    legacy-record upgrade; a workerd `connect-flow.test.ts` against the real `UserAccount`
    subclass (single-use initiation advance under concurrency, wrong-nonce rejection without
    consuming the attempt, wrong-state `completeAuth` rejection), with its own
    `vitest.worker.config.ts` (`capnwebValidate` + `cloudflareTest` with the `UserAccount` DO +
    `assert-workerd`) and `__tests__/env.d.ts`. Switch `vite.config.ts` to the `withTests`
    re-export from `scripts/gatekeeper-configurator-vite-config.js` and add `test:run` plus the
    vitest devDependencies. `wrangler.jsonc` must show a zero diff.
15. **Repo docs.** Add the `packages/gatekeeper-kit` bullet to the root `AGENTS.md` project
    structure (after `packages/mcp-shared`): two layers, escape hatches, supabase as the
    assembly reference, mcp-shared as the leaf-only reference, new gatekeepers start here.
16. **Skill rewrite.** `.agents/skills/write-gatekeeper/SKILL.md` keeps the seven
    responsibilities, the phase gates (including the API-design STOP), and the observer taxonomy;
    Phase 1 becomes kit-first (spec + `types.d.ts` + sessions), Phase 2 maps strategies A–D to
    `privateObservers`/`aclObservers`/`trackedSetObservers`/`openObservers`, actions to
    `defineActions` + `ActionJournal` + `stageAction`, and simulation to the pure substrate
    (`createSimulationView` over `journal.listPending()`, `replaySimulation`, `ProvisionalIds`,
    provider reducers local and pure). Revert guidance: the facet's `protected revert(id)` hook
    with github's and linear's `revertAction` bodies as the exemplars. Recipes, cited by symbol
    name (never line numbers — those rot): cascade rejection of provisional dependents (linear's
    dependent-action sweep in `rejectAction`, github's `#rejectReplyDependencyChain`) and
    apply-time credential failure (wrap apply bodies in `CredentialSource.run`, the supabase
    `noteCredentialsExpired` mapping). A new "when to bypass the kit" section names the known
    cases — google-class OAuth irregularities, MCP-class runtime-generated types, email-class
    resource claiming — and states that each keeps implementing the raw interfaces while reusing
    leaf modules. Reference implementations: supabase for the kit path, github for the raw path.
    `SKELETON.md` is rewritten as a kit-based skeleton (spec, subclasses, `wrangler.jsonc` with
    the `capnweb-validate` build command and migrations, `env.d.ts`, `types.txt` symlink,
    configurator, workerd test scaffold); the raw path points at `gatekeeper-github` instead of
    carrying a second skeleton.

## 8. Verification

All commands from the repo root.

1. `pnpm install`, then `pnpm --filter @gadgets/gatekeeper-kit test:run`. Both suites green. The
   checks that define success: the fixture OAuth round trip delivers a usable `GatekeeperUser`
   stub; concurrent `beginAuth` advances exactly once; `completeAuth` after a concurrent `revoke`
   leaves the account empty; a mocked-500 refresh leaves stored credentials intact while a
   mocked-400 `invalid_grant` notifies expiry exactly once and re-notifies after a failed
   callback; observation data is withheld until `authorizeObservation` resolves; a staged action
   survives `submitAction`-failure rollback; tracked-set exclusion lists exactly the denied
   observer.
2. `pnpm --filter @gadgets/mcp-shared test:run` plus type-checking the two MCP connectors — the
   step-12 regression gate.
3. `pnpm --filter <supabase package name> test:run` (the `name` field in
   `packages/gatekeeper-supabase/package.json`) — legacy-storage upgrades and the workerd connect
   flow.
4. `pnpm build` and `pnpm lint`.
5. `git diff --stat packages/gatekeeper-supabase/wrangler.jsonc` is empty, and
   `node --test scripts/release/manifest-lib.test.ts` leaves the golden manifest unchanged (the
   kit is non-deployable and the supabase worker config is untouched).
6. Dev smoke, no provider credentials needed: `pnpm dev-server`, then
   - `curl -sS "http://localhost:8787/gatekeeper/supabase/oauth?error=denied"` → HTTP 400 with
     "authorization failed" in the body;
   - `curl -sS http://localhost:8787/gatekeeper/supabase/$(printf 'a%.0s' {1..64})/$(printf 'b%.0s' {1..64})`
     → the not-configured page when dev has no `CLIENT_ID`, else the invalid-link page (either
     proves initiation routing and DO dispatch);
   - the Workshop UI lists Supabase in the connectors panel.

## 9. Assumptions & contingencies

- **Bare `@validateRpc()` on subclasses of generic bases** is expected to work (the
  `gatekeeper-mcp` precedent). If the transform rejects a facet subclass, switch that class to
  the explicit-surface form `@validateRpc<Gatekeeper<…>>()` documented in the capnweb-validate
  README, for both supabase and the fixture.
- **capnweb-validate resolving kit imports**: MCP consumers already resolve
  `@gadgets/mcp-shared/*` during `capnweb-validate build`. If kit imports resolve differently,
  add the same `paths` mappings `gatekeeper-mcp/tsconfig.json` uses.
- **`ctx.exports` typing**: if supabase's checked-in `worker-configuration.d.ts` lacks entries
  for the kit-based classes after the port, regenerate it with `pnpm exec wrangler types` in that
  package and commit the diff.
- **In-flight connects during a deploy** of the ported supabase: the stored nonce shape is a
  superset of the old one, so live initiation links keep working; a flow whose state was minted
  before the deploy and consumed after may fail once, and the user restarts the connect. No
  migration code for attempt records.
- **Vite+ task nesting**: if `vitestTaskViteConfig('pnpm test:run')` misbehaves under vp's
  stripped environment, give the task the composed string
  `vitest run && vitest run -c vitest.worker.config.ts` directly, as
  `gatekeeper-cloudflare`'s `test:run` script composes it.

## 10. Deferred seams — separate implementations behind existing interfaces

Opportunities the review pass verified against both corpora for slotting an alternate
implementation behind a contract the kit already has. Nothing here is built now: the surface is
preserved so the work is additive when its trigger port lands. Each entry names the interface, the
evidence, and the trigger.

- **In-place-state journal** behind the `ActionJournal` consumer contract (`allocate`,
  `markSubmitted`, `rollbackSubmission`, `get`, `remove`, `retain`, `isRetained`, `listPending`).
  Notion (`notion-actions.ts:77-80,124-157`) and confluence (`confluence-actions.ts:56-59,95-128`)
  keep `pending | applied | reverted` records in place under one prefix instead of moving an applied
  record to a retained tier. *Trigger:* the notion/confluence/linear port. Related **key-format**
  variants — padded-hex ids plus a `pending:ids` index (jira, internal cf-wiki and salesforce),
  github's separate `retiredAction:` tier — take a one-time key migration at port time instead:
  `upgradeRecord` converts record *shapes*, never key formats.
- **Expiry-derived consumer credential cache** behind `CredentialSource`'s `get`/`run` surface.
  Google caches a fetched token until expiry − 60s (`google/src/auth-retry.ts:181-213`) and slack
  until expiry − 300s (`slack.ts:510-519`) — freshness derived from the credential rather than a
  fixed TTL. *Trigger:* the google or slack port. Add an `expiresAt`-aware variant (or swap the
  fixed 30s for it wholesale) rather than reintroducing a TTL knob.
- **Split-key handshake variant** behind the `putInitiation`/`advanceToOAuth`/`claimOAuth`
  operations. Internal ironclad stores `initiationNonce` and `oauthNonce` under two keys
  (`ironclad.ts:129-131,1634-1692`) where the kit uses one `nonce` record. *Trigger:* the ironclad
  port — either a variant module or a one-time key migration. Salesforce
  (`salesforce.ts:150-152,1210-1269`) already matches the kit shape exactly, PKCE verifier in the
  record.
- **Per-action-id claim serialization** as an alternative to the facet's global `SerialTaskQueue`.
  The durable claim itself is now in the journal (§4.8, `claimBeforeApply`); what stays deferred is
  its granularity. `mcp-shared` stamps `applying` synchronously before awaiting
  (`action-store.ts:130-162`) and ironclad coalesces per id (`ironclad.ts:957-995`). *Trigger:*
  measured per-DO contention where one slow apply may not block unrelated actions — a `deferred:`
  global lock is the simple form, per-id claims the one that matters if throughput does.
- **Already realized** (orientation only, no work): the `ObserverStrategy` A–D wrappers behind one
  interface; `ArrayCursor`/`StreamingCursor`/`TokenCursor` behind `Cursor<T>`; and Layer 2's
  `AuthStrategy` (`oauth2` / `tokenAuth` / CF Access) — the same doctrine at the auth seam.
