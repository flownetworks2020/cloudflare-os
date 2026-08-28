// The observer-verification contract (getVerifier/addObserver/removeObserver), as four
// interchangeable strategies plus the tracker behind the broadest of them.

import { createLogger } from "@gadgets/backend-utils/logger";
import type { RpcStub } from "cloudflare:workers";
import type {
  ApprovalQueue,
  GatekeeperUserVerifier,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";

const logger = createLogger<{ vendorId: string; observerId: string }>({
  component: "gatekeeper.observers",
});

/**
 * Reinterpret the opaque verifier stub the overseer hands to `addObserver()` as this gatekeeper's
 * concrete verifier API. A cast is unavoidable: Workers RPC types cannot express that
 * `Fetcher<Sub>` is assignable to `Fetcher<Base>`. It is safe at runtime because the overseer only
 * routes a verifier back to the vendor that minted it. Centralized so the cast lives in one place.
 */
export function asVerifier<T>(user: unknown): T {
  return user as T;
}

/** Error text returned when a collaborator fails observer admission. */
export const OBSERVER_DENIED =
  "This collaborator does not have access to data this workspace has read, so they cannot be allowed " +
  "to observe it.";

/** The Durable Object KV surface used by observer tracking. */
export type ObserverKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
  list<T>(options: { prefix: string }): Iterable<[string, T]>;
};

/**
 * `true` is the legacy encoding of "observed" some gatekeepers already have in storage. The kit
 * never writes it; where it exists, it means the set was revealed.
 */
type SetState = "pending" | "observed" | true;

/** An authorization result that promotes pending sets only after authorization succeeds. */
export type ObservationCheck = {
  excludeObservers?: string[];
  commit(): void;
};

const NOTHING_TO_COMMIT: ObservationCheck = { commit() {} };

/**
 * Where stored verifiers live. Fixed: every gatekeeper in the corpus keys its observers under this
 * prefix, and only the observed-set family varies (`observedProject:`, `trackedConversation:`, ...).
 */
const OBSERVER_PREFIX = "observer:";

/** How many distinct sets a binding may track before it stops being verifiable. */
const DEFAULT_MAX_TRACKED_SETS = 1000;

/** How many verifiers may be consulted at once. */
const DEFAULT_CONCURRENCY = 6;

/** Bounds that drive loop termination, so a zero or fractional one is a hang or a lockout. */
function requirePositiveInt(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got ${value}.`);
  }
  return value;
}

/**
 * Awaits `fn` over `items` in windows of `limit`, preserving order.
 *
 * The observer dimension is the kit's to bound; the set dimension is the oracle's, since
 * `hasSetAccess` receives every pending set in one call and can chunk them as its provider requires.
 * Unbounded here, a binding with many observers would exceed the Workers subrequest budget on a path
 * the overseer re-runs at every open, locking out every collaborator at once.
 */
async function mapLimit<In, Out>(
  items: readonly In[],
  limit: number,
  fn: (item: In) => Promise<Out>,
): Promise<Out[]> {
  const results: Out[] = [];
  for (let index = 0; index < items.length; index += limit) {
    results.push(...await Promise.all(items.slice(index, index + limit).map(fn)));
  }
  return results;
}

/** Configuration for an observer tracker and its provider-owned ACL oracle. */
export type ObserverTrackerOptions<V> = {
  kv: ObserverKv;
  /** Key prefix for observed-set records; observers always live under `"observer:"`. */
  setPrefix?: string;
  /**
   * Canonicalizes a set id before it is stored, compared, or handed to the oracle, so two spellings
   * of one resource cannot become two tracked sets (Notion's equivalent item-id forms). Identity
   * when omitted. Set ids stay opaque strings: a compound identity is the caller's own join, the
   * shape Confluence already uses for its `space:`/`content:` families.
   */
  canonicalSetId?(setId: string): string;
  /** Throwing membership check run before per-set checks, e.g. org or workspace membership. */
  verifyBaseline?(verifier: V): Promise<void>;
  /**
   * Batched per-set ACL oracle: one entry per requested set, in order. Free to chunk the array
   * destructively (see `mapLimit`) -- every call receives its own copy.
   */
  hasSetAccess(verifier: V, setIds: readonly string[]): Promise<boolean[]>;
  /** Denial text naming the failing set; defaults to `OBSERVER_DENIED`. */
  denyMessage?(setId: string): string;
  /**
   * Distinct sets this binding may track before it refuses to reveal another.
   *
   * Enforced when a set is recorded rather than when an observer joins, because the alternative is
   * worse: a binding that has already read past the cap could never be verified against, which
   * locks out the collaborators already using it as well as new ones, with no way back.
   */
  maxTrackedSets?: number;
  /** Concurrent verifier round trips. */
  concurrency?: number;
  /** Vendor id for log attribution. */
  vendorId?: string;
};

/**
 * A set id that has been through `canonicalSetId`. Purely internal: it appears in no exported
 * signature, so a consumer never has to produce one, and the brand cannot leak into their types.
 * Its whole job is to make "canonicalize once, at the entry point" a compile error to get wrong.
 */
type CanonicalSetId = string & { readonly __canonical: true };

/** Tracks observer admission and forward exclusion across revealed data sets. */
export class ObserverTracker<V> {
  readonly #options: ObserverTrackerOptions<V>;
  readonly #setPrefix: string;
  readonly #canonicalSetId: (setId: string) => CanonicalSetId;
  readonly #maxTrackedSets: number;
  readonly #concurrency: number;
  readonly #logger: typeof logger;
  /**
   * Removals per observer, so an admission that started before one cannot land after it. In memory:
   * the only caller a removal can overtake is an `addObserver` frame parked in this instance, and an
   * eviction ends that frame rather than outliving it.
   */
  readonly #removals = new Map<string, number>();

  constructor(options: ObserverTrackerOptions<V>) {
    this.#options = options;
    this.#logger = options.vendorId ? logger.with({ vendorId: options.vendorId }) : logger;
    this.#setPrefix = options.setPrefix ?? "observed:";
    // The brand is asserted here and nowhere else on this path: whatever the caller's function
    // returns *is* the canonical spelling, by definition of the option.
    this.#canonicalSetId =
      (options.canonicalSetId ?? (setId => setId)) as (setId: string) => CanonicalSetId;
    // A cap of zero refuses every read, and a window of zero never advances.
    this.#maxTrackedSets = requirePositiveInt(
      "maxTrackedSets", options.maxTrackedSets ?? DEFAULT_MAX_TRACKED_SETS);
    this.#concurrency = requirePositiveInt(
      "concurrency", options.concurrency ?? DEFAULT_CONCURRENCY);

    // Overlapping families scan into each other: set ids would come back as verifier keys, and
    // stored verifiers would be handed to `hasSetAccess` as set ids. An empty prefix overlaps by
    // scanning everything, and the same check rejects it.
    if (this.#setPrefix.startsWith(OBSERVER_PREFIX)
      || OBSERVER_PREFIX.startsWith(this.#setPrefix)) {
      throw new Error(
        `Set prefix "${this.#setPrefix}" overlaps the observer prefix "${OBSERVER_PREFIX}".`);
    }
  }

  /**
   * Verify against every set observed so far, then persist the verifier for forward exclusion. The
   * loop re-reads tracked sets so sets appearing mid-check are also verified before we store.
   *
   * A removal that overtakes the admission throws: returning quietly would report success for an
   * observer nothing tracks, and an untracked observer is excluded from nothing.
   */
  async addObserver(id: string, verifier: V): Promise<void> {
    const { kv, verifyBaseline, hasSetAccess, denyMessage } = this.#options;
    const removals = this.#removals.get(id) ?? 0;
    if (verifyBaseline) await verifyBaseline(verifier);

    const checked = new Set<string>();
    for (;;) {
      const setIds = this.#trackedSets().filter(setId => !checked.has(setId));
      if (setIds.length === 0) {
        if ((this.#removals.get(id) ?? 0) !== removals) {
          throw new Error(`Observer ${id} was removed while being admitted.`);
        }
        kv.put(`${OBSERVER_PREFIX}${id}`, verifier);
        return;
      }
      // Copied per call: the oracle may chunk destructively, and the length check below plus the
      // `checked` bookkeeping read this array afterwards.
      const access = await hasSetAccess(verifier, setIds.slice());
      // A ragged answer denies rather than admits, in either direction. Short already denied
      // (`undefined !== true`); an answer *longer* than the question used to admit, which is the
      // worse half -- index alignment is the only thing tying a verdict to a set, so a length the
      // oracle disagrees about invalidates every verdict in the array rather than just the extras.
      const misaligned = access.length !== setIds.length;
      const denied = misaligned ? 0 : setIds.findIndex((_, index) => access[index] !== true);
      if (denied >= 0) throw new Error(denyMessage?.(setIds[denied]!) ?? OBSERVER_DENIED);
      for (const setId of setIds) checked.add(setId);
    }
  }

  /** Idempotently stop tracking an observer, cancelling any admission still in flight for it. */
  removeObserver(id: string): void {
    this.#removals.set(id, (this.#removals.get(id) ?? 0) + 1);
    this.#options.kv.delete(`${OBSERVER_PREFIX}${id}`);
  }

  /**
   * Every observer currently admitted, for a read that must be withheld from all of them at once —
   * an empty result set discloses as much as a populated one, and no set id describes it.
   */
  observerIds(): string[] {
    return [...this.#observers()].map(([id]) => id);
  }

  /**
   * Mark newly-revealed sets pending (before any await, so a concurrent addObserver sees them) and
   * return the observers who cannot see them. Sets are promoted to "observed" only via commit(),
   * after the overseer authorizes the observation.
   *
   * Throws when recording would take the binding past `maxTrackedSets`: revealing the set anyway
   * would disclose data no observer is ever verified against, and silently not recording it would
   * do the same.
   */
  async prepareObservation(setIds: string[]): Promise<ObservationCheck> {
    const { kv, hasSetAccess } = this.#options;
    // Canonicalized up front, so the keys written, the state compared, and the ids the oracle is
    // asked about are all the same spelling.
    const canonical = setIds.map(setId => this.#canonicalSetId(setId));
    const pending = [...new Set(canonical)].filter(setId => !this.#isObserved(setId));
    if (pending.length === 0) return NOTHING_TO_COMMIT;

    const untracked = pending.filter(setId => this.#state(setId) === undefined);
    if (untracked.length > 0) {
      const tracked = this.#trackedSets().length;
      if (tracked + untracked.length > this.#maxTrackedSets) {
        throw new Error(
          `This binding has read ${tracked} distinct items, the most it can track while remaining ` +
          "shareable. Bind a narrower scope.");
      }
      for (const setId of untracked) kv.put<SetState>(this.#setKey(setId), "pending");
    }

    const observers = [...this.#observers()];
    const access = await mapLimit(observers, this.#concurrency, async ([id, verifier]) => {
      try {
        // Copied per verifier: the oracle may chunk destructively, and the exclusion check below
        // compares against this array. Shared, an emptied batch would make that check vacuous and
        // admit every later observer to sets no oracle ever verified.
        return await hasSetAccess(verifier, pending.slice());
      } catch (error) {
        // A throw excludes, like a denial: rejecting the batch would let one dead stub fail every
        // observation this binding makes.
        this.#logger.warn("observer access check failed", {
          event: "observers.access.check.failed",
          observerId: id,
          error,
        });
        return undefined;
      }
    });
    const excluded = observers
      .filter((_, observer) => {
        // Same rule as admission, and for the same reason: a verdict array whose length the oracle
        // disagrees about excludes that observer rather than being read positionally. Excluding
        // rather than throwing keeps one broken verifier from failing the whole read.
        const verdicts = access[observer];
        return verdicts === undefined
          || verdicts.length !== pending.length
          || pending.some((_setId, index) => verdicts[index] !== true);
      })
      .map(([id]) => id);

    return {
      excludeObservers: excluded.length > 0 ? excluded : undefined,
      commit: () => {
        for (const setId of pending) kv.put<SetState>(this.#setKey(setId), "observed");
      },
    };
  }

  /** The brand is the precondition: a raw set id will not type-check here. */
  #setKey(setId: CanonicalSetId): string {
    return `${this.#setPrefix}${setId}`;
  }

  #state(setId: CanonicalSetId): SetState | undefined {
    return this.#options.kv.get<SetState>(this.#setKey(setId));
  }

  #isObserved(setId: CanonicalSetId): boolean {
    const state = this.#state(setId);
    return state === "observed" || state === true;
  }

  /** Canonical by construction: every key under this prefix was written through `#setKey`. */
  #trackedSets(): CanonicalSetId[] {
    return [...this.#options.kv.list<SetState>({ prefix: this.#setPrefix })].map(([key]) =>
      key.slice(this.#setPrefix.length) as CanonicalSetId,
    );
  }

  *#observers(): IterableIterator<[string, V]> {
    for (const [key, verifier] of this.#options.kv.list<V>({ prefix: OBSERVER_PREFIX })) {
      yield [key.slice(OBSERVER_PREFIX.length), verifier];
    }
  }
}

/**
 * How a gatekeeper admits collaborators, and which of them a given observation must be hidden from.
 * A strategy without `prepare` reveals nothing an admitted observer cannot already see.
 */
export interface ObserverStrategy {
  addObserver(id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void>;
  removeObserver(id: string): Promise<void>;
  prepare?(setIds: string[]): Promise<ObservationCheck>;
  /** Present only where observers are retained; absent means there is no list to withhold from. */
  observerIds?(): string[];
}

/** A: nothing this resource exposes may be shared. Admission always fails with `message`. */
export function privateObservers(message: string): ObserverStrategy {
  return {
    addObserver: async () => { throw new Error(message); },
    removeObserver: async () => {},
  };
}

/**
 * B: the resource is one ACL unit — an observer who can read it can read everything read here.
 *
 * The oracle answers rather than throws, which is the shape every verifier API in the corpus
 * already has; the denial text belongs to the binding, not to the check.
 */
export function aclObservers<V>(options: {
  hasAccess(verifier: V): Promise<boolean>;
  denyMessage?: string;
}): ObserverStrategy {
  return {
    addObserver: async (_id, user) => {
      // Only `true` admits, as in C: a malformed answer from a hand-written oracle denies rather
      // than admits, and the two strategies must not disagree on what counts as access.
      if (await options.hasAccess(asVerifier<V>(user)) !== true) {
        throw new Error(options.denyMessage ?? OBSERVER_DENIED);
      }
    },
    removeObserver: async () => {},
  };
}

/** C: the binding spans sub-resources with distinct ACLs, so observed sets are tracked. */
export function trackedSetObservers<V>(options: ObserverTrackerOptions<V>): ObserverStrategy {
  const tracker = new ObserverTracker<V>(options);
  return {
    addObserver: (id, user) => tracker.addObserver(id, asVerifier<V>(user)),
    removeObserver: async id => tracker.removeObserver(id),
    prepare: setIds => tracker.prepareObservation(setIds),
    observerIds: () => tracker.observerIds(),
  };
}

/** D: the data is public to anyone with the workspace, so every observer is admitted. */
export function openObservers(): ObserverStrategy {
  return {
    addObserver: async () => {},
    removeObserver: async () => {},
  };
}

/**
 * Flattens newlines and escapes Markdown control characters, for interpolating provider-controlled
 * text into an ObservationDescription. Whole-description escaping is consumer policy:
 * `description` is Markdown by contract, and this must not destroy deliberate structure.
 */
export function escapeObservationValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[\\`*_{}[\]()#+.!|>~-]/g, "\\$&");
}

/**
 * Authorizes observations against the approval queue, folding in the strategy's exclusions and
 * promoting its newly-revealed sets only once the overseer has agreed to hide them.
 */
export class ObservationGate implements Disposable {
  readonly #queue: RpcStub<ApprovalQueue>;
  readonly #strategy: ObserverStrategy;
  readonly #sanitize?: (text: string) => string;

  /**
   * Takes ownership of `queue`, which must be a `.dup()`: the gate outlives `startSession`, and
   * whoever made the dup needs a way to release it.
   */
  constructor(
    queue: RpcStub<ApprovalQueue>,
    strategy: ObserverStrategy,
    options?: {
      /**
       * Sanitizes plain provider text before delivery. There is no default because descriptions are
       * Markdown by contract, and indiscriminate escaping would destroy deliberate structure.
       */
      sanitize?(text: string): string;
    },
  ) {
    this.#queue = queue;
    this.#strategy = strategy;
    this.#sanitize = options?.sanitize;
  }

  /** Releases the duplicated queue stub. */
  [Symbol.dispose](): void {
    (this.#queue as RpcStub<ApprovalQueue> & Disposable)[Symbol.dispose]();
  }

  /** Authorize a read, naming the data sets it is about to reveal. */
  async authorize(description: ObservationDescription, setIds: string[] = []): Promise<void> {
    const check = (await this.#strategy.prepare?.(setIds)) ?? NOTHING_TO_COMMIT;
    const sanitize = this.#sanitize;
    const sanitized = sanitize
      ? { ...description, title: sanitize(description.title),
        description: sanitize(description.description) }
      : description;
    const excludeObservers = [
      ...new Set([...sanitized.excludeObservers ?? [], ...check.excludeObservers ?? []]),
    ];
    await this.#queue.authorizeObservation(
      excludeObservers.length > 0 ? { ...sanitized, excludeObservers } : sanitized,
    );
    check.commit();
  }
}
