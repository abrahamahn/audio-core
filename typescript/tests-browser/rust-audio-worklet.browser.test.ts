import { afterEach, describe, expect, it } from 'vitest';

import { loadRustAudioWorklet } from '../src/rust-audio-worklet.js';
import { WebAudioOutput } from '../src/web-audio.js';

const liveContexts: AudioContext[] = [];

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
});
