import { describe, expect, it } from 'vitest';

import { validateAudioEffectChain, validateAudioEffectConfig } from '../src/index.js';

describe('audio effect contracts', () => {
  it('accepts filters, EQ, saturation, compression, reverb, and delay', () => {
    expect(() => {
      validateAudioEffectChain([
        { id: 'hp', type: 'highpass', frequencyHz: 40, q: 0.707 },
        { id: 'lp', type: 'lowpass', frequencyHz: 18_000 },
        {
          id: 'eq',
          type: 'equalizer',
          bands: [
            { type: 'lowshelf', frequencyHz: 100, gainDb: 2 },
            { type: 'peaking', frequencyHz: 2_000, gainDb: -3, q: 1.4 },
            { type: 'highshelf', frequencyHz: 10_000, gainDb: 1 },
          ],
        },
        { id: 'sat', type: 'saturation', drive: 4, mix: 0.5 },
        { id: 'comp', type: 'compressor', thresholdDb: -20, ratio: 4 },
        { id: 'verb', type: 'reverb', roomSize: 0.6, damping: 0.4 },
        { id: 'delay', type: 'delay', delaySeconds: 0.25, feedback: 0.35 },
      ]);
    }).not.toThrow();
  });

  it('rejects unsafe feedback, malformed EQ, and invalid compressor policy', () => {
    expect(() => {
      validateAudioEffectConfig({ id: 'delay', type: 'delay', delaySeconds: 1, feedback: 1 });
    }).toThrow(/feedback/u);
    expect(() => {
      validateAudioEffectConfig({ id: 'eq', type: 'equalizer', bands: [] });
    }).toThrow(/equalizer/u);
    expect(() => {
      validateAudioEffectConfig({ id: 'comp', type: 'compressor', ratio: 30 });
    }).toThrow(/ratio/u);
  });
});
