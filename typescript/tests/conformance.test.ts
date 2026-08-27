import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { validateAudioEffectChain, type AudioEffectConfig } from '../src/index.js';

interface EffectChainVector {
  readonly name: string;
  readonly valid: boolean;
  readonly effects: readonly AudioEffectConfig[];
}

const fixture = JSON.parse(
  readFileSync(new URL('../../rust/fixtures/effects-v1.json', import.meta.url), 'utf8'),
) as { readonly profile: string; readonly chains: readonly EffectChainVector[] };

describe('cross-language effect conformance', () => {
  it('accepts and rejects the same common effect contracts', () => {
    expect(fixture.profile).toBe('audio-core-effects-v1');
    for (const vector of fixture.chains) {
      const validate = (): void => {
        validateAudioEffectChain(vector.effects);
      };
      if (vector.valid) expect(validate, vector.name).not.toThrow();
      else expect(validate, vector.name).toThrow();
    }
  });
});
