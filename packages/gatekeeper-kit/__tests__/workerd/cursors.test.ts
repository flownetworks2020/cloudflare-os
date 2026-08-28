import { describe, expect, it, vi } from "vitest";
import { ArrayCursor, StreamingCursor, TokenCursor, type TokenPage } from "../../src/cursors";

type Issue = { id: number; open: boolean };

/** Pages a fixed list the way a provider does: a short page means the end. */
function pagedApi(items: Issue[]) {
  return vi.fn(async (page: number, perPage: number) =>
    items.slice((page - 1) * perPage, page * perPage));
}

/** Serves a scripted sequence of token pages; past the end the provider reports exhaustion. */
function tokenApi(pages: TokenPage<Issue>[]) {
  let index = 0;
  return vi.fn(async (_token: string | undefined, _perPage: number) =>
    pages[index++] ?? { items: [] });
}

const ids = (page: Issue[] | null) => page?.map(issue => issue.id);

describe("ArrayCursor", () => {
  it("pages a held list, then reports the end", async () => {
    const cursor = new ArrayCursor([1, 2, 3], 2);

    expect(await cursor.next()).toEqual([1, 2]);
    expect(await cursor.next()).toEqual([3]);
    expect(await cursor.next()).toBeNull();
  });

  it("reports the end immediately for an empty list", async () => {
    expect(await new ArrayCursor([], 2).next()).toBeNull();
  });

  it("rejects a page size that would never terminate", () => {
    expect(() => new ArrayCursor([1], 0)).toThrow(/positive integer/);
    expect(() => new ArrayCursor([1], 1.5)).toThrow(/positive integer/);
  });
});

describe("StreamingCursor", () => {
  it("fetches only the provider pages a page of results needs", async () => {
    const fetchPage = pagedApi([1, 2, 3, 4, 5].map(id => ({ id, open: true })));
    const cursor = new StreamingCursor<Issue>({ fetchPage, pageSize: 2, remotePageSize: 2 });

    expect((await cursor.next())?.map(issue => issue.id)).toEqual([1, 2]);
    expect(fetchPage).toHaveBeenCalledOnce();

    expect((await cursor.next())?.map(issue => issue.id)).toEqual([3, 4]);
    expect((await cursor.next())?.map(issue => issue.id)).toEqual([5]);
    expect(await cursor.next()).toBeNull();
  });

  it("keeps fetching past pages the filter empties", async () => {
    const items = [1, 2, 3, 4, 5, 6].map(id => ({ id, open: id > 4 }));
    const cursor = new StreamingCursor<Issue>({
      fetchPage: pagedApi(items),
      filter: issue => issue.open,
      pageSize: 2,
      remotePageSize: 2,
    });

    expect((await cursor.next())?.map(issue => issue.id)).toEqual([5, 6]);
    expect(await cursor.next()).toBeNull();
  });

  it("maps provider items and overlays pending edits", async () => {
    const cursor = new StreamingCursor<Issue, { number: number }>({
      fetchPage: async page => page === 1 ? [{ number: 1 }, { number: 2 }] : [],
      map: raw => ({ id: raw.number, open: true }),
      overlay: issue => issue.id === 2 ? { ...issue, open: false } : issue,
      pageSize: 10,
    });

    expect(await cursor.next()).toEqual([{ id: 1, open: true }, { id: 2, open: false }]);
  });

  it("filters after the overlay, so a pending edit decides eligibility", async () => {
    const seen: string[] = [];
    const cursor = new StreamingCursor<Issue>({
      fetchPage: pagedApi([{ id: 1, open: false }, { id: 2, open: true }]),
      // A queued action reopens 1 and closes 2; filtering first would judge the stale values.
      overlay: issue => { seen.push(`overlay:${issue.id}`); return { ...issue, open: !issue.open }; },
      filter: issue => { seen.push(`filter:${issue.id}`); return issue.open; },
      pageSize: 10,
    });

    expect((await cursor.next())?.map(issue => issue.id)).toEqual([1]);
    expect(seen).toEqual(["overlay:1", "filter:1", "overlay:2", "filter:2"]);
  });

  it("merges simulated items at their sort position, including after the last page", async () => {
    const cursor = new StreamingCursor<Issue>({
      fetchPage: pagedApi([1, 4].map(id => ({ id, open: true }))),
      injected: {
        items: [{ id: 2, open: true }, { id: 9, open: true }],
        comparator: (a, b) => a.id - b.id,
      },
      pageSize: 10,
      remotePageSize: 2,
    });

    expect((await cursor.next())?.map(issue => issue.id)).toEqual([1, 2, 4, 9]);
    expect(await cursor.next()).toBeNull();
  });

  it("returns simulated items when the provider has none", async () => {
    const cursor = new StreamingCursor<Issue>({
      fetchPage: async () => [],
      injected: { items: [{ id: 7, open: true }], comparator: (a, b) => a.id - b.id },
      pageSize: 10,
    });

    expect((await cursor.next())?.map(issue => issue.id)).toEqual([7]);
    expect(await cursor.next()).toBeNull();
  });

  it("serializes concurrent callers instead of duplicating and skipping pages", async () => {
    const items = [1, 2, 3, 4, 5, 6].map(id => ({ id, open: true }));
    const fetchPage = pagedApi(items);
    const cursor = new StreamingCursor<Issue>({ fetchPage, pageSize: 2, remotePageSize: 2 });

    // A gadget can pipeline these; the provider page counter must not be read twice before it moves.
    const pages = await Promise.all([cursor.next(), cursor.next(), cursor.next()]);

    expect(pages.map(page => page?.map(issue => issue.id)))
      .toEqual([[1, 2], [3, 4], [5, 6]]);
    expect(fetchPage.mock.calls.map(([page]) => page)).toEqual([1, 2, 3]);
  });

  it("gives up on a provider that never yields a usable item", async () => {
    // Full pages the filter always empties: without the cap this loops until the provider ends,
    // which for a page-ignoring one is never.
    const fetchPage = vi.fn(async (_page: number, perPage: number) =>
      Array.from({ length: perPage }, (_, index) => ({ id: index, open: false })));
    const cursor = new StreamingCursor<Issue>({
      fetchPage,
      filter: issue => issue.open,
      pageSize: 2,
      remotePageSize: 2,
    });

    await expect(cursor.next())
      .rejects.toThrow("Fetched 50 consecutive pages without a usable item.");
    expect(fetchPage).toHaveBeenCalledTimes(50);
  });

  it("returns simulated items a run of filtered pages would otherwise bury", async () => {
    // A filtered-out provider item still has a sort position, so a simulated item before it must
    // not wait for one that survives the filter.
    const fetchPage = vi.fn(async (page: number, perPage: number) =>
      Array.from({ length: perPage }, (_, index) => ({ id: page * 100 + index, open: false })));
    const cursor = new StreamingCursor<Issue>({
      fetchPage,
      filter: issue => issue.open,
      injected: { items: [{ id: 1, open: true }], comparator: (a, b) => a.id - b.id },
      pageSize: 2,
      remotePageSize: 2,
    });

    // Short rather than empty: the item that exists beats the error the cap would report.
    expect((await cursor.next())?.map(issue => issue.id)).toEqual([1]);
    // Page 1 placed it, then a full barren window ended the call.
    expect(fetchPage).toHaveBeenCalledTimes(51);

    // Nothing usable left, so the next call spends its own window.
    await expect(cursor.next())
      .rejects.toThrow("Fetched 50 consecutive pages without a usable item.");
  });

  it("keeps walking a provider that caps pages below the size asked for", async () => {
    const items = Array.from({ length: 45 }, (_, index) => ({ id: index + 1, open: true }));
    // Answers 20 to a request for 100, as Cloudflare's own /accounts endpoint does.
    const fetchPage = vi.fn(async (page: number) => items.slice((page - 1) * 20, page * 20));
    const cursor = new StreamingCursor<Issue>({ fetchPage, pageSize: 100, remotePageSize: 100 });

    // Stopping at the first short page would have returned only the first 20.
    expect((await cursor.next())?.length).toBe(45);
    expect(await cursor.next()).toBeNull();
  });

  it("stays failed once a transform throws, rather than resuming past the lost page", async () => {
    const fetchPage = pagedApi([1, 2, 3, 4].map(id => ({ id, open: true })));
    const cursor = new StreamingCursor<Issue>({
      fetchPage,
      overlay: issue => { throw new Error(`overlay broke on ${issue.id}`); },
      pageSize: 2,
      remotePageSize: 2,
    });

    await expect(cursor.next()).rejects.toThrow("overlay broke on 1");
    // Resuming would silently skip the rest of the batch the failure abandoned.
    await expect(cursor.next()).rejects.toThrow("cannot be resumed");
    expect(fetchPage).toHaveBeenCalledOnce();
  });

  it("resumes after a provider rejection, which moved no paging state", async () => {
    const pages = [[{ id: 1, open: true }], [{ id: 2, open: true }]];
    let attempt = 0;
    const cursor = new StreamingCursor<Issue>({
      fetchPage: async page => {
        if (++attempt === 1) throw new Error("provider 503");
        return pages[page - 1] ?? [];
      },
      pageSize: 1,
      remotePageSize: 1,
    });

    await expect(cursor.next()).rejects.toThrow("provider 503");
    // The same page, not the next one: a rejection consumed nothing.
    expect(await cursor.next()).toEqual([{ id: 1, open: true }]);
    expect(await cursor.next()).toEqual([{ id: 2, open: true }]);
  });

  it("reports the end rather than an error when the provider is simply empty", async () => {
    const cursor = new StreamingCursor<Issue>({ fetchPage: async () => [], pageSize: 2 });

    expect(await cursor.next()).toBeNull();
  });

  it("stays failed even when the transform throws undefined", async () => {
    const cursor = new StreamingCursor<Issue>({
      fetchPage: pagedApi([{ id: 1, open: true }]),
      // eslint-disable-next-line no-throw-literal
      overlay: () => { throw undefined; },
      pageSize: 2,
    });

    await expect(cursor.next()).rejects.toBeUndefined();
    await expect(cursor.next()).rejects.toThrow("cannot be resumed");
  });

  it("rejects page sizes that would never terminate", () => {
    const fetchPage = pagedApi([]);
    expect(() => new StreamingCursor<Issue>({ fetchPage, pageSize: 0 })).toThrow(/positive integer/);
    expect(() => new StreamingCursor<Issue>({ fetchPage, pageSize: 2, remotePageSize: 0 }))
      .toThrow(/positive integer/);
    expect(() => new StreamingCursor<Issue>({ fetchPage, pageSize: 2.5 }))
      .toThrow(/positive integer/);
  });
});

describe("TokenCursor", () => {
  it("walks until the token is absent, not until a page is empty", async () => {
    // Marketo's shape: an empty window mid-walk, and `""` as a real continuation token. Ending on
    // either -- as page-number paging must -- silently truncates the walk.
    const fetchPage = tokenApi([
      { items: [{ id: 1, open: true }, { id: 2, open: true }], nextToken: "a" },
      { items: [], nextToken: "b" },
      { items: [{ id: 3, open: true }], nextToken: "" },
      { items: [{ id: 4, open: true }] },
    ]);
    const cursor = new TokenCursor<Issue>({ fetchPage, pageSize: 10, remotePageSize: 25 });

    expect(ids(await cursor.next())).toEqual([1, 2, 3, 4]);
    expect(await cursor.next()).toBeNull();
    expect(fetchPage.mock.calls).toEqual([
      [undefined, 25], ["a", 25], ["b", 25], ["", 25],
    ]);
  });

  it("ends the call rather than failing on a provider with nothing for this window", async () => {
    // An activity stream answers empty windows for a quiet period, so this is pacing, not a fault.
    const fetchPage = tokenApi([
      ...Array.from({ length: 60 }, (_, index) => ({ items: [], nextToken: `w${index}` })),
      { items: [{ id: 1, open: true }] },
    ]);
    const cursor = new TokenCursor<Issue>({ fetchPage, pageSize: 2 });

    // `[]` is a legal non-terminal page: only `null` ends a cursor, so the walk survives the cap.
    expect(await cursor.next()).toEqual([]);
    expect(fetchPage).toHaveBeenCalledTimes(50);
    expect(ids(await cursor.next())).toEqual([1]);
    expect(await cursor.next()).toBeNull();
  });

  it("re-sends the same token after a provider rejection", async () => {
    // The position lives in the cursor, so latching a transient failure would cost the whole walk.
    const asked: (string | undefined)[] = [];
    let attempt = 0;
    const cursor = new TokenCursor<Issue>({
      fetchPage: async token => {
        asked.push(token);
        if (++attempt === 2) throw new Error("provider 503");
        return { items: [{ id: attempt, open: true }], nextToken: attempt < 3 ? "t2" : undefined };
      },
      pageSize: 1,
    });

    expect(ids(await cursor.next())).toEqual([1]);
    await expect(cursor.next()).rejects.toThrow("provider 503");
    expect(ids(await cursor.next())).toEqual([3]);
    expect(asked).toEqual([undefined, "t2", "t2"]);
  });

  it("refuses a provider that echoes the token it was asked to continue from", async () => {
    const fetchPage = tokenApi([
      { items: [{ id: 1, open: true }], nextToken: "same" },
      { items: [{ id: 2, open: true }], nextToken: "same" },
    ]);
    const cursor = new TokenCursor<Issue>({ fetchPage, pageSize: 10 });

    await expect(cursor.next()).rejects.toThrow(/same continuation token/);
    // Terminal like any other cursor failure: the walk cannot be resumed from a token it re-served.
    await expect(cursor.next()).rejects.toThrow("cannot be resumed");
  });

  it("gives up on pages whose items are all dropped locally", async () => {
    let page = 0;
    const fetchPage = vi.fn(async () =>
      ({ items: [{ id: ++page, open: false }], nextToken: `t${page}` }));
    const cursor = new TokenCursor<Issue>({
      fetchPage,
      filter: issue => issue.open,
      pageSize: 2,
    });

    await expect(cursor.next())
      .rejects.toThrow("Fetched 50 consecutive pages without a usable item.");
    expect(fetchPage).toHaveBeenCalledTimes(50);
  });

  it("returns a simulated item a run of dropped pages would otherwise bury", async () => {
    let page = 0;
    const fetchPage = vi.fn(async () =>
      ({ items: [{ id: 100 + ++page, open: false }], nextToken: `t${page}` }));
    const cursor = new TokenCursor<Issue>({
      fetchPage,
      filter: issue => issue.open,
      injected: { items: [{ id: 1, open: true }], comparator: (a, b) => a.id - b.id },
      pageSize: 2,
    });

    // The injected item sorts before the first fetched one, filtered or not, so it is buffered on
    // page 1 and handed back short instead of being lost to the barren throw.
    expect(ids(await cursor.next())).toEqual([1]);
    expect(fetchPage).toHaveBeenCalledTimes(51);
  });

  it("maps provider pages and overlays pending edits", async () => {
    const cursor = new TokenCursor<Issue, { number: number }>({
      fetchPage: async token => token === undefined
        ? { items: [{ number: 1 }, { number: 2 }], nextToken: "n" }
        : { items: [] },
      map: raw => ({ id: raw.number, open: true }),
      overlay: issue => issue.id === 2 ? { ...issue, open: false } : issue,
      pageSize: 10,
    });

    expect(await cursor.next()).toEqual([{ id: 1, open: true }, { id: 2, open: false }]);
  });

  it("serializes concurrent callers instead of duplicating and skipping pages", async () => {
    const fetchPage = tokenApi([
      { items: [{ id: 1, open: true }, { id: 2, open: true }], nextToken: "a" },
      { items: [{ id: 3, open: true }, { id: 4, open: true }], nextToken: "b" },
      { items: [{ id: 5, open: true }] },
    ]);
    const cursor = new TokenCursor<Issue>({ fetchPage, pageSize: 2, remotePageSize: 2 });

    const pages = await Promise.all([cursor.next(), cursor.next(), cursor.next()]);

    expect(pages.map(page => ids(page))).toEqual([[1, 2], [3, 4], [5]]);
    expect(fetchPage.mock.calls.map(([token]) => token)).toEqual([undefined, "a", "b"]);
  });

  it("rejects page sizes that would never terminate", () => {
    const fetchPage = tokenApi([]);
    expect(() => new TokenCursor<Issue>({ fetchPage, pageSize: 0 })).toThrow(/positive integer/);
    expect(() => new TokenCursor<Issue>({ fetchPage, pageSize: 2, remotePageSize: 1.5 }))
      .toThrow(/positive integer/);
  });
});
