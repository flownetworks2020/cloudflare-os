import { RpcTarget } from "cloudflare:workers";
import type { Cursor } from "@gadgets/workshop-shared/gatekeeper";
import { SerialTaskQueue } from "./serial-queue";

/** Page sizes drive loop termination, so a zero or fractional one is a hang, not a small page. */
function requirePageSize(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer, got ${value}.`);
  }
  return value;
}

/** Pages a list the gatekeeper already holds. */
export class ArrayCursor<T> extends RpcTarget implements Cursor<T> {
  readonly #items: readonly T[];
  readonly #pageSize: number;
  #index = 0;

  constructor(items: readonly T[], pageSize: number) {
    super();
    this.#items = items;
    this.#pageSize = requirePageSize("pageSize", pageSize);
  }

  async next(): Promise<T[] | null> {
    if (this.#index >= this.#items.length) return null;
    const page = this.#items.slice(this.#index, this.#index + this.#pageSize);
    this.#index += this.#pageSize;
    return page;
  }
}

/**
 * How many consecutive provider pages may yield no usable item before `next()` gives up, so a page
 * whose every record is filtered out cannot loop forever. A safety bound rather than policy: no
 * gatekeeper tunes one per resource (google's pager hard-codes its own, the rest loop unbounded).
 * The counter resets per call, so a caller that asks again spends another window -- until one of
 * them gives up, since that throw latches the cursor like any other failure. `TokenCursor`'s
 * provider-empty half never throws at all, so it never reaches that.
 *
 * This bounds barren pages, not wasted ones: a provider that ignores the page argument and keeps
 * answering with rows resets the count on every page, and yields duplicates rather than ending.
 * Detecting that needs an item identity this cursor does not have, and no page ceiling can stand
 * in for one -- a walk long enough to be worth paginating is also long enough to trip it.
 */
const MAX_BARREN_PAGES = 50;

/** Shared empty result for a cursor with no injected items, so the hot path does not allocate. */
const NO_ITEMS: readonly never[] = [];

type InjectedItems<T> = { items: readonly T[]; comparator(a: T, b: T): number };

/** How far a cursor has got through its injected items. Both cursors merge them identically. */
class InjectedMerge<T> {
  readonly #injected?: InjectedItems<T>;
  #index = 0;

  constructor(injected?: InjectedItems<T>) {
    this.#injected = injected;
  }

  /**
   * Buffer every injected item sorting at or before `item`, keeping the merged order.
   *
   * Called ahead of the caller's filter: sort position does not depend on visibility, and merging
   * only on surviving items would let a run of filtered pages hit the barren cap with simulated
   * items still queued.
   */
  mergeAhead(item: T, buffer: T[]): void {
    const injected = this.#injected;
    if (injected === undefined) return;
    while (this.#index < injected.items.length
      && injected.comparator(injected.items[this.#index]!, item) <= 0) {
      buffer.push(injected.items[this.#index++]!);
    }
  }

  /** Buffer whatever is left, which is what the end of the remote walk releases. */
  flush(buffer: T[]): void {
    const items = this.#injected?.items ?? NO_ITEMS;
    while (this.#index < items.length) buffer.push(items[this.#index++]!);
  }

  drained(): boolean {
    return this.#index >= (this.#injected?.items.length ?? 0);
  }
}

/**
 * The two guards every provider-backed cursor's `next()` needs.
 *
 * Serialized, because provider cursor state spans an await and callers may not await in turn: two
 * racing on it would return one provider page twice and skip the next. And terminal on failure,
 * because a throw from `overlay`/`filter` abandons a batch the page counter has already moved past,
 * so resuming would skip records. Latched as a wrapper object rather than a flag, since `throw
 * undefined` would otherwise read as healthy.
 *
 * The provider call is the exception, and `fetch` is what marks it: a rejection there happens
 * before any paging state moves, so the page can simply be asked for again -- and a transient 5xx
 * that killed the cursor would cost a token-paged caller the whole walk, since the position lives
 * in here and not in their hands. Latching stays the default: a call routed around `fetch` is
 * treated as having moved state.
 */
class CursorGate<T> {
  readonly #queue = new SerialTaskQueue();
  #failure?: { cause: unknown };
  #resumable = false;

  next(fill: () => Promise<T[] | null>): Promise<T[] | null> {
    return this.#queue.run(async () => {
      if (this.#failure) {
        throw new Error(
          "This cursor failed and cannot be resumed.", { cause: this.#failure.cause });
      }
      this.#resumable = false;
      try {
        return await fill();
      } catch (error) {
        if (!this.#resumable) this.#failure = { cause: error };
        throw error;
      }
    });
  }

  /** Runs the provider call, whose own rejection leaves the cursor resumable. */
  async fetch<R>(call: () => Promise<R>): Promise<R> {
    this.#resumable = true;
    // No `finally`: it would clear the flag on the rejecting path as well, which is the one path
    // that needs it set. `next` clears it on entry, so nothing leaks into a later call.
    const page = await call();
    this.#resumable = false;
    return page;
  }
}

type StreamingCursorShape<T> = {
  /** How many items each `next()` returns. */
  pageSize: number;
  /** How many items to ask the provider for at a time. */
  remotePageSize?: number;
  /** Projects pending actions onto an item, so reads reflect what is queued. */
  overlay?(item: T): T;
  /** Drops items that the overlay made irrelevant. */
  filter?(item: T): boolean;
  /**
   * Items that exist only in simulation, pre-sorted by `comparator` and merged into the walk in
   * that order. Already in output shape, so `overlay` and `filter` do not run on them: the overlay
   * projects a provider record, and dropping one the caller injected itself would hide it silently.
   */
  injected?: InjectedItems<T>;
};

/**
 * Either the provider already returns the session's own type, or it returns something else and
 * `map` is mandatory — the union is what makes the identity case sound rather than assumed.
 */
export type StreamingCursorOptions<T, Raw = T> = StreamingCursorShape<T> & (
  | { fetchPage(page: number, perPage: number): Promise<T[]>; map?: never }
  | { fetchPage(page: number, perPage: number): Promise<Raw[]>; map(raw: Raw): T }
);

/**
 * A cursor that fetches provider pages lazily, overlays simulation onto each item, and merges
 * simulated-only items at their sort position -- so a resource with a long history returns its
 * first page without reading all of them.
 */
export class StreamingCursor<T, Raw = T> extends RpcTarget implements Cursor<T> {
  readonly #options: StreamingCursorOptions<T, Raw>;
  readonly #fetchItems: (page: number, perPage: number) => Promise<T[]>;
  readonly #pageSize: number;
  readonly #remotePerPage: number;
  readonly #merge: InjectedMerge<T>;
  readonly #gate = new CursorGate<T>();
  #buffer: T[] = [];
  #remotePage = 1;
  #remoteExhausted = false;

  constructor(options: StreamingCursorOptions<T, Raw>) {
    super();
    this.#options = options;
    // The one place the options union is resolved: with `map`, provider items are converted; with
    // no `map`, the union guarantees they are already `T`.
    const { fetchPage, map } = options;
    this.#fetchItems = map === undefined
      ? (page, perPage) => fetchPage(page, perPage) as Promise<T[]>
      : async (page, perPage) => ((await fetchPage(page, perPage)) as Raw[]).map(map);
    this.#pageSize = requirePageSize("pageSize", options.pageSize);
    this.#remotePerPage = requirePageSize("remotePageSize", options.remotePageSize ?? 100);
    this.#merge = new InjectedMerge(options.injected);
  }

  /** The next page, or null at the end. Concurrent callers are serialized rather than interleaved. */
  next(): Promise<T[] | null> {
    return this.#gate.next(() => this.#fill());
  }

  async #fill(): Promise<T[] | null> {
    let barren = 0;
    while (this.#buffer.length < this.#pageSize && !this.#exhausted()) {
      const before = this.#buffer.length;
      await this.#loadMore();
      // Exhaustion first: the page that ends the walk yields nothing, and counting it as barren
      // would turn an empty provider into an error rather than a null.
      if (this.#buffer.length > before || this.#exhausted()) barren = 0;
      else if (++barren >= MAX_BARREN_PAGES) {
        // Buffered items are handed back instead: only `null` ends the stream, so a short page
        // costs nothing and the next call spends its own window.
        if (this.#buffer.length > 0) break;
        throw new Error(`Fetched ${barren} consecutive pages without a usable item.`);
      }
    }
    if (this.#buffer.length === 0) return null;
    return this.#buffer.splice(0, this.#pageSize);
  }

  #exhausted(): boolean {
    return this.#remoteExhausted && this.#merge.drained();
  }

  async #loadMore(): Promise<void> {
    if (this.#remoteExhausted) return this.#merge.flush(this.#buffer);

    const batch = await this.#gate.fetch(
      () => this.#fetchItems(this.#remotePage, this.#remotePerPage));
    this.#remotePage += 1;
    // Only an empty page ends the walk. A short one does not: providers cap page size below what
    // was asked for (Cloudflare's own `/accounts` answers 20 to a request for 100), and treating
    // that as the end would silently omit every record after the first page.
    this.#remoteExhausted = batch.length === 0;

    const { overlay, filter } = this.#options;
    for (const fetched of batch) {
      const item = overlay ? overlay(fetched) : fetched;
      this.#merge.mergeAhead(item, this.#buffer);
      if (filter && !filter(item)) continue;
      this.#buffer.push(item);
    }

    if (this.#remoteExhausted) this.#merge.flush(this.#buffer);
  }
}

/** One provider page keyed by an opaque continuation token. `""` is a valid token. */
export type TokenPage<T> = {
  items: readonly T[];
  /** Absent ends the remote walk. Presence means "ask again", even when `items` is empty. */
  nextToken?: string;
};

/** As `StreamingCursorOptions`, for a provider that pages by continuation token. */
export type TokenCursorOptions<T, Raw = T> = StreamingCursorShape<T> & (
  | { fetchPage(token: string | undefined, perPage: number): Promise<TokenPage<T>>; map?: never }
  | {
      fetchPage(token: string | undefined, perPage: number): Promise<TokenPage<Raw>>;
      map(raw: Raw): T;
    }
);

/**
 * `StreamingCursor` for a provider that hands back an opaque continuation token instead of a page
 * number (marketo's `nextPageToken`/`moreResult`, notion, confluence, cloudflare, MCP).
 *
 * The token is the only thing that ends the walk, which is why this is a separate class rather than
 * a widened numeric signature: an empty page with a token is an ordinary idle window in an activity
 * stream, and inferring the end from it -- as page-number paging must -- silently truncates.
 */
export class TokenCursor<T, Raw = T> extends RpcTarget implements Cursor<T> {
  readonly #options: TokenCursorOptions<T, Raw>;
  readonly #fetchPage: (token: string | undefined, perPage: number) => Promise<TokenPage<T>>;
  readonly #pageSize: number;
  readonly #remotePerPage: number;
  readonly #merge: InjectedMerge<T>;
  readonly #gate = new CursorGate<T>();
  #buffer: T[] = [];
  #token?: string;
  #remoteExhausted = false;

  constructor(options: TokenCursorOptions<T, Raw>) {
    super();
    this.#options = options;
    const { fetchPage, map } = options;
    this.#fetchPage = map === undefined
      ? (token, perPage) => fetchPage(token, perPage) as Promise<TokenPage<T>>
      : async (token, perPage) => {
        const page = (await fetchPage(token, perPage)) as TokenPage<Raw>;
        return { items: page.items.map(map), nextToken: page.nextToken };
      };
    this.#pageSize = requirePageSize("pageSize", options.pageSize);
    this.#remotePerPage = requirePageSize("remotePageSize", options.remotePageSize ?? 100);
    this.#merge = new InjectedMerge(options.injected);
  }

  /** The next page, or null at the end. Concurrent callers are serialized rather than interleaved. */
  next(): Promise<T[] | null> {
    return this.#gate.next(() => this.#fill());
  }

  async #fill(): Promise<T[] | null> {
    // Two counters, because the two ways a page can yield nothing mean different things. Both are
    // bounded by MAX_BARREN_PAGES, and progress or exhaustion resets both.
    let idle = 0;
    let barren = 0;
    while (this.#buffer.length < this.#pageSize && !this.#exhausted()) {
      const before = this.#buffer.length;
      const fetched = await this.#loadMore();
      if (this.#buffer.length > before || this.#exhausted()) {
        idle = 0;
        barren = 0;
      } else if (fetched === 0) {
        // The provider itself had nothing for this window, which for an activity stream is a quiet
        // period rather than a fault. So the call ends instead of failing: `[]` is a legal
        // non-terminal page (only `null` ends a `Cursor`) and the next call resumes the walk.
        if (++idle >= MAX_BARREN_PAGES) return this.#buffer.splice(0, this.#pageSize);
      } else if (++barren >= MAX_BARREN_PAGES) {
        // Items arrived and were all dropped locally, which is `StreamingCursor`'s barren case.
        if (this.#buffer.length > 0) break;
        throw new Error(`Fetched ${barren} consecutive pages without a usable item.`);
      }
    }
    if (this.#buffer.length === 0) return null;
    return this.#buffer.splice(0, this.#pageSize);
  }

  #exhausted(): boolean {
    return this.#remoteExhausted && this.#merge.drained();
  }

  /** Fetches one page and buffers it, answering how many items the provider actually returned. */
  async #loadMore(): Promise<number> {
    if (this.#remoteExhausted) {
      this.#merge.flush(this.#buffer);
      return 0;
    }

    const asked = this.#token;
    const page = await this.#gate.fetch(() => this.#fetchPage(asked, this.#remotePerPage));
    const exhausted = page.nextToken === undefined;
    // A provider echoing the token it was asked to continue from is ignoring it, and the walk would
    // otherwise re-fetch that page until the idle or barren cap. Only the immediately-prior token
    // is compared: an unbounded seen-set would grow with the walk it is meant to protect. Checked
    // before anything moves, so the refusal describes a walk that has not advanced.
    if (!exhausted && page.nextToken === asked) {
      throw new Error(
        "Provider returned the same continuation token it was asked to continue from.");
    }
    this.#remoteExhausted = exhausted;
    this.#token = page.nextToken;

    const { overlay, filter } = this.#options;
    for (const fetched of page.items) {
      const item = overlay ? overlay(fetched) : fetched;
      this.#merge.mergeAhead(item, this.#buffer);
      if (filter && !filter(item)) continue;
      this.#buffer.push(item);
    }

    if (this.#remoteExhausted) this.#merge.flush(this.#buffer);
    return page.items.length;
  }
}
