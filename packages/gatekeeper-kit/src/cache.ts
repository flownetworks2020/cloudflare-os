/** The Durable Object KV surface used by the cache. */
export type CacheKv = {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
};

type CacheEntry<T> = { value: T; fetchedAt: number; generation: number };

/**
 * Where entries and the generation counter live. Fixed: a resource's cache families are segments
 * within the caller's own `key` (`page:…`, `schema:…`), and their freshness is already per-read.
 */
const CACHE_PREFIX = "cache:";

/**
 * Durable cache for stable, read-only provider metadata, keyed within a generation the caller bumps
 * when an applied action may have invalidated everything (a schema change, say) -- cheaper and more
 * complete than tracking which entries a write touched.
 *
 * Filling is the cache's own job rather than a get/put pair at each call site, because the load
 * spans an await: an applied action can bump the generation while one is in flight, and a value
 * stamped with the generation current when it *returns* would reinstate exactly what that bump
 * invalidated, then serve it for the whole `ttlMs`.
 */
export class KvTtlCache {
  readonly #kv: CacheKv;

  constructor(kv: CacheKv) {
    this.#kv = kv;
  }

  /**
   * The cached value, or `load()`'s -- kept for later callers.
   *
   * The generation is read before the load and again after it. A bump in between means the value
   * describes a state that bump declared stale, so it is handed to this caller (which asked before
   * the change) but not stored.
   *
   * `T` is asserted, not checked: one key holds one type for the life of the deployment, since a
   * generation bump does not protect a shape that changed across deploys. `ttlMs` is the reader's
   * choice, so two callers may disagree about whether the same entry is fresh.
   */
  async cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const entryKey = `${CACHE_PREFIX}entry:${key}`;
    const generation = this.#generation();
    const entry = this.#kv.get<CacheEntry<T>>(entryKey);
    if (entry?.generation === generation && Date.now() - entry.fetchedAt < ttlMs) {
      return entry.value;
    }

    const value = await load();
    if (this.#generation() === generation) {
      this.#kv.put<CacheEntry<T>>(entryKey, { value, fetchedAt: Date.now(), generation });
    }
    return value;
  }

  /**
   * Invalidate every entry at once. A superseded entry is left where it is: the counter lives under
   * a stable key, so a bump never grows the keyspace, and the next load overwrites the entry.
   */
  bumpGeneration(): void {
    this.#kv.put(`${CACHE_PREFIX}generation`, this.#generation() + 1);
  }

  #generation(): number {
    return this.#kv.get<number>(`${CACHE_PREFIX}generation`) ?? 0;
  }
}
