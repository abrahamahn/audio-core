import { afterEach, describe, expect, it } from 'vitest';

import { loadRustAudioWorklet } from '../src/rust-audio-worklet.js';
import type { AudioEffectConfig } from '../src/effects.js';
import { WebAudioOutput } from '../src/web-audio.js';

const liveContexts: AudioContext[] = [];

interface RenderFixture {
  readonly profile: string;
  readonly sampleRate: number;
  readonly frameCount: number;
  readonly effects: readonly AudioEffectConfig[];
  readonly samples: readonly { readonly frame: number; readonly value: number }[];
}

afterEach(async () => {
  await Promise.all(liveContexts.splice(0).map(async (context) => context.close()));
});

describe('Rust AudioWorklet renderer', () => {
  it('processes PCM through the Rust Wasm delay in an offline render', async () => {
    const sampleRate = 48_000;
    const delayFrames = 240;
    const context = new OfflineAudioContext(1, 1_024, sampleRate);
    const factory = await loadRustAudioWorklet(context, {
      channels: 1,
    });
    const effects = factory.createEffectChain([
      {
        id: 'proof-delay',
        type: 'delay',
        delaySeconds: delayFrames / sampleRate,
        feedback: 0,
        dry: 0,
        wet: 1,
      },
    ]);
    const input = context.createBuffer(1, 1_024, sampleRate);
    input.getChannelData(0)[0] = 1;
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(effects.inputNode);
    effects.outputNode.connect(context.destination);
    source.start();

    const rendering = context.startRendering();
    await effects.ready;
    const rendered = await rendering;
    const samples = rendered.getChannelData(0);
    expect(Math.abs(samples[0] ?? 0)).toBeLessThan(0.001);
    expect(samples[delayFrames]).toBeCloseTo(1, 4);
    effects.dispose();
  });

  it('matches the native Rust golden impulse response', async () => {
    const response = await fetch(
      new URL('../../rust/fixtures/render-v1.json', import.meta.url),
    );
    const fixture = (await response.json()) as RenderFixture;
    expect(fixture.profile).toBe('audio-core-render-v1');
    const context = new OfflineAudioContext(1, fixture.frameCount, fixture.sampleRate);
    const factory = await loadRustAudioWorklet(context, { channels: 1 });
    const effects = factory.createEffectChain(fixture.effects);
    const input = context.createBuffer(1, fixture.frameCount, fixture.sampleRate);
    input.getChannelData(0)[0] = 1;
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(effects.inputNode);
    effects.outputNode.connect(context.destination);
    source.start();

    const rendering = context.startRendering();
    await effects.ready;
    const rendered = await rendering;
    const samples = rendered.getChannelData(0);
    for (const expected of fixture.samples) {
      expect(samples[expected.frame]).toBeCloseTo(expected.value, 5);
    }
    effects.dispose();
  });

  it('keeps the audio graph alive as pass-through when DSP rejects a render quantum', async () => {
    const sampleRate = 48_000;
    const context = new OfflineAudioContext(1, 256, sampleRate);
    const events: string[] = [];
    let resolveProcessorError: (() => void) | undefined;
    const processorError = new Promise<void>((resolve) => {
      resolveProcessorError = resolve;
    });
    const factory = await loadRustAudioWorklet(context, {
      channels: 1,
      maxBlockFrames: 1,
      onEvent: (event) => {
        events.push(event.type);
        if (event.type === 'processor-error') resolveProcessorError?.();
      },
    });
    const effects = factory.createEffectChain([]);
    const input = context.createBuffer(1, 256, sampleRate);
    input.getChannelData(0)[0] = 0.75;
    const source = context.createBufferSource();
    source.buffer = input;
    source.connect(effects.inputNode);
    effects.outputNode.connect(context.destination);
    source.start();

    const rendering = context.startRendering();
    await effects.ready;
    const rendered = await rendering;
    expect(rendered.getChannelData(0)[0]).toBeCloseTo(0.75, 4);
    await processorError;
    expect(events).toContain('processor-error');
    effects.dispose();
  });

  it('plugs a loaded Rust factory into master and channel output inserts', async () => {
    const context = new AudioContext();
    liveContexts.push(context);
    const events: string[] = [];
    const factory = await loadRustAudioWorklet(context, {
      onEvent: (event) => events.push(event.type),
    });
    const output = new WebAudioOutput(
      context,
      { mode: 'multi-channel', channels: { music: {}, effects: {} } },
      {
        effectChainFactory: factory,
        masterEffects: [
          { id: 'rumble-cut', type: 'highpass', frequencyHz: 30 },
          { id: 'air-cut', type: 'lowpass', frequencyHz: 18_000 },
          { id: 'warmth', type: 'saturation', drive: 2, mix: 0.2 },
          { id: 'glue', type: 'compressor', thresholdDb: -18, ratio: 3 },
          { id: 'room', type: 'reverb', roomSize: 0.2, wet: 0.1 },
          {
            id: 'echo',
            type: 'delay',
            delaySeconds: 0.05,
            feedback: 0.2,
            wet: 0.1,
          },
        ],
        channelEffects: {
          music: [
            {
              id: 'tone',
              type: 'equalizer',
              bands: [
                {
                  type: 'lowshelf',
                  frequencyHz: 120,
                  gainDb: 2,
                },
              ],
            },
          ],
        },
      },
    );

    expect(output.masterEffectChain).toBeNull();
    expect(output.masterEffectInsert?.backend).toBe('rust-worklet');
    expect(output.channelEffectInsert('music')?.backend).toBe('rust-worklet');
    const insert = output.masterEffectInsert;
    if (insert?.backend !== 'rust-worklet') throw new Error('missing Rust effect insert');
    expect(await insert.setEnabled('glue', false)).toBe(true);
    expect(events).toContain('ready');
    output.dispose();
  });

  it('applies validated live configurations for every Rust effect category', async () => {
    const context = new AudioContext();
    liveContexts.push(context);
    const factory = await loadRustAudioWorklet(context, { channels: 1 });
    const effects = factory.createEffectChain([
      { id: 'filter', type: 'lowpass', frequencyHz: 12_000 },
      {
        id: 'eq',
        type: 'equalizer',
        bands: [{ type: 'peaking', frequencyHz: 1_000, gainDb: 0 }],
      },
      { id: 'sat', type: 'saturation', drive: 1 },
      { id: 'comp', type: 'compressor', thresholdDb: -18 },
      { id: 'delay', type: 'delay', delaySeconds: 0.05 },
      { id: 'verb', type: 'reverb', roomSize: 0.3 },
    ]);
    await effects.ready;

    const updates = [
      effects.updateEffect({ id: 'filter', type: 'lowpass', frequencyHz: 8_000, q: 1 }),
      effects.updateEffect({
        id: 'eq',
        type: 'equalizer',
        bands: [{ type: 'peaking', frequencyHz: 1_500, gainDb: 3, q: 0.8 }],
      }),
      effects.updateEffect({ id: 'sat', type: 'saturation', drive: 4, mix: 0.5 }),
      effects.updateEffect({
        id: 'comp',
        type: 'compressor',
        thresholdDb: -12,
        ratio: 3,
        mix: 0.8,
      }),
      effects.updateEffect({
        id: 'delay',
        type: 'delay',
        delaySeconds: 0.1,
        feedback: 0.4,
        wet: 0.3,
      }),
      effects.updateEffect({
        id: 'verb',
        type: 'reverb',
        roomSize: 0.7,
        damping: 0.5,
        preDelaySeconds: 0.02,
        wet: 0.3,
      }),
    ];
    await expect(Promise.all(updates)).resolves.toEqual([true, true, true, true, true, true]);
    await expect(
      effects.updateEffect({ id: 'missing', type: 'lowpass', frequencyHz: 1_000 }),
    ).resolves.toBe(false);
    expect(() =>
      effects.effect('filter')?.update({ id: 'renamed', type: 'lowpass', frequencyHz: 1_000 }),
    ).toThrow(/identity/u);
    effects.dispose();
  });
});
