import { describe, expect, it, vi } from 'vitest';

import { WebAudioOutput } from '../src/web-audio.js';

class FakeAudioParam {
  value = 0;
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
  readonly destination = new FakeAudioNode();
  readonly gains: FakeGainNode[] = [];
  readonly panners: FakeStereoPannerNode[] = [];
  readonly sources: FakeBufferSourceNode[] = [];
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
}

function audioContext(fake: FakeAudioContext): AudioContext {
  return fake as unknown as AudioContext;
}

function audioNode(fake: FakeAudioNode): AudioNode {
  return fake as unknown as AudioNode;
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
});

describe('WebAudioOutput multi-channel mode', () => {
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
