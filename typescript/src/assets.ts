export interface AudioAssetCacheOptions<Context extends object, Decoded> {
  readonly fetchEncoded: (url: string) => Promise<ArrayBuffer | null>;
  readonly decode: (context: Context, bytes: ArrayBuffer) => Promise<Decoded>;
  /** Maximum encoded variants retained across contexts. Defaults to 64. */
  readonly maxEncodedEntries?: number;
  /** Maximum decoded candidate sets retained for one context. Defaults to 32. */
  readonly maxDecodedEntriesPerContext?: number;
}

export class AudioAssetCache<Context extends object, Decoded> {
  readonly #fetchEncoded: AudioAssetCacheOptions<Context, Decoded>['fetchEncoded'];
  readonly #decode: AudioAssetCacheOptions<Context, Decoded>['decode'];
  readonly #maxEncodedEntries: number;
  readonly #maxDecodedEntriesPerContext: number;
  readonly #encoded = new Map<string, Promise<ArrayBuffer | null>>();
  #decoded = new WeakMap<Context, Map<string, Promise<Decoded | null>>>();

  constructor(options: AudioAssetCacheOptions<Context, Decoded>) {
    this.#fetchEncoded = options.fetchEncoded;
    this.#decode = options.decode;
    this.#maxEncodedEntries = positiveInteger(options.maxEncodedEntries ?? 64, 'maxEncodedEntries');
    this.#maxDecodedEntriesPerContext = positiveInteger(
      options.maxDecodedEntriesPerContext ?? 32,
      'maxDecodedEntriesPerContext',
    );
  }

  preload(url: string): Promise<ArrayBuffer | null> {
    const cached = this.#encoded.get(url);
    if (cached !== undefined) {
      touch(this.#encoded, url, cached);
      return cached;
    }
    const request = this.#fetchEncoded(url).catch(() => null);
    this.#encoded.set(url, request);
    evictOldest(this.#encoded, this.#maxEncodedEntries);
    void request.then((bytes) => {
      if (bytes === null && this.#encoded.get(url) === request) this.#encoded.delete(url);
    });
    return request;
  }

  loadFirst(context: Context, candidateUrls: readonly string[]): Promise<Decoded | null> {
    const candidates = [...candidateUrls];
    const key = JSON.stringify(candidates);
    let contextCache = this.#decoded.get(context);
    if (contextCache === undefined) {
      contextCache = new Map();
      this.#decoded.set(context, contextCache);
    }
    const cached = contextCache.get(key);
    if (cached !== undefined) {
      touch(contextCache, key, cached);
      return cached;
    }
    const request = this.#decodeFirst(context, candidates);
    contextCache.set(key, request);
    evictOldest(contextCache, this.#maxDecodedEntriesPerContext);
    void request.then((decoded) => {
      if (decoded === null && contextCache.get(key) === request) contextCache.delete(key);
    });
    return request;
  }

  invalidateEncoded(url: string): void {
    this.#encoded.delete(url);
  }

  invalidateDecoded(context: Context, candidateUrls?: readonly string[]): void {
    if (candidateUrls === undefined) {
      this.#decoded.delete(context);
      return;
    }
    this.#decoded.get(context)?.delete(JSON.stringify(candidateUrls));
  }

  clear(): void {
    this.#encoded.clear();
    this.#decoded = new WeakMap();
  }

  async #decodeFirst(context: Context, candidateUrls: readonly string[]): Promise<Decoded | null> {
    for (const url of candidateUrls) {
      const bytes = await this.preload(url);
      if (bytes === null) continue;
      try {
        return await this.#decode(context, bytes.slice(0));
      } catch {
        // A codec declaration may be optimistic; try the next immutable variant.
      }
    }
    return null;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function touch<Key, Value>(map: Map<Key, Value>, key: Key, value: Value): void {
  map.delete(key);
  map.set(key, value);
}

function evictOldest<Key, Value>(map: Map<Key, Value>, maximumSize: number): void {
  while (map.size > maximumSize) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}
