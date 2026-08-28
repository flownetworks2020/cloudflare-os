import { createLogger } from "@gadgets/backend-utils/logger";
import { ACCESS_TOKEN_SAFETY_MS, generateNonce } from "./connect-nonce";

const logger = createLogger<{ vendorId: string }>({ component: "gatekeeper.credentials" });

/** The Durable Object KV surface used to hold credentials. */
export type CredentialsKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
};

/**
 * Provider-proven death of the grant itself: the user must reconnect. Everything else -- 5xx, WAF
 * pages, redirects, network failures -- is infrastructure, and must propagate unchanged so stored
 * credentials survive it.
 */
export class CredentialsExpiredError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CredentialsExpiredError";
  }
}

/**
 * The canonical record, plus the two keys beside it. Fixed rather than configurable: every
 * gatekeeper in the corpus stores its grant under `"credentials"`, and a foreign layout is
 * adopted through `upgrade()` rather than by pointing the coordinator somewhere else.
 */
const CREDENTIALS_KEY = "credentials";
const IDENTITY_KEY = `${CREDENTIALS_KEY}:identity`;
const MIGRATED_KEY = `${CREDENTIALS_KEY}:migrated`;

/** What a legacy-credential migration found: the grant, and the keys it was reassembled from. */
export type UpgradedCredentials<Creds> = {
  credentials: Creds;
  /** Reaped by the coordinator once the canonical record is written. */
  legacyKeys: readonly string[];
};

/** The provider policy the coordinator needs: when a grant goes stale, and where it came from. */
export type CredentialCoordinatorOptions<Creds> = {
  /** When the credentials stop working, if they expire at all. */
  expiresAt?(credentials: Creds): number | undefined;
  /** How far ahead of `expiresAt` to refresh. */
  refreshSkewMs?: number;
  /**
   * One-shot migration off a gatekeeper's pre-kit keys, naming both the grant it found and the keys
   * it came from.
   *
   * Reads only -- the coordinator performs the deletes itself, after the canonical record exists. An
   * implicit Durable Object transaction is atomic against machine failure but is NOT rolled back by
   * a throw (verified on workerd), so a callback that deleted its own keys and then threw on a
   * malformed record would leave the account with no grant at all and nothing left to retry from.
   */
  upgrade?(kv: Pick<CredentialsKv, "get">): UpgradedCredentials<Creds> | undefined;
};

/**
 * Owns the credential record inside the account Durable Object: reads, commits, and skew-aware
 * refresh with concurrent callers coalesced onto one provider round-trip.
 *
 * Refresh is NOT transactional against provider-side rotation: a crash between the provider
 * rotating the token and `commit()` loses it, and the user reconnects.
 */
export class CredentialCoordinator<Creds> {
  readonly #kv: CredentialsKv;
  readonly #options: CredentialCoordinatorOptions<Creds>;
  #refreshing?: { fence: string; done: Promise<Creds> };

  constructor(kv: CredentialsKv, options: CredentialCoordinatorOptions<Creds> = {}) {
    this.#kv = kv;
    this.#options = options;
  }

  /** The stored credentials, migrating legacy keys on first read. */
  stored(): Creds | undefined {
    const current = this.#kv.get<Creds>(CREDENTIALS_KEY);
    if (current !== undefined) {
      this.#identify();
      return current;
    }

    const { upgrade } = this.#options;
    // The marker is durable, not per-instance: a `clear()` followed by a restart would otherwise
    // re-run the migration and resurrect a grant that has since been superseded.
    if (upgrade === undefined || this.#kv.get<boolean>(MIGRATED_KEY)) return undefined;

    const upgraded = upgrade(this.#kv);
    // Found nothing: mark it here, since there is no record to write and nothing found today will
    // not be found later either. A found grant is marked by the `clear()` that drops it again.
    if (upgraded === undefined) {
      this.#kv.put(MIGRATED_KEY, true);
      return undefined;
    }

    // Canonical record first, legacy keys second. Both land in one implicit transaction, so a
    // machine failure takes neither; the order is what makes a throw between them survivable, since
    // the grant is already readable under its new key before the old one goes away.
    this.commit(upgraded.credentials);
    for (const key of upgraded.legacyKeys) this.#kv.delete(key);
    return upgraded.credentials;
  }

  /**
   * Which credentials are current, as an opaque value. Compare for equality only: it is random per
   * write, never ordered, because a counter is reset by the `deleteAll()` that `revoke()` and the
   * self-destruct alarm perform — after which a reissued "1" would match a fence from the revoked
   * grant and let its refresh commit over the replacement.
   *
   * `""` means no credentials have ever been surfaced, and is the one value that is never a fence:
   * anything a caller can fence against has an identity by construction (see `#identify`).
   */
  identity(): string {
    return this.#kv.get<string>(IDENTITY_KEY) ?? "";
  }

  /**
   * Fence first, record second. An implicit Durable Object transaction is atomic against machine
   * failure but is NOT rolled back by a throw (see `upgrade`), so the order decides what an
   * unusually placed storage failure leaves behind: rotating first can only lose the new record,
   * with every in-flight refresh already fenced out, whereas publishing first could leave the new
   * record readable under the old fence and let a stale refresh commit straight over it.
   */
  commit(credentials: Creds): void {
    this.#supersede();
    this.#kv.put(CREDENTIALS_KEY, credentials);
  }

  /**
   * Drops the credentials, and marks the migration done -- here and nowhere else. While a canonical
   * record exists `stored()` never consults the migration path, so the marker only has to be durable
   * once that record is gone, and `clear()` is the only kit path that removes it. (The `deleteAll()`
   * behind `revoke()` wipes the legacy keys too, so an upgrade re-run after one finds nothing and
   * re-marks.) Keeping it off `commit()` saves a KV write per successful refresh.
   *
   * Written whether or not an `upgrade` is configured today. Conditioning it on the option saved one
   * write on a path taken once per disconnect, and cost this: a deployment that adds `upgrade` in a
   * later release would find no marker and re-run the migration against whatever legacy keys a
   * disconnect left behind, resurrecting a grant the user revoked.
   *
   * Ordered so that the record is the last thing to go, for the reason `commit()` gives: both
   * earlier writes are what stop a grant coming back. A throw before the rotation leaves the
   * account connected with the marker set, which nothing reads while a record exists; the two
   * orders that drop the record first can resurrect it, either from an in-flight refresh whose
   * fence still matches or from an `upgrade()` re-run that the missing marker permits.
   */
  clear(): void {
    this.#kv.put(MIGRATED_KEY, true);
    this.#supersede();
    this.#kv.delete(CREDENTIALS_KEY);
  }

  /**
   * Whatever this account held is gone: a new identity, so an in-flight refresh's fence can never
   * match again. `clear()` rotates rather than deletes for the same reason a counter is unusable --
   * an absent identity reads as `""` for every caller that asks.
   */
  #supersede(): void {
    this.#kv.put(IDENTITY_KEY, generateNonce());
  }

  /**
   * Credentials and an identity are surfaced together, always: a record written before this account
   * had identities would otherwise carry `""`, which still compares equal to itself after a wipe.
   */
  #identify(): void {
    if (this.#kv.get<string>(IDENTITY_KEY) === undefined) {
      this.#kv.put(IDENTITY_KEY, generateNonce());
    }
  }

  /**
   * Credentials that will still work for a moment, refreshing them first if not.
   *
   * Fenced on the identity the refresh started from: a success commits only if nothing overtook it,
   * and a `CredentialsExpiredError` propagates only if nothing overtook it either -- so grant A's
   * stale death can never expire grant B. Any other failure propagates untouched.
   */
  async fresh(refresh: (current: Creds) => Promise<Creds>): Promise<Creds> {
    const current = this.stored();
    if (current === undefined) throw new CredentialsExpiredError("This account is not connected.");

    const expiresAt = this.#options.expiresAt?.(current);
    const skew = this.#options.refreshSkewMs ?? ACCESS_TOKEN_SAFETY_MS;
    if (expiresAt === undefined || Date.now() < expiresAt - skew) return current;

    // Keyed by identity, so a caller arriving after a reconnect starts its own refresh rather than
    // riding one whose result is already fenced out.
    const fence = this.identity();
    const inFlight = this.#refreshing?.fence === fence
      ? this.#refreshing
      : { fence, done: this.#refresh(current, fence, refresh) };
    this.#refreshing = inFlight;
    try {
      return await inFlight.done;
    } finally {
      if (this.#refreshing === inFlight) this.#refreshing = undefined;
    }
  }

  async #refresh(
    current: Creds,
    fence: string,
    refresh: (current: Creds) => Promise<Creds>,
  ): Promise<Creds> {
    let refreshed: Creds;
    try {
      refreshed = await refresh(current);
    } catch (error) {
      if (!(error instanceof CredentialsExpiredError) || this.identity() === fence) throw error;
      return this.#overtaken(error);
    }

    if (this.identity() !== fence) return this.#overtaken();
    this.commit(refreshed);
    return refreshed;
  }

  /** A reconnect or revoke landed mid-refresh: its credentials win, or there are none left. */
  #overtaken(cause?: unknown): Creds {
    const latest = this.stored();
    if (latest !== undefined) return latest;
    throw new CredentialsExpiredError("This account was disconnected while refreshing.", { cause });
  }
}

/** One fetch of credentials, tagged with the identity they belong to. */
export type CredentialsWithIdentity<Creds> = { creds: Creds; identity: string };

/** The account-side methods a credential consumer calls over RPC. */
export type AccountCredentialStub<Creds> = {
  getCredentials(): Promise<CredentialsWithIdentity<Creds>>;
  /** No-ops unless `identity` is still the account's, i.e. no reconnect overtook the caller. */
  noteCredentialsExpired(identity: string): Promise<void>;
};

/**
 * How long a fetched record is reused before asking the account again. Long enough to collapse the
 * burst of parallel API calls one gadget request makes, short enough that a reconnect is picked up
 * without the facet being rebuilt.
 */
const CACHE_TTL_MS = 30_000;

/**
 * Wiring for the consumer side. The `Creds` here cross the account RPC boundary into a facet the
 * agent can reach, so a gatekeeper whose stored grant carries refresh material should project it
 * away and instantiate this with the narrower record -- the coordinator's `Creds` and this one need
 * not be the same type.
 */
export type CredentialSourceOptions<Creds> = {
  /** Resolved per call, so no account stub is held across its lifetime. */
  account(): AccountCredentialStub<Creds>;
  /**
   * Classifies a provider API failure as "these credentials no longer work". Only that: this
   * verdict reports the grant expired and prompts the user to reconnect, and the agent chooses
   * which operations run, so a classifier matching bare 401/403 lets it retire a healthy
   * connection by asking for one resource the grant does not cover. Per-resource denials are
   * `isNoAccessError`'s job (`./http-errors`); this one wants the provider's credential-invalid
   * signal -- for OAuth, RFC 6749 §5.2's `invalid_token`/`invalid_grant`, the same doctrine
   * `CredentialsExpiredError` documents for refresh.
   */
  isAuthError(error: unknown): boolean;
  /** What the gadget is told when they no longer work. */
  expiredMessage: string;
  /** Vendor id for log attribution. */
  vendorId?: string;
};

/**
 * The consumer side, held by a facet or verifier: a short instance-local cache over the account DO
 * (so parallel API calls do not each make a round-trip), and the one place a provider auth failure
 * turns into an expiry notification. A provider whose 401 can mean a stale derived bearer rather
 * than a dead grant should wrap its calls in `withAuthRetry` from `./auth-retry` and report expiry
 * only from `onPersistentAuthError`.
 */
export class CredentialSource<Creds> {
  readonly #options: CredentialSourceOptions<Creds>;
  readonly #logger: typeof logger;
  #cached?: CredentialsWithIdentity<Creds> & { fetchedAt: number };
  #fetching?: Promise<CredentialsWithIdentity<Creds>>;
  /** Bumped whenever the cache is invalidated, so an older in-flight fetch cannot reinstate it. */
  #epoch = 0;

  constructor(options: CredentialSourceOptions<Creds>) {
    this.#options = options;
    this.#logger = options.vendorId ? logger.with({ vendorId: options.vendorId }) : logger;
  }

  /**
   * The credentials to use now, from the instance cache when it is still warm. For a provider call
   * prefer `run`, which is the same fetch plus the auth-failure handling this method has none of.
   */
  async get(): Promise<Creds> {
    return (await this.#current()).creds;
  }

  /**
   * Runs a provider call against the credentials it should use. The identity is captured before
   * the call, not read back after it: a concurrent refetch would otherwise expire the newer grant.
   */
  async run<T>(operation: (credentials: Creds) => Promise<T>): Promise<T> {
    const { creds, identity } = await this.#current();
    try {
      return await operation(creds);
    } catch (error) {
      if (!this.#options.isAuthError(error)) throw error;
      this.#invalidate();
      await this.#note(identity);
      throw new Error(this.#options.expiredMessage, { cause: error });
    }
  }

  async #current(): Promise<CredentialsWithIdentity<Creds>> {
    const cached = this.#cached;
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

    const epoch = this.#epoch;
    const fetching = (this.#fetching ??= this.#options.account().getCredentials().then(fetched => {
      if (this.#epoch === epoch) this.#cached = { ...fetched, fetchedAt: Date.now() };
      return fetched;
    }));
    try {
      return await fetching;
    } finally {
      // Only if it is still the one in flight: an invalidation drops it mid-call, and a caller that
      // arrived after that started its own, which this one must not evict.
      if (this.#fetching === fetching) this.#fetching = undefined;
    }
  }

  #invalidate(): void {
    this.#cached = undefined;
    this.#epoch += 1;
    // The in-flight fetch was started against the credentials just reported dead. Dropping the
    // cache alone would leave the next caller awaiting it and receiving them anyway.
    this.#fetching = undefined;
  }

  async #note(identity: string): Promise<void> {
    try {
      await this.#options.account().noteCredentialsExpired(identity);
    } catch (error) {
      this.#logger.error("failed to report credential expiry", {
        event: "credentials.expiry.report.failed",
        error,
      });
    }
  }
}
