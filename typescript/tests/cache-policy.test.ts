import { describe, expect, it, vi } from "vitest";

import { AudioAssetCache } from "../src/index.js";

describe("AudioAssetCache resource policy", () => {
  it("bounds encoded and per-context decoded caches with LRU eviction", async () => {
    const fetchEncoded = vi.fn((url: string) => {
      Boolean(url);
      return Promise.resolve(new ArrayBuffer(2));
    });
    const decode = vi.fn((_context: object, bytes: ArrayBuffer) =>
      Promise.resolve(bytes.byteLength),
    );
    const cache = new AudioAssetCache({
      fetchEncoded,
      decode,
      maxEncodedEntries: 2,
      maxDecodedEntriesPerContext: 1,
    });
    const context = {};

    await cache.loadFirst(context, ["a"]);
    await cache.loadFirst(context, ["b"]);
    await cache.loadFirst(context, ["a"]);
    await cache.preload("c");
    await cache.preload("b");
    expect(decode).toHaveBeenCalledTimes(3);
    expect(fetchEncoded.mock.calls.map(([url]) => url)).toEqual([
      "a",
      "b",
      "c",
      "b",
    ]);
  });

  it("can invalidate one candidate set or all cached state", async () => {
    const decode = vi.fn((_context: object, bytes: ArrayBuffer) =>
      Promise.resolve(bytes.byteLength),
    );
    const fetchEncoded = vi.fn(() => Promise.resolve(new ArrayBuffer(2)));
    const cache = new AudioAssetCache({ fetchEncoded, decode });
    const context = {};

    await cache.loadFirst(context, ["a"]);
    cache.invalidateDecoded(context, ["a"]);
    await cache.loadFirst(context, ["a"]);
    cache.clear();
    await cache.loadFirst(context, ["a"]);
    expect(decode).toHaveBeenCalledTimes(3);
    expect(fetchEncoded).toHaveBeenCalledTimes(2);
  });

  it("rejects unbounded or nonsensical cache configuration", () => {
    const options = {
      fetchEncoded: () => Promise.resolve(null),
      decode: (context: object, bytes: ArrayBuffer) => {
        Boolean(context);
        Boolean(bytes);
        return Promise.resolve(null);
      },
    };
    expect(
      () => new AudioAssetCache({ ...options, maxEncodedEntries: 0 }),
    ).toThrow(/maxEncodedEntries/u);
    expect(
      () =>
        new AudioAssetCache({ ...options, maxDecodedEntriesPerContext: 1.5 }),
    ).toThrow(/maxDecodedEntriesPerContext/u);
  });
});
