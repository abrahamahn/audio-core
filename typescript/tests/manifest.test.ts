import { describe, expect, it, vi } from 'vitest';

import {
  audioAssetCandidateUrls,
  resolveAudioAssetLoadMode,
  selectAudioAssetVariant,
  type AudioAssetManifestEntry,
} from '../src/index.js';

const entry: AudioAssetManifestEntry = {
  version: 'sha256:abc',
  durationMs: 180_000,
  delivery: 'auto',
  variants: [
    { url: 'music.opus', mimeType: 'audio/ogg', codec: 'opus' },
    { url: 'music.mp3', mimeType: 'audio/mpeg' },
  ],
};

describe('audio asset manifests', () => {
  it('selects the first supported immutable variant and preserves fallback order', () => {
    const canPlayType = vi.fn((mimeType: string) => mimeType === 'audio/mpeg');
    expect(selectAudioAssetVariant(entry, { canPlayType })?.url).toBe('music.mp3');
    expect(audioAssetCandidateUrls(entry, { canPlayType })).toEqual(['music.mp3']);
  });

  it('chooses stream or decode from delivery and memory policy', () => {
    expect(resolveAudioAssetLoadMode(entry)).toBe('stream');
    expect(resolveAudioAssetLoadMode(entry, { streamingSupported: false })).toBe('decode');
    expect(resolveAudioAssetLoadMode({ ...entry, delivery: 'decode' })).toBe('decode');
    expect(
      resolveAudioAssetLoadMode({ ...entry, delivery: 'stream' }, { streamingSupported: false }),
    ).toBeNull();
  });

  it('rejects malformed manifests before fetch or decode', () => {
    expect(() => selectAudioAssetVariant({ version: '', variants: [] })).toThrow(/version/u);
    expect(() =>
      selectAudioAssetVariant({ version: '1', variants: [{ url: '', byteLength: -1 }] }),
    ).toThrow(/URL/u);
    expect(() =>
      selectAudioAssetVariant({
        version: '1',
        variants: [{ url: 'tone.ogg' }],
        loudnessLufs: Number.NaN,
      }),
    ).toThrow(/loudnessLufs/u);
  });
});
