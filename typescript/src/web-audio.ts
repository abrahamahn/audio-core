import { validateAudioEffectChain, type AudioEffectConfig } from "./effects.js";
import {
  type AudioDuckingEnvelope,
  type AudioDuckTarget,
  type AudioLimiterConfig,
  type AudioOutputChannelConfig,
  type AudioOutputTopology,
  type AudioVoiceOverflowPolicy,
} from "./output.js";
import { clampAudioLevel, clampPan } from "./policy.js";
import {
  emitAudioTelemetry,
  type AudioOutputSourceKind,
  type AudioOutputTelemetryEvent,
  type AudioTelemetrySink,
} from "./telemetry.js";
import {
  bounded,
  nonNegativeFinite,
  positiveFinite,
  positiveSafeInteger,
} from "./validation.js";
import {
  WebAudioEffectChain,
  type WebAudioEffectChainFactory,
  type WebAudioEffectInsert,
} from "./web-audio-effects.js";

export interface WebAudioOutputOptions<Channel extends string = string> {
  readonly destination?: AudioNode;
  readonly masterLevel?: number;
  /** Optional final dynamics stage between MASTER and destination. */
  readonly limiter?: false | AudioLimiterConfig;
  /** Serial insert effects placed on the master bus before its fader and final limiter. */
  readonly masterEffects?: readonly AudioEffectConfig[];
  /** Serial insert effects placed before an individual channel fader. */
  readonly channelEffects?: Partial<
    Readonly<Record<Channel, readonly AudioEffectConfig[]>>
  >;
  /** Optional preloaded renderer for every configured effect chain. Native Web Audio is default. */
  readonly effectChainFactory?: WebAudioEffectChainFactory | undefined;
  readonly telemetry?: AudioTelemetrySink<AudioOutputTelemetryEvent<Channel>>;
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
  setLevel(level: number, rampMs?: number): void;
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
  /** Post-effect channel fader used by level and ducking policy. */
  readonly input: GainNode;
  /** Pre-effect destination for newly routed voices. */
  readonly route: AudioNode;
  readonly effects: WebAudioEffectInsert | null;
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
  readonly #masterEffects: WebAudioEffectInsert | null;
  readonly #channelEffectConfigs:
    | Partial<Readonly<Record<Channel, readonly AudioEffectConfig[]>>>
    | undefined;
  readonly #effectChainFactory: WebAudioEffectChainFactory | undefined;
  readonly #telemetry:
    | AudioTelemetrySink<AudioOutputTelemetryEvent<Channel>>
    | undefined;
  readonly #channels = new Map<Channel, ChannelState>();
  readonly #mediaSources = new WeakMap<
    HTMLMediaElement,
    MediaElementAudioSourceNode
  >();
  #disposed = false;

  constructor(
    context: AudioContext,
    topology: AudioOutputTopology<Channel>,
    options: WebAudioOutputOptions<Channel> = {},
  ) {
    const channels = resolveChannels(topology);
    validateEffectOptions(channels, options);
    this.#context = context;
    this.#telemetry = options.telemetry;
    this.#channelEffectConfigs = options.channelEffects;
    this.#effectChainFactory = options.effectChainFactory;
    this.#master = context.createGain();
    this.#master.gain.value = clampAudioLevel(options.masterLevel ?? 1);
    const destination = options.destination ?? context.destination;
    this.#masterEffects = createOptionalEffectChain(
      context,
      options.masterEffects,
      options.effectChainFactory,
    );
    if (this.#masterEffects !== null)
      this.#masterEffects.outputNode.connect(this.#master);
    if (
      options.limiter !== undefined &&
      options.limiter !== false &&
      typeof context.createDynamicsCompressor === "function"
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

  get masterEffectChain(): WebAudioEffectChain | null {
    return this.#masterEffects instanceof WebAudioEffectChain
      ? this.#masterEffects
      : null;
  }

  /** The active effect insert, including a Rust worklet insert when configured. */
  get masterEffectInsert(): WebAudioEffectInsert | null {
    return this.#masterEffects;
  }

  channelEffectChain(channel: Channel): WebAudioEffectChain | null {
    const effects = this.#channel(channel).effects;
    return effects instanceof WebAudioEffectChain ? effects : null;
  }

  /** The channel effect insert, including a Rust worklet insert when configured. */
  channelEffectInsert(channel: Channel): WebAudioEffectInsert | null {
    return this.#channel(channel).effects;
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
  duck(
    targets: readonly AudioDuckTarget<Channel>[],
    envelope: AudioDuckingEnvelope,
  ): void {
    this.#assertActive();
    const attackSeconds = milliseconds(envelope.attackMs, "attackMs");
    const holdSeconds = milliseconds(envelope.holdMs, "holdMs");
    const releaseSeconds = milliseconds(envelope.releaseMs, "releaseMs");
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
    emitAudioTelemetry(this.#telemetry, {
      type: "output.duck",
      atMs: now * 1_000,
      channels: targets.map(({ channel }) => channel),
    });
  }

  activeVoiceCount(channel: Channel): number {
    return this.#channel(channel).active.size;
  }

  /** Route a caller-owned node, including a stream source, through a tracked channel slot. */
  connectNode(
    source: AudioNode,
    options: WebAudioRouteOptions<Channel>,
  ): AudioOutputConnection<Channel> | null {
    return this.#connectSource(source, options, "node");
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
    return this.#connectSource(source, options, "stream");
  }

  /** Create and start one buffer voice. Repeated calls can play concurrently within channel policy. */
  playBuffer(
    buffer: AudioBuffer,
    options: WebAudioBufferPlayOptions<Channel>,
  ): WebAudioBufferVoice<Channel> | null {
    this.#assertActive();
    const when = nonNegativeFinite(options.when ?? 0, "when");
    const offset = options.offset;
    const duration = options.duration;
    if (offset !== undefined) nonNegativeFinite(offset, "offset");
    if (duration !== undefined) nonNegativeFinite(duration, "duration");
    if (options.playbackRate !== undefined) {
      positiveFinite(options.playbackRate, "playbackRate");
    }

    const source = this.#context.createBufferSource();
    source.buffer = buffer;
    source.loop = options.loop ?? false;
    if (options.playbackRate !== undefined)
      source.playbackRate.value = options.playbackRate;

    let ended = false;
    const connection = this.#connectSource(source, options, "buffer", () => {
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
      setLevel: (level, rampMs) => {
        connection.setLevel(level, rampMs);
      },
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
      state.effects?.dispose();
    }
    this.#masterEffects?.dispose();
    this.#limiter?.disconnect();
    this.#master.disconnect();
    this.#disposed = true;
  }

  #addChannel(channel: Channel, config: ResolvedChannelConfig): void {
    const input = this.#context.createGain();
    input.gain.value = config.level;
    const effects = createOptionalEffectChain(
      this.#context,
      this.#channelEffectConfigs?.[channel],
      this.#effectChainFactory,
    );
    const masterInput = this.#masterEffects?.inputNode ?? this.#master;
    if (effects === null) input.connect(masterInput);
    else {
      effects.outputNode.connect(input);
      input.connect(masterInput);
    }
    this.#channels.set(channel, {
      input,
      route: effects?.inputNode ?? input,
      effects,
      config,
      active: new Set(),
      baseLevel: config.level,
    });
  }

  #connectSource(
    source: AudioNode,
    options: WebAudioRouteOptions<Channel>,
    sourceKind: AudioOutputSourceKind,
    terminateSource?: () => void,
  ): AudioOutputConnection<Channel> | null {
    this.#assertActive();
    const state = this.#channel(options.channel);
    const trim = this.#context.createGain();
    trim.gain.value = clampAudioLevel(options.level ?? 1);
    const panner =
      typeof this.#context.createStereoPanner === "function"
        ? this.#context.createStereoPanner()
        : null;
    if (panner !== null) panner.pan.value = clampPan(options.pan ?? 0);

    const setLevel = (level: number, rampMs = 0): void => {
      const rampSeconds = milliseconds(rampMs, "rampMs");
      const now = this.#context.currentTime;
      trim.gain.cancelScheduledValues(now);
      trim.gain.setValueAtTime(trim.gain.value, now);
      if (rampSeconds === 0)
        trim.gain.setValueAtTime(clampAudioLevel(level), now);
      else
        trim.gain.linearRampToValueAtTime(
          clampAudioLevel(level),
          now + rampSeconds,
        );
    };

    let admitted = false;
    let connected = false;
    let started = false;
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
      if (started) {
        started = false;
        emitAudioTelemetry(this.#telemetry, {
          type: "output.voice-stopped",
          atMs: this.#context.currentTime * 1_000,
          channel: options.channel,
          source: sourceKind,
          activeVoices: state.active.size,
        });
      }
    };
    const slot: ActiveSlot = { terminate: disconnect };
    if (!this.#admit(state, slot)) {
      emitAudioTelemetry(this.#telemetry, {
        type: "output.voice-dropped",
        atMs: this.#context.currentTime * 1_000,
        channel: options.channel,
        source: sourceKind,
        reason: "capacity",
        activeVoices: state.active.size,
      });
      return null;
    }
    admitted = true;

    try {
      source.connect(trim);
      if (panner === null) trim.connect(state.route);
      else {
        trim.connect(panner);
        panner.connect(state.route);
      }
      connected = true;
      started = true;
      emitAudioTelemetry(this.#telemetry, {
        type: "output.voice-started",
        atMs: this.#context.currentTime * 1_000,
        channel: options.channel,
        source: sourceKind,
        activeVoices: state.active.size,
      });
    } catch (error) {
      disconnect();
      throw error;
    }
    return { channel: options.channel, setLevel, disconnect };
  }

  #admit(state: ChannelState, slot: ActiveSlot): boolean {
    if (state.active.size >= state.config.maxVoices) {
      if (state.config.overflow === "reject-new") return false;
      state.active.values().next().value?.terminate();
    }
    state.active.add(slot);
    return true;
  }

  #channel(channel: Channel): ChannelState {
    const state = this.#channels.get(channel);
    if (state === undefined)
      throw new RangeError(`unknown audio channel: ${channel}`);
    return state;
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("audio output is disposed");
  }
}

function createOptionalEffectChain(
  context: AudioContext,
  effects: readonly AudioEffectConfig[] | undefined,
  factory: WebAudioEffectChainFactory | undefined,
): WebAudioEffectInsert | null {
  if (effects === undefined || effects.length === 0) return null;
  return (
    factory?.create(context, effects) ??
    new WebAudioEffectChain(context, effects)
  );
}

function validateEffectOptions<Channel extends string>(
  channels: readonly (readonly [Channel, ResolvedChannelConfig])[],
  options: WebAudioOutputOptions<Channel>,
): void {
  validateAudioEffectChain(options.masterEffects ?? []);
  const knownChannels = new Set(channels.map(([channel]) => channel));
  for (const [channel, effects] of Object.entries(
    options.channelEffects ?? {},
  )) {
    if (!knownChannels.has(channel as Channel)) {
      throw new RangeError(
        `effects configured for unknown audio channel: ${channel}`,
      );
    }
    validateAudioEffectChain(effects as readonly AudioEffectConfig[]);
  }
}

function resolveChannels<Channel extends string>(
  topology: AudioOutputTopology<Channel>,
): readonly (readonly [Channel, ResolvedChannelConfig])[] {
  if (topology.mode === "single-channel") {
    validateChannel(topology.channel);
    return [
      [
        topology.channel,
        {
          level: clampAudioLevel(topology.config?.level ?? 1),
          maxVoices: 1,
          overflow: "stop-oldest",
        },
      ],
    ];
  }
  const entries = Object.entries(topology.channels) as [
    Channel,
    AudioOutputChannelConfig,
  ][];
  if (entries.length === 0)
    throw new RangeError("multi-channel output requires a channel");
  return entries.map(([channel, config]) => {
    validateChannel(channel);
    return [channel, resolveChannelConfig(config, 16, "reject-new")] as const;
  });
}

function resolveChannelConfig(
  config: AudioOutputChannelConfig | undefined,
  defaultMaxVoices: number,
  defaultOverflow: AudioVoiceOverflowPolicy,
): ResolvedChannelConfig {
  const maxVoices = positiveSafeInteger(
    config?.maxVoices ?? defaultMaxVoices,
    "maxVoices",
  );
  const configuredOverflow: unknown = config?.overflow;
  const overflow = configuredOverflow ?? defaultOverflow;
  if (overflow !== "reject-new" && overflow !== "stop-oldest") {
    throw new RangeError("overflow must be reject-new or stop-oldest");
  }
  return {
    level: clampAudioLevel(config?.level ?? 1),
    maxVoices,
    overflow,
  };
}

function validateChannel(channel: string): void {
  if (channel === "") throw new RangeError("audio channel must not be empty");
}

function terminateAll(active: Set<ActiveSlot>): void {
  for (const slot of [...active]) slot.terminate();
}

function milliseconds(value: number, name: string): number {
  return nonNegativeFinite(value, name) / 1000;
}

function configureLimiter(
  node: DynamicsCompressorNode,
  config: AudioLimiterConfig,
): void {
  node.threshold.value = bounded(
    config.thresholdDb ?? -8,
    -100,
    0,
    "thresholdDb",
  );
  node.knee.value = bounded(config.kneeDb ?? 8, 0, 40, "kneeDb");
  node.ratio.value = bounded(config.ratio ?? 5, 1, 20, "ratio");
  node.attack.value = bounded(
    config.attackSeconds ?? 0.004,
    0,
    1,
    "attackSeconds",
  );
  node.release.value = bounded(
    config.releaseSeconds ?? 0.18,
    0,
    1,
    "releaseSeconds",
  );
}
