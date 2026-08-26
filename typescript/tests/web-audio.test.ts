import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AudioOutputTopology } from '../src/output.js';
import type { AudioOutputTelemetryEvent } from '../src/telemetry.js';
import { WebAudioOutput, WebAudioStreamController } from '../src/web-audio.js';

class FakeAudioParam {
  value = 0;
  readonly cancelScheduledValues = vi.fn((time: number) => {
    void time;
    return this;
  });
  readonly setValueAtTime = vi.fn((value: number, time: number) => {
    void time;
    this.value = value;
    return this;
  });
  readonly linearRampToValueAtTime = vi.fn((value: number, time: number) => {
    void time;
    this.value = value;
    return this;
  });
}

class FakeAudioNode {
  readonly connect = vi.fn((target: FakeAudioNode) => target);
  readonly disconnect = vi.fn((target?: FakeAudioNode) => {
    void target;
  });
}

class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam();
}

class FakeStereoPannerNode extends FakeAudioNode {
  readonly pan = new FakeAudioParam();
}

class FakeDynamicsCompressorNode extends FakeAudioNode {
  readonly threshold = new FakeAudioParam();
  readonly knee = new FakeAudioParam();
  readonly ratio = new FakeAudioParam();
  readonly attack = new FakeAudioParam();
  readonly release = new FakeAudioParam();
}

class FakeBufferSourceNode extends FakeAudioNode {
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  readonly playbackRate = new FakeAudioParam();
  readonly start = vi.fn((when?: number, offset?: number, duration?: number) => {
    void when;
    void offset;
    void duration;
  });
  readonly stop = vi.fn(() => undefined);
}

class FakeAudioContext {
  currentTime = 10;
  readonly destination = new FakeAudioNode();
  readonly gains: FakeGainNode[] = [];
  readonly panners: FakeStereoPannerNode[] = [];
  readonly sources: FakeBufferSourceNode[] = [];
  readonly compressors: FakeDynamicsCompressorNode[] = [];
  readonly mediaSources = new Map<object, FakeAudioNode>();
  readonly createMediaElementSource = vi.fn((element: object) => {
    const source = new FakeAudioNode();
    this.mediaSources.set(element, source);
    return source;
  });

  createGain(): FakeGainNode {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  }

  createStereoPanner(): FakeStereoPannerNode {
    const panner = new FakeStereoPannerNode();
    this.panners.push(panner);
    return panner;
  }

  createBufferSource(): FakeBufferSourceNode {
    const source = new FakeBufferSourceNode();
    this.sources.push(source);
    return source;
  }

  createDynamicsCompressor(): FakeDynamicsCompressorNode {
    const compressor = new FakeDynamicsCompressorNode();
    this.compressors.push(compressor);
    return compressor;
  }
}

class FakeMediaElement {
  paused = true;
  readyState = 4;
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly play = vi.fn(() => {
    this.paused = false;
    return Promise.resolve();
  });
  readonly pause = vi.fn(() => {
    this.paused = true;
  });

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.#listeners.get(type) ?? []) listener();
  }
}

function audioContext(fake: FakeAudioContext): AudioContext {
  return fake as unknown as AudioContext;
}

function audioNode(fake: FakeAudioNode): AudioNode {
  return fake as unknown as AudioNode;
}

function mediaElement(fake: FakeMediaElement): HTMLMediaElement {
  return fake as unknown as HTMLMediaElement;
}

describe('WebAudioOutput single-channel mode', () => {
  it('keeps one replaceable stream route under a master bus', () => {
    const context = new FakeAudioContext();
    const output = new WebAudioOutput(audioContext(context), {
      mode: 'single-channel',
      channel: 'music',
    });
    const firstSource = new FakeAudioNode();
    const secondSource = new FakeAudioNode();

    const first = output.connectNode(audioNode(firstSource), {
      channel: 'music',
    });
    const second = output.connectNode(audioNode(secondSource), {
      channel: 'music',
      level: 0.5,
    });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(firstSource.disconnect).toHaveBeenCalledOnce();
    expect(output.activeVoiceCount('music')).toBe(1);
    expect(output.masterNode).toBe(context.gains[0]);

    output.setMasterLevel(0.75);
    output.setChannelLevel('music', 0.4);
    expect(context.gains[0]?.gain.value).toBe(0.75);
    expect(context.gains[1]?.gain.value).toBe(0.4);
  });

  it('reuses a media element source while replacing its route', () => {
    const context = new FakeAudioContext();
    const output = new WebAudioOutput(audioContext(context), {
      mode: 'single-channel',
      channel: 'music',
    });
    const element = {} as HTMLMediaElement;

    output.connectMediaElement(element, { channel: 'music' });
    output.connectMediaElement(element, { channel: 'music' });
    expect(context.createMediaElementSource).toHaveBeenCalledOnce();
    expect(output.activeVoiceCount('music')).toBe(1);
  });

  it('enforces replacement even for a malformed JavaScript topology', () => {
    const context = new FakeAudioContext();
    const topology = {
      mode: 'single-channel',
      channel: 'music',
      config: { maxVoices: 2, overflow: 'reject-new' },
    } as unknown as AudioOutputTopology<'music'>;
    const output = new WebAudioOutput(audioContext(context), topology);
    const firstSource = new FakeAudioNode();
    const secondSource = new FakeAudioNode();

    output.connectNode(audioNode(firstSource), { channel: 'music' });
    output.connectNode(audioNode(secondSource), { channel: 'music' });
    expect(firstSource.disconnect).toHaveBeenCalledOnce();
    expect(output.activeVoiceCount('music')).toBe(1);
  });
});

describe('WebAudioOutput multi-channel mode', () => {
  it('reports voice, capacity, and ducking lifecycle without owning telemetry transport', () => {
    const context = new FakeAudioContext();
    const events: AudioOutputTelemetryEvent<'effects'>[] = [];
    const output = new WebAudioOutput(
      audioContext(context),
      {
        mode: 'multi-channel',
        channels: { effects: { maxVoices: 1, overflow: 'reject-new' } },
      },
      { telemetry: (event) => events.push(event) },
    );
    const first = output.connectNode(audioNode(new FakeAudioNode()), { channel: 'effects' });
    const rejected = output.playBuffer({} as AudioBuffer, { channel: 'effects' });
    output.duck([{ channel: 'effects', level: 0.5 }], {
      attackMs: 0,
      holdMs: 10,
      releaseMs: 10,
    });
    first?.disconnect();

    expect(rejected).toBeNull();
    expect(events).toEqual([
      {
        type: 'output.voice-started',
        atMs: 10_000,
        channel: 'effects',
        source: 'node',
        activeVoices: 1,
      },
      {
        type: 'output.voice-dropped',
        atMs: 10_000,
        channel: 'effects',
        source: 'buffer',
        reason: 'capacity',
        activeVoices: 1,
      },
      { type: 'output.duck', atMs: 10_000, channels: ['effects'] },
      {
        type: 'output.voice-stopped',
        atMs: 10_000,
        channel: 'effects',
        source: 'node',
        activeVoices: 0,
      },
    ]);
  });

  it('supports a final limiter and priority-style channel ducking', () => {
    const context = new FakeAudioContext();
    const output = new WebAudioOutput(
      audioContext(context),
      {
        mode: 'multi-channel',
        channels: {
          material: { level: 0.6 },
          normal: { level: 0.82 },
          important: { level: 0.92 },
        },
      },
      { limiter: { thresholdDb: -8, ratio: 5 } },
    );

    output.duck(
      [
        { channel: 'material', level: 0.24 },
        { channel: 'normal', level: 0.58 },
      ],
      { attackMs: 18, holdMs: 402, releaseMs: 180 },
    );

    expect(output.limiterNode).toBe(context.compressors[0]);
    expect(context.compressors[0]?.threshold.value).toBe(-8);
    expect(context.compressors[0]?.ratio.value).toBe(5);
    expect(context.gains[1]?.gain.linearRampToValueAtTime).toHaveBeenNthCalledWith(1, 0.24, 10.018);
    expect(context.gains[1]?.gain.linearRampToValueAtTime).toHaveBeenNthCalledWith(2, 0.6, 10.6);
    expect(context.gains[2]?.gain.linearRampToValueAtTime).toHaveBeenNthCalledWith(1, 0.58, 10.018);
    expect(context.gains[2]?.gain.linearRampToValueAtTime).toHaveBeenNthCalledWith(2, 0.82, 10.6);
  });

  it('plays bounded simultaneous voices through named channels and one master', () => {
    const context = new FakeAudioContext();
    const output = new WebAudioOutput(audioContext(context), {
      mode: 'multi-channel',
      channels: {
        music: { maxVoices: 1, overflow: 'stop-oldest' },
        effects: { maxVoices: 2, overflow: 'reject-new' },
      },
    });
    const buffer = {} as AudioBuffer;

    const first = output.playBuffer(buffer, { channel: 'effects', pan: -0.4 });
    const second = output.playBuffer(buffer, { channel: 'effects', pan: 0.4 });
    const rejected = output.playBuffer(buffer, { channel: 'effects' });
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(rejected).toBeNull();
    expect(output.activeVoiceCount('effects')).toBe(2);
    expect(
      context.sources.slice(0, 2).every((source) => source.start.mock.calls.length === 1),
    ).toBe(true);

    first?.stop();
    expect(output.activeVoiceCount('effects')).toBe(1);
    expect(context.sources[0]?.stop).toHaveBeenCalledOnce();

    second?.source.onended?.(new Event('ended'));
    expect(output.activeVoiceCount('effects')).toBe(0);

    const firstMusic = output.playBuffer(buffer, {
      channel: 'music',
      loop: true,
    });
    const secondMusic = output.playBuffer(buffer, {
      channel: 'music',
      loop: true,
    });
    expect(firstMusic?.source.loop).toBe(true);
    expect(secondMusic).not.toBeNull();
    expect(context.sources[3]?.stop).toHaveBeenCalledOnce();
    expect(output.activeVoiceCount('music')).toBe(1);
  });

  it('stops all voices, rejects invalid topology, and tears down idempotently', () => {
    const context = new FakeAudioContext();
    expect(
      () =>
        new WebAudioOutput(audioContext(context), {
          mode: 'multi-channel',
          channels: {},
        }),
    ).toThrow(/requires a channel/u);
    expect(context.gains).toHaveLength(0);

    const invalidOverflow = {
      mode: 'multi-channel',
      channels: { effects: { overflow: 'discard-random' } },
    } as unknown as AudioOutputTopology<'effects'>;
    expect(() => new WebAudioOutput(audioContext(new FakeAudioContext()), invalidOverflow)).toThrow(
      /overflow/u,
    );
    expect(
      () =>
        new WebAudioOutput(
          audioContext(new FakeAudioContext()),
          { mode: 'single-channel', channel: 'music' },
          { limiter: { thresholdDb: -101 } },
        ),
    ).toThrow(/thresholdDb/u);

    const output = new WebAudioOutput(audioContext(context), {
      mode: 'multi-channel',
      channels: { effects: { maxVoices: 2 } },
    });
    output.playBuffer({} as AudioBuffer, { channel: 'effects' });
    output.playBuffer({} as AudioBuffer, { channel: 'effects' });
    expect(() => output.playBuffer({} as AudioBuffer, { channel: 'effects', when: -1 })).toThrow(
      /when/u,
    );
    expect(output.activeVoiceCount('effects')).toBe(2);
    output.stopAll('effects');
    expect(output.activeVoiceCount('effects')).toBe(0);
    output.dispose();
    output.dispose();
    expect(() => {
      output.setMasterLevel(1);
    }).toThrow(/disposed/u);
  });
});

describe('WebAudioStreamController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('crossfades replacements and recovers playback across visibility changes', async () => {
    vi.useFakeTimers();
    const context = new FakeAudioContext();
    const controller = new WebAudioStreamController(audioContext(context), {
      channel: 'music',
      defaultCrossfadeMs: 200,
    });
    const first = new FakeMediaElement();
    const second = new FakeMediaElement();

    await expect(controller.replace(mediaElement(first))).resolves.toBe(true);
    await expect(controller.replace(mediaElement(second))).resolves.toBe(true);
    expect(controller.currentElement).toBe(mediaElement(second));
    expect(controller.output.activeVoiceCount('music')).toBe(2);
    expect(first.pause).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(first.pause).toHaveBeenCalledOnce();
    expect(controller.output.activeVoiceCount('music')).toBe(1);

    await controller.setVisibility('hidden');
    await controller.setVisibility('hidden');
    expect(second.paused).toBe(true);
    await expect(controller.setVisibility('visible')).resolves.toBe(true);
    expect(second.paused).toBe(false);
    expect(second.play).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('serializes concurrent replacements in caller order', async () => {
    const context = new FakeAudioContext();
    const controller = new WebAudioStreamController(audioContext(context), {
      channel: 'music',
    });
    const first = new FakeMediaElement();
    const second = new FakeMediaElement();
    let finishFirst: (() => void) | undefined;
    first.play.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = () => {
            first.paused = false;
            resolve();
          };
        }),
    );

    const firstReplacement = controller.replace(mediaElement(first));
    const secondReplacement = controller.replace(mediaElement(second));
    await vi.waitFor(() => {
      expect(finishFirst).toBeTypeOf('function');
    });
    expect(second.play).not.toHaveBeenCalled();
    finishFirst?.();

    await expect(firstReplacement).resolves.toBe(true);
    await expect(secondReplacement).resolves.toBe(true);
    expect(controller.currentElement).toBe(mediaElement(second));
    expect(first.pause).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it('keeps the current stream when replacement autoplay fails', async () => {
    const context = new FakeAudioContext();
    const controller = new WebAudioStreamController(audioContext(context), {
      channel: 'music',
    });
    const current = new FakeMediaElement();
    const failed = new FakeMediaElement();
    failed.play.mockRejectedValueOnce(new Error('autoplay denied'));

    await expect(controller.replace(mediaElement(current))).resolves.toBe(true);
    await expect(controller.replace(mediaElement(failed))).resolves.toBe(false);
    expect(controller.currentElement).toBe(mediaElement(current));
    expect(controller.output.activeVoiceCount('music')).toBe(1);
    expect(current.pause).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('waits for buffering and leaves the current stream intact on timeout', async () => {
    vi.useFakeTimers();
    const context = new FakeAudioContext();
    const controller = new WebAudioStreamController(audioContext(context), {
      channel: 'music',
      readyTimeoutMs: 100,
    });
    const current = new FakeMediaElement();
    const buffering = new FakeMediaElement();
    buffering.readyState = 0;

    await controller.replace(mediaElement(current));
    const replacement = controller.replace(mediaElement(buffering));
    await vi.advanceTimersByTimeAsync(100);
    await expect(replacement).resolves.toBe(false);
    expect(controller.currentElement).toBe(mediaElement(current));
    expect(buffering.play).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('cancels a pending readiness wait when disposed', async () => {
    vi.useFakeTimers();
    const context = new FakeAudioContext();
    const controller = new WebAudioStreamController(audioContext(context), {
      channel: 'music',
      readyTimeoutMs: 10_000,
    });
    const buffering = new FakeMediaElement();
    buffering.readyState = 0;

    const replacement = controller.replace(mediaElement(buffering));
    await Promise.resolve();
    await Promise.resolve();
    controller.dispose();

    await expect(replacement).resolves.toBe(false);
    expect(buffering.play).not.toHaveBeenCalled();
  });
});
