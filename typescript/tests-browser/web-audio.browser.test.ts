import { afterEach, describe, expect, it } from 'vitest';

import type { AudioOutputTelemetryEvent } from '../src/telemetry.js';
import { WebAudioOutput } from '../src/web-audio.js';

const contexts: AudioContext[] = [];

function createContext(): AudioContext {
  const context = new AudioContext();
  contexts.push(context);
  return context;
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(async (context) => context.close()));
});

describe('WebAudioOutput in a real browser audio graph', () => {
  it('replaces the one logical source in single-channel mode', () => {
    const context = createContext();
    const output = new WebAudioOutput(context, {
      mode: 'single-channel',
      channel: 'music',
    });
    const first = context.createOscillator();
    const second = context.createOscillator();

    const firstRoute = output.connectNode(first, { channel: 'music' });
    const secondRoute = output.connectNode(second, { channel: 'music' });

    expect(firstRoute).not.toBeNull();
    expect(secondRoute).not.toBeNull();
    expect(output.activeVoiceCount('music')).toBe(1);
    output.dispose();
  });

  it('mixes bounded voices, limiting and ducking under one master bus', () => {
    type Channel = 'effects' | 'music';
    const context = createContext();
    const events: AudioOutputTelemetryEvent<Channel>[] = [];
    const output = new WebAudioOutput<Channel>(
      context,
      {
        mode: 'multi-channel',
        channels: {
          music: { maxVoices: 1, overflow: 'stop-oldest' },
          effects: { maxVoices: 2, overflow: 'reject-new' },
        },
      },
      {
        limiter: { thresholdDb: -8, ratio: 5 },
        telemetry: (event) => events.push(event),
      },
    );
    const buffer = context.createBuffer(1, 128, context.sampleRate);

    const first = output.playBuffer(buffer, { channel: 'effects', pan: -0.3 });
    const second = output.playBuffer(buffer, { channel: 'effects', pan: 0.3 });
    const rejected = output.playBuffer(buffer, { channel: 'effects' });
    output.duck([{ channel: 'music', level: 0.35 }], {
      attackMs: 20,
      holdMs: 50,
      releaseMs: 100,
    });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(rejected).toBeNull();
    expect(output.limiterNode).toBeInstanceOf(DynamicsCompressorNode);
    expect(output.activeVoiceCount('effects')).toBe(2);
    expect(events.some(({ type }) => type === 'output.voice-dropped')).toBe(true);
    expect(events.some(({ type }) => type === 'output.duck')).toBe(true);
    output.dispose();
  });
});
