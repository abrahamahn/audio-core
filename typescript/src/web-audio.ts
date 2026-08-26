import {
  type AudioDuckingEnvelope,
  type AudioDuckTarget,
  type AudioLimiterConfig,
  type AudioOutputChannelConfig,
  type AudioOutputTopology,
  type AudioVoiceOverflowPolicy,
} from './output.js';
import { clampAudioLevel, clampPan } from './policy.js';

export interface WebAudioOutputOptions {
  readonly destination?: AudioNode;
  readonly masterLevel?: number;
  /** Optional final dynamics stage between MASTER and destination. */
  readonly limiter?: false | AudioLimiterConfig;
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
  baseLevel: number;
}

/**
 * A small Web Audio output adapter with one master bus. It supports either one replaceable stream
 * channel or multiple named channels with bounded simultaneous voices.
 */
export class WebAudioOutput<Channel extends string> {
  readonly #context: AudioContext;
  readonly #master: GainNode;
  readonly #limiter: DynamicsCompressorNode | null;
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
    const destination = options.destination ?? context.destination;
    if (
      options.limiter !== undefined &&
      options.limiter !== false &&
      typeof context.createDynamicsCompressor === 'function'
    ) {
      this.#limiter = context.createDynamicsCompressor();
      configureLimiter(this.#limiter, options.limiter);
      this.#master.connect(this.#limiter).connect(destination);
    } else {
      this.#limiter = null;
      this.#master.connect(destination);
    }
    for (const [channel, config] of channels) this.#addChannel(channel, config);
  }

  get masterNode(): GainNode {
    return this.#master;
  }

  get limiterNode(): DynamicsCompressorNode | null {
    return this.#limiter;
  }

  setMasterLevel(level: number): void {
    this.#assertActive();
    this.#master.gain.value = clampAudioLevel(level);
  }

  setChannelLevel(channel: Channel, level: number): void {
    this.#assertActive();
    const state = this.#channel(channel);
    state.baseLevel = clampAudioLevel(level);
    const now = this.#context.currentTime;
    state.input.gain.cancelScheduledValues(now);
    state.input.gain.setValueAtTime(state.baseLevel, now);
  }

  /** Temporarily lower selected channels, then recover each one to its configured base level. */
  duck(targets: readonly AudioDuckTarget<Channel>[], envelope: AudioDuckingEnvelope): void {
    this.#assertActive();
    const attackSeconds = milliseconds(envelope.attackMs, 'attackMs');
    const holdSeconds = milliseconds(envelope.holdMs, 'holdMs');
    const releaseSeconds = milliseconds(envelope.releaseMs, 'releaseMs');
    const now = this.#context.currentTime;
    const duckedAt = now + attackSeconds;
    const recoverAt = duckedAt + holdSeconds;
    for (const target of targets) {
      const state = this.#channel(target.channel);
      const gain = state.input.gain;
      const level = clampAudioLevel(target.level);
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(gain.value, now);
      gain.linearRampToValueAtTime(level, duckedAt);
      gain.setValueAtTime(level, recoverAt);
      gain.linearRampToValueAtTime(state.baseLevel, recoverAt + releaseSeconds);
    }
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
    this.#limiter?.disconnect();
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
      baseLevel: config.level,
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
    return [
      [
        topology.channel,
        {
          level: clampAudioLevel(topology.config?.level ?? 1),
          maxVoices: 1,
          overflow: 'stop-oldest',
        },
      ],
    ];
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
  const configuredOverflow: unknown = config?.overflow;
  const overflow = configuredOverflow ?? defaultOverflow;
  if (overflow !== 'reject-new' && overflow !== 'stop-oldest') {
    throw new RangeError('overflow must be reject-new or stop-oldest');
  }
  return {
    level: clampAudioLevel(config?.level ?? 1),
    maxVoices,
    overflow,
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

function milliseconds(value: number, name: string): number {
  nonNegativeFinite(value, name);
  return value / 1000;
}

function configureLimiter(node: DynamicsCompressorNode, config: AudioLimiterConfig): void {
  node.threshold.value = bounded(config.thresholdDb ?? -8, -100, 0, 'thresholdDb');
  node.knee.value = bounded(config.kneeDb ?? 8, 0, 40, 'kneeDb');
  node.ratio.value = bounded(config.ratio ?? 5, 1, 20, 'ratio');
  node.attack.value = bounded(config.attackSeconds ?? 0.004, 0, 1, 'attackSeconds');
  node.release.value = bounded(config.releaseSeconds ?? 0.18, 0, 1, 'releaseSeconds');
}

function bounded(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return value;
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
