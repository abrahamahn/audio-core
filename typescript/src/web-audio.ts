import {
  type AudioOutputChannelConfig,
  type AudioOutputTopology,
  type AudioVoiceOverflowPolicy,
} from './output.js';
import { clampAudioLevel, clampPan } from './policy.js';

export interface WebAudioOutputOptions {
  readonly destination?: AudioNode;
  readonly masterLevel?: number;
}

export interface WebAudioRouteOptions<Channel extends string> {
  readonly channel: Channel;
  readonly level?: number;
  readonly pan?: number;
}

export interface WebAudioBufferPlayOptions<Channel extends string>
  extends WebAudioRouteOptions<Channel> {
  readonly when?: number;
  readonly offset?: number;
  readonly duration?: number;
  readonly loop?: boolean;
  readonly playbackRate?: number;
}

export interface AudioOutputConnection<Channel extends string> {
  readonly channel: Channel;
  disconnect(): void;
}

export interface WebAudioBufferVoice<Channel extends string>
  extends AudioOutputConnection<Channel> {
  readonly source: AudioBufferSourceNode;
  stop(): void;
}

interface ResolvedChannelConfig {
  readonly level: number;
  readonly maxVoices: number;
  readonly overflow: AudioVoiceOverflowPolicy;
}

interface ActiveSlot {
  terminate(): void;
}

interface ChannelState {
  readonly input: GainNode;
  readonly config: ResolvedChannelConfig;
  readonly active: Set<ActiveSlot>;
}

/**
 * A small Web Audio output adapter with one master bus. It supports either one replaceable stream
 * channel or multiple named channels with bounded simultaneous voices.
 */
export class WebAudioOutput<Channel extends string> {
  readonly #context: AudioContext;
  readonly #master: GainNode;
  readonly #channels = new Map<Channel, ChannelState>();
  readonly #mediaSources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
  #disposed = false;

  constructor(
    context: AudioContext,
    topology: AudioOutputTopology<Channel>,
    options: WebAudioOutputOptions = {},
  ) {
    const channels = resolveChannels(topology);
    this.#context = context;
    this.#master = context.createGain();
    this.#master.gain.value = clampAudioLevel(options.masterLevel ?? 1);
    this.#master.connect(options.destination ?? context.destination);
    for (const [channel, config] of channels) this.#addChannel(channel, config);
  }

  get masterNode(): GainNode {
    return this.#master;
  }

  setMasterLevel(level: number): void {
    this.#assertActive();
    this.#master.gain.value = clampAudioLevel(level);
  }

  setChannelLevel(channel: Channel, level: number): void {
    this.#assertActive();
    this.#channel(channel).input.gain.value = clampAudioLevel(level);
  }

  activeVoiceCount(channel: Channel): number {
    return this.#channel(channel).active.size;
  }

  /** Route a caller-owned node, including a stream source, through a tracked channel slot. */
  connectNode(
    source: AudioNode,
    options: WebAudioRouteOptions<Channel>,
  ): AudioOutputConnection<Channel> | null {
    return this.#connectSource(source, options);
  }

  /** Create or reuse a MediaElement source. The caller retains play/pause and URL ownership. */
  connectMediaElement(
    element: HTMLMediaElement,
    options: WebAudioRouteOptions<Channel>,
  ): AudioOutputConnection<Channel> | null {
    this.#assertActive();
    let source = this.#mediaSources.get(element);
    if (source === undefined) {
      source = this.#context.createMediaElementSource(element);
      this.#mediaSources.set(element, source);
    }
    return this.#connectSource(source, options);
  }

  /** Create and start one buffer voice. Repeated calls can play concurrently within channel policy. */
  playBuffer(
    buffer: AudioBuffer,
    options: WebAudioBufferPlayOptions<Channel>,
  ): WebAudioBufferVoice<Channel> | null {
    this.#assertActive();
    const when = options.when ?? 0;
    const offset = options.offset;
    const duration = options.duration;
    nonNegativeFinite(when, 'when');
    if (offset !== undefined) nonNegativeFinite(offset, 'offset');
    if (duration !== undefined) nonNegativeFinite(duration, 'duration');
    if (options.playbackRate !== undefined) {
      positiveFinite(options.playbackRate, 'playbackRate');
    }

    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.loop = options.loop ?? false;
    if (options.playbackRate !== undefined) source.playbackRate.value = options.playbackRate;

    let ended = false;
    const connection = this.#connectSource(source, options, () => {
      if (ended) return;
      try {
        source.stop();
      } catch {
        // A naturally ended or previously stopped source needs no further teardown.
      }
    });
    if (connection === null) return null;
    source.onended = () => {
      ended = true;
      connection.disconnect();
    };

    try {
      if (duration !== undefined) source.start(when, offset ?? 0, duration);
      else if (offset !== undefined) source.start(when, offset);
      else source.start(when);
    } catch (error) {
      connection.disconnect();
      throw error;
    }

    return {
      channel: options.channel,
      source,
      disconnect: () => {
        connection.disconnect();
      },
      stop: () => {
        connection.disconnect();
      },
    };
  }

  stopAll(channel?: Channel): void {
    this.#assertActive();
    if (channel !== undefined) {
      terminateAll(this.#channel(channel).active);
      return;
    }
    for (const state of this.#channels.values()) terminateAll(state.active);
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const state of this.#channels.values()) {
      terminateAll(state.active);
      state.input.disconnect();
    }
    this.#master.disconnect();
    this.#disposed = true;
  }

  #addChannel(channel: Channel, config: ResolvedChannelConfig): void {
    const input = this.#context.createGain();
    input.gain.value = config.level;
    input.connect(this.#master);
    this.#channels.set(channel, {
      input,
      config,
      active: new Set(),
    });
  }

  #connectSource(
    source: AudioNode,
    options: WebAudioRouteOptions<Channel>,
    terminateSource?: () => void,
  ): AudioOutputConnection<Channel> | null {
    this.#assertActive();
    const state = this.#channel(options.channel);
    const trim = this.#context.createGain();
    trim.gain.value = clampAudioLevel(options.level ?? 1);
    const panner =
      typeof this.#context.createStereoPanner === 'function'
        ? this.#context.createStereoPanner()
        : null;
    if (panner !== null) panner.pan.value = clampPan(options.pan ?? 0);

    let admitted = false;
    let connected = false;
    const disconnect = (): void => {
      if (!admitted) return;
      admitted = false;
      state.active.delete(slot);
      terminateSource?.();
      if (connected) {
        try {
          source.disconnect(trim);
        } catch {
          // An externally disconnected source is already detached from this route.
        }
      }
      trim.disconnect();
      panner?.disconnect();
    };
    const slot: ActiveSlot = { terminate: disconnect };
    if (!this.#admit(state, slot)) return null;
    admitted = true;

    try {
      source.connect(trim);
      if (panner === null) trim.connect(state.input);
      else {
        trim.connect(panner);
        panner.connect(state.input);
      }
      connected = true;
    } catch (error) {
      disconnect();
      throw error;
    }
    return { channel: options.channel, disconnect };
  }

  #admit(state: ChannelState, slot: ActiveSlot): boolean {
    if (state.active.size >= state.config.maxVoices) {
      if (state.config.overflow === 'reject-new') return false;
      state.active.values().next().value?.terminate();
    }
    state.active.add(slot);
    return true;
  }

  #channel(channel: Channel): ChannelState {
    const state = this.#channels.get(channel);
    if (state === undefined) throw new RangeError(`unknown audio channel: ${channel}`);
    return state;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('audio output is disposed');
  }
}

function resolveChannels<Channel extends string>(
  topology: AudioOutputTopology<Channel>,
): readonly (readonly [Channel, ResolvedChannelConfig])[] {
  if (topology.mode === 'single-channel') {
    validateChannel(topology.channel);
    return [[topology.channel, resolveChannelConfig(topology.config, 1, 'stop-oldest')]];
  }
  const entries = Object.entries(topology.channels) as [Channel, AudioOutputChannelConfig][];
  if (entries.length === 0) throw new RangeError('multi-channel output requires a channel');
  return entries.map(([channel, config]) => {
    validateChannel(channel);
    return [channel, resolveChannelConfig(config, 16, 'reject-new')] as const;
  });
}

function resolveChannelConfig(
  config: AudioOutputChannelConfig | undefined,
  defaultMaxVoices: number,
  defaultOverflow: AudioVoiceOverflowPolicy,
): ResolvedChannelConfig {
  const maxVoices = config?.maxVoices ?? defaultMaxVoices;
  positiveSafeInteger(maxVoices, 'maxVoices');
  return {
    level: clampAudioLevel(config?.level ?? 1),
    maxVoices,
    overflow: config?.overflow ?? defaultOverflow,
  };
}

function validateChannel(channel: string): void {
  if (channel === '') throw new RangeError('audio channel must not be empty');
}

function terminateAll(active: Set<ActiveSlot>): void {
  for (const slot of [...active]) slot.terminate();
}

function positiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function positiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be finite and positive`);
  }
}

function nonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be finite and non-negative`);
  }
}
