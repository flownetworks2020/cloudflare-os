import { afterEach, describe, expect, it, vi } from "vitest";
import { KvTtlCache, type CacheKv } from "../src/cache";
import { fakeKv } from "./fake-kv";

function makeKv(): CacheKv {
  return fakeKv();
}

afterEach(() => void vi.useRealTimers());

describe("KvTtlCache", () => {
  it("loads once, then serves the entry until its TTL elapses", async () => {
    vi.useFakeTimers();
    const cache = new KvTtlCache(makeKv());
    const load = vi.fn(async () => ({ name: "acme" }));

    expect(await cache.cached("project", 1000, load)).toEqual({ name: "acme" });
    vi.advanceTimersByTime(999);
    expect(await cache.cached("project", 1000, load)).toEqual({ name: "acme" });
    expect(load).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(1);
    expect(await cache.cached("project", 1000, load)).toEqual({ name: "acme" });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("reloads every entry after the generation is bumped", async () => {
    const cache = new KvTtlCache(makeKv());
    await cache.cached("a", 60_000, async () => 1);
    await cache.cached("b", 60_000, async () => 2);

    cache.bumpGeneration();
    expect(await cache.cached("a", 60_000, async () => 3)).toBe(3);
    expect(await cache.cached("b", 60_000, async () => 4)).toBe(4);

    // Reloaded against the new generation, so the entry is live again.
    expect(await cache.cached("a", 60_000, async () => 5)).toBe(3);
  });

  it("does not store a value the generation bump invalidated mid-load", async () => {
    const cache = new KvTtlCache(makeKv());
    const { promise, resolve } = Promise.withResolvers<number>();

    const loading = cache.cached("schema", 60_000, () => promise);
    cache.bumpGeneration();
    resolve(1);

    // This caller asked before the bump, so it still receives what it waited for.
    expect(await loading).toBe(1);
    // The entry was not kept: it describes the state the bump declared stale.
    expect(await cache.cached("schema", 60_000, async () => 2)).toBe(2);
  });
});
