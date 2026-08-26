import { describe, expect, it } from 'vitest';

import { effectiveAudioLevel, normalizeAudioPreferences } from '../src/index.js';

describe('audio preferences', () => {
  it('normalizes persisted values for an explicit channel vocabulary', () => {
    const preferences = normalizeAudioPreferences(
      {
        masterLevel: 0.8,
        channelLevels: { music: 0.5, effects: 4 },
        reducedIntensity: true,
      },
      ['music', 'effects'] as const,
    );
    expect(preferences).toEqual({
      muted: false,
      masterLevel: 0.8,
      channelLevels: { music: 0.5, effects: 1 },
      reducedIntensity: true,
    });
    expect(effectiveAudioLevel(preferences, 'effects', 'material', 0.5)).toBeCloseTo(0.22);
    expect(effectiveAudioLevel(preferences, 'effects', 'important', 0.5)).toBeCloseTo(0.4);
  });

  it('makes mute authoritative and treats malformed input as safe defaults', () => {
    const defaults = normalizeAudioPreferences('invalid', ['music'] as const);
    expect(defaults.channelLevels.music).toBe(1);
    expect(effectiveAudioLevel({ ...defaults, muted: true }, 'music', 'important', 1)).toBe(0);
  });

  it('treats every caller-defined channel as an own data key', () => {
    const preferences = normalizeAudioPreferences({}, ['__proto__'] as const);
    expect(Object.hasOwn(preferences.channelLevels, '__proto__')).toBe(true);
    expect(preferences.channelLevels.__proto__).toBe(1);
  });
});
