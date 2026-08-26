import { describe, expect, it, vi } from 'vitest';

import {
  AudioAssetCache,
  CueScheduler,
  audioActivationAllowsPlayback,
  clampAudioLevel,
  clampPan,
  gainForVolume,
  panForSeat,
  panForTablePosition,
  visibilityAllowsSound,
  type AudioCueRequest,
} from '../src/index.js';

describe('audio policy', () => {
  it('uses a perceptual gain curve and restrained seat pan', () => {
    expect(gainForVolume(50)).toBeCloseTo(0.25);
    expect(panForSeat(2, 5)).toBe(0);
    expect(panForSeat(4, 5)).toBeCloseTo(0.82);
    expect(panForSeat(0, 1)).toBe(0);
    expect(panForSeat(Number.POSITIVE_INFINITY, 5)).toBeCloseTo(-0.82);
    expect(panForTablePosition(50)).toBe(0);
    expect(panForTablePosition(-100)).toBeCloseTo(-0.82);
    expect(clampAudioLevel(Number.NaN)).toBe(1);
    expect(clampAudioLevel(-1)).toBe(0);
    expect(clampPan(Number.NaN)).toBe(0);
    expect(clampPan(2)).toBe(1);
    expect(audioActivationAllowsPlayback(undefined)).toBe(true);
    expect(audioActivationAllowsPlayback({ hasBeenActive: false })).toBe(false);
    expect(visibilityAllowsSound('hidden')).toBe(false);
    expect(visibilityAllowsSound(undefined)).toBe(true);
  });

  it('keeps cue identities and application scheduling metadata generic', () => {
    const request: AudioCueRequest<'notification'> = {
      cue: 'notification',
      bus: 'ui',
      priority: 'important',
      eventId: 'event-1',
      delayMs: 50,
    };
    expect(request).toMatchObject({ cue: 'notification', bus: 'ui' });
  });
});

describe('CueScheduler', () => {
  it('deduplicates rapid cues and supports cancellation groups', () => {
    const scheduler = new CueScheduler<'deal'>({ defaultMinGapMs: 60 });
    expect(scheduler.canPlay('deal', 100)).toBe(true);
    scheduler.markPlayed('deal', 100);
    expect(scheduler.canPlay('deal', 159)).toBe(false);
    expect(scheduler.canPlay('deal', 160)).toBe(true);
    scheduler.cancelGroup('scene');
    expect(scheduler.canPlay('deal', 200, 'scene')).toBe(false);
    scheduler.reopenGroup('scene');
    expect(scheduler.canPlay('deal', 200, 'scene')).toBe(true);
    scheduler.reset();
    expect(scheduler.canPlay('deal', 0)).toBe(true);
  });

  it('supports per-cue gaps and rejects invalid time policy', () => {
    const scheduler = new CueScheduler<'deal' | 'alert'>({
      defaultMinGapMs: 60,
      minGapForCue: (cue) => (cue === 'alert' ? 500 : undefined),
    });
    scheduler.markPlayed('alert', 1_000);
    expect(scheduler.canPlay('alert', 1_499)).toBe(false);
    expect(scheduler.canPlay('alert', 1_500)).toBe(true);
    expect(() => scheduler.canPlay('deal', Number.NaN)).toThrow(/nowMs/u);
    expect(() => new CueScheduler({ defaultMinGapMs: -1 })).toThrow(/defaultMinGapMs/u);
  });
});

describe('AudioAssetCache', () => {
  it('shares encoded bytes and decoded results while falling back by variant', async () => {
    const fetchEncoded = vi.fn((url: string) =>
      Promise.resolve(url.endsWith('.bad') ? new ArrayBuffer(1) : new ArrayBuffer(2)),
    );
    const decode = vi.fn((_context: object, bytes: ArrayBuffer) => {
      if (bytes.byteLength === 1) return Promise.reject(new Error('unsupported'));
      return Promise.resolve({ byteLength: bytes.byteLength });
    });
    const cache = new AudioAssetCache({ fetchEncoded, decode });
    const context = {};
    await expect(cache.loadFirst(context, ['tone.bad', 'tone.good'])).resolves.toEqual({
      byteLength: 2,
    });
    await cache.loadFirst(context, ['tone.bad', 'tone.good']);
    expect(fetchEncoded).toHaveBeenCalledTimes(2);
    expect(decode).toHaveBeenCalledTimes(2);
  });

  it('shares concurrent work per context but decodes independently across contexts', async () => {
    const fetchEncoded = vi.fn(() => Promise.resolve(new ArrayBuffer(4)));
    const decode = vi.fn((_context: object, bytes: ArrayBuffer) =>
      Promise.resolve({ byteLength: bytes.byteLength }),
    );
    const cache = new AudioAssetCache({ fetchEncoded, decode });
    const firstContext = {};
    const secondContext = {};
    const first = cache.loadFirst(firstContext, ['tone.ogg']);
    const duplicate = cache.loadFirst(firstContext, ['tone.ogg']);
    expect(first).toBe(duplicate);
    await Promise.all([first, cache.loadFirst(secondContext, ['tone.ogg'])]);
    expect(fetchEncoded).toHaveBeenCalledTimes(1);
    expect(decode).toHaveBeenCalledTimes(2);

    cache.invalidateDecoded(firstContext);
    await cache.loadFirst(firstContext, ['tone.ogg']);
    expect(decode).toHaveBeenCalledTimes(3);
  });

  it('does not permanently cache transient fetch or decode failure', async () => {
    let available = false;
    const fetchEncoded = vi.fn(() => Promise.resolve(available ? new ArrayBuffer(8) : null));
    const decode = vi.fn((_context: object, bytes: ArrayBuffer) =>
      Promise.resolve({ byteLength: bytes.byteLength }),
    );
    const cache = new AudioAssetCache({ fetchEncoded, decode });
    const context = {};

    await expect(cache.loadFirst(context, ['tone.ogg'])).resolves.toBeNull();
    available = true;
    await expect(cache.loadFirst(context, ['tone.ogg'])).resolves.toEqual({
      byteLength: 8,
    });
    expect(fetchEncoded).toHaveBeenCalledTimes(2);
  });

  it('snapshots a caller-owned candidate list before asynchronous fallback', async () => {
    const fetchEncoded = vi.fn((url: string) =>
      Promise.resolve(new ArrayBuffer(url === 'first' ? 1 : 2)),
    );
    const decode = vi.fn((_context: object, bytes: ArrayBuffer) => {
      if (bytes.byteLength === 1) return Promise.reject(new Error('unsupported'));
      return Promise.resolve(bytes.byteLength);
    });
    const cache = new AudioAssetCache({ fetchEncoded, decode });
    const candidates = ['first', 'second'];
    const pending = cache.loadFirst({}, candidates);
    candidates.splice(0, candidates.length, 'mutated');
    await expect(pending).resolves.toBe(2);
    expect(fetchEncoded).toHaveBeenNthCalledWith(2, 'second');
  });
});
