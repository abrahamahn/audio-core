import {
  validateAudioEffectChain,
  type AudioCompressorEffectConfig,
  type AudioDelayEffectConfig,
  type AudioEffectConfig,
  type AudioEqualizerEffectConfig,
  type AudioFilterEffectConfig,
  type AudioReverbEffectConfig,
  type AudioSaturationEffectConfig,
} from "./effects.js";

export interface WebAudioEffectHandleBase<
  Type extends AudioEffectConfig["type"],
> {
  readonly id: string;
  readonly type: Type;
  readonly inputNode: GainNode;
  readonly outputNode: GainNode;
  setEnabled(enabled: boolean): void;
}

export interface WebAudioFilterEffectHandle
  extends WebAudioEffectHandleBase<"highpass" | "lowpass"> {
  readonly filterNode: BiquadFilterNode;
}

export interface WebAudioEqualizerEffectHandle
  extends WebAudioEffectHandleBase<"equalizer"> {
  readonly bandNodes: readonly BiquadFilterNode[];
}

export interface WebAudioSaturationEffectHandle
  extends WebAudioEffectHandleBase<"saturation"> {
  readonly waveShaperNode: WaveShaperNode;
  readonly dryNode: GainNode;
  readonly wetNode: GainNode;
  setDrive(drive: number): void;
  setMix(mix: number): void;
}

export interface WebAudioCompressorEffectHandle
  extends WebAudioEffectHandleBase<"compressor"> {
  readonly compressorNode: DynamicsCompressorNode;
  readonly makeupNode: GainNode;
  readonly dryNode: GainNode;
  readonly wetNode: GainNode;
  setMakeupGainDb(gainDb: number): void;
  setMix(mix: number): void;
}

export interface WebAudioReverbEffectHandle
  extends WebAudioEffectHandleBase<"reverb"> {
  readonly convolverNode: ConvolverNode;
  readonly preDelayNode: DelayNode;
  readonly dryNode: GainNode;
  readonly wetNode: GainNode;
  setDry(dry: number): void;
  setWet(wet: number): void;
}

export interface WebAudioDelayEffectHandle
  extends WebAudioEffectHandleBase<"delay"> {
  readonly delayNode: DelayNode;
  readonly feedbackNode: GainNode;
  readonly dryNode: GainNode;
  readonly wetNode: GainNode;
  setDelaySeconds(seconds: number): void;
  setDry(dry: number): void;
  setFeedback(feedback: number): void;
  setWet(wet: number): void;
}

export type WebAudioEffectHandle =
  | WebAudioCompressorEffectHandle
  | WebAudioDelayEffectHandle
  | WebAudioEqualizerEffectHandle
  | WebAudioFilterEffectHandle
  | WebAudioReverbEffectHandle
  | WebAudioSaturationEffectHandle;

export interface WebAudioEffectInsert {
  readonly backend: "native" | "rust-worklet";
  readonly inputNode: AudioNode;
  readonly outputNode: AudioNode;
  readonly size: number;
  setEnabled(id: string, enabled: boolean): boolean | Promise<boolean>;
  dispose(): void;
}

export interface WebAudioEffectChainFactory {
  readonly backend: WebAudioEffectInsert["backend"];
  create(
    context: AudioContext,
    configs: readonly AudioEffectConfig[],
  ): WebAudioEffectInsert;
}

interface EffectStage {
  readonly handle: WebAudioEffectHandle;
  dispose(): void;
}

/** A serial insert chain that exposes native Web Audio nodes for live automation. */
export class WebAudioEffectChain {
  readonly backend = "native" as const;
  readonly inputNode: GainNode;
  readonly outputNode: GainNode;
  readonly #effects = new Map<string, WebAudioEffectHandle>();
  readonly #stages: EffectStage[];
  #disposed = false;

  constructor(context: AudioContext, configs: readonly AudioEffectConfig[]) {
    validateAudioEffectChain(configs);
    this.inputNode = context.createGain();
    this.outputNode = context.createGain();
    this.#stages = [];
    try {
      let tail: AudioNode = this.inputNode;
      for (const config of configs) {
        const stage = createEffectStage(context, config);
        this.#stages.push(stage);
        tail.connect(stage.handle.inputNode);
        tail = stage.handle.outputNode;
        this.#effects.set(stage.handle.id, stage.handle);
      }
      tail.connect(this.outputNode);
    } catch (error) {
      this.inputNode.disconnect();
      for (const stage of this.#stages) stage.dispose();
      this.outputNode.disconnect();
      this.#effects.clear();
      throw error;
    }
  }

  get size(): number {
    return this.#effects.size;
  }

  effect(id: string): WebAudioEffectHandle | undefined {
    return this.#effects.get(id);
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const effect = this.#effects.get(id);
    if (effect === undefined) return false;
    effect.setEnabled(enabled);
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.inputNode.disconnect();
    for (const stage of this.#stages) stage.dispose();
    this.outputNode.disconnect();
    this.#effects.clear();
    this.#disposed = true;
  }
}

function createEffectStage(
  context: AudioContext,
  config: AudioEffectConfig,
): EffectStage {
  switch (config.type) {
    case "highpass":
    case "lowpass":
      return createFilterStage(context, config);
    case "equalizer":
      return createEqualizerStage(context, config);
    case "saturation":
      return createSaturationStage(context, config);
    case "compressor":
      return createCompressorStage(context, config);
    case "reverb":
      return createReverbStage(context, config);
    case "delay":
      return createDelayStage(context, config);
  }
}

function createFilterStage(
  context: AudioContext,
  config: AudioFilterEffectConfig,
): EffectStage {
  const input = context.createGain();
  const output = context.createGain();
  const filter = context.createBiquadFilter();
  filter.type = config.type;
  filter.frequency.value = config.frequencyHz;
  filter.Q.value = config.q ?? 0.707;
  filter.connect(output);
  let enabled = config.enabled ?? true;
  const connectInput = (): void => {
    input.disconnect();
    input.connect(enabled ? filter : output);
  };
  connectInput();
  return {
    handle: {
      id: config.id,
      type: config.type,
      inputNode: input,
      outputNode: output,
      filterNode: filter,
      setEnabled: (next) => {
        enabled = next;
        connectInput();
      },
    },
    dispose: () => {
      disconnectAll(input, filter, output);
    },
  };
}

function createEqualizerStage(
  context: AudioContext,
  config: AudioEqualizerEffectConfig,
): EffectStage {
  const input = context.createGain();
  const output = context.createGain();
  const bands = config.bands.map((band) => {
    const node = context.createBiquadFilter();
    node.type = band.type;
    node.frequency.value = band.frequencyHz;
    node.gain.value = band.gainDb;
    node.Q.value = band.q ?? 0.707;
    return node;
  });
  for (let index = 0; index < bands.length - 1; index += 1) {
    const current = bands[index];
    const next = bands[index + 1];
    if (current === undefined || next === undefined)
      throw new Error("invalid equalizer chain");
    current.connect(next);
  }
  const first = bands[0];
  const last = bands.at(-1);
  if (first === undefined || last === undefined)
    throw new Error("equalizer requires a band");
  last.connect(output);
  let enabled = config.enabled ?? true;
  const connectInput = (): void => {
    input.disconnect();
    input.connect(enabled ? first : output);
  };
  connectInput();
  return {
    handle: {
      id: config.id,
      type: "equalizer",
      inputNode: input,
      outputNode: output,
      bandNodes: bands,
      setEnabled: (next) => {
        enabled = next;
        connectInput();
      },
    },
    dispose: () => {
      disconnectAll(input, ...bands, output);
    },
  };
}

function createSaturationStage(
  context: AudioContext,
  config: AudioSaturationEffectConfig,
): EffectStage {
  const input = context.createGain();
  const output = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  const shaper = context.createWaveShaper();
  shaper.oversample = config.oversample ?? "2x";
  input.connect(dry).connect(output);
  input.connect(shaper).connect(wet).connect(output);
  let enabled = config.enabled ?? true;
  let mix = config.mix ?? 1;
  const applyMix = (): void => {
    dry.gain.value = enabled ? 1 - mix : 1;
    wet.gain.value = enabled ? mix : 0;
  };
  const setDrive = (drive: number): void => {
    bounded(drive, 0, 100, "drive");
    shaper.curve = saturationCurve(drive);
  };
  setDrive(config.drive ?? 1);
  applyMix();
  return {
    handle: {
      id: config.id,
      type: "saturation",
      inputNode: input,
      outputNode: output,
      waveShaperNode: shaper,
      dryNode: dry,
      wetNode: wet,
      setDrive,
      setMix: (next) => {
        bounded(next, 0, 1, "mix");
        mix = next;
        applyMix();
      },
      setEnabled: (next) => {
        enabled = next;
        applyMix();
      },
    },
    dispose: () => {
      disconnectAll(input, dry, shaper, wet, output);
    },
  };
}

function createCompressorStage(
  context: AudioContext,
  config: AudioCompressorEffectConfig,
): EffectStage {
  const input = context.createGain();
  const output = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  const compressor = context.createDynamicsCompressor();
  const makeup = context.createGain();
  compressor.threshold.value = config.thresholdDb ?? -24;
  compressor.knee.value = config.kneeDb ?? 30;
  compressor.ratio.value = config.ratio ?? 4;
  compressor.attack.value = config.attackSeconds ?? 0.003;
  compressor.release.value = config.releaseSeconds ?? 0.25;
  input.connect(dry).connect(output);
  input.connect(compressor).connect(makeup).connect(wet).connect(output);
  let enabled = config.enabled ?? true;
  let mix = config.mix ?? 1;
  const applyMix = (): void => {
    dry.gain.value = enabled ? 1 - mix : 1;
    wet.gain.value = enabled ? mix : 0;
  };
  const setMakeupGainDb = (gainDb: number): void => {
    bounded(gainDb, -24, 24, "makeupGainDb");
    makeup.gain.value = decibelsToGain(gainDb);
  };
  setMakeupGainDb(config.makeupGainDb ?? 0);
  applyMix();
  return {
    handle: {
      id: config.id,
      type: "compressor",
      inputNode: input,
      outputNode: output,
      compressorNode: compressor,
      makeupNode: makeup,
      dryNode: dry,
      wetNode: wet,
      setMakeupGainDb,
      setMix: (next) => {
        bounded(next, 0, 1, "mix");
        mix = next;
        applyMix();
      },
      setEnabled: (next) => {
        enabled = next;
        applyMix();
      },
    },
    dispose: () => {
      disconnectAll(input, dry, compressor, makeup, wet, output);
    },
  };
}

function createReverbStage(
  context: AudioContext,
  config: AudioReverbEffectConfig,
): EffectStage {
  const input = context.createGain();
  const output = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  const preDelay = context.createDelay(1);
  const convolver = context.createConvolver();
  preDelay.delayTime.value = config.preDelaySeconds ?? 0;
  convolver.buffer = createReverbImpulse(
    context,
    config.roomSize ?? 0.5,
    config.damping ?? 0.3,
    config.seed ?? 0x4155_4449,
  );
  input.connect(dry).connect(output);
  input.connect(preDelay).connect(convolver).connect(wet).connect(output);
  let enabled = config.enabled ?? true;
  let dryLevel = config.dry ?? 1;
  let wetLevel = config.wet ?? 0.25;
  const applyMix = (): void => {
    dry.gain.value = enabled ? dryLevel : 1;
    wet.gain.value = enabled ? wetLevel : 0;
  };
  applyMix();
  return {
    handle: {
      id: config.id,
      type: "reverb",
      inputNode: input,
      outputNode: output,
      convolverNode: convolver,
      preDelayNode: preDelay,
      dryNode: dry,
      wetNode: wet,
      setDry: (next) => {
        bounded(next, 0, 1, "dry");
        dryLevel = next;
        applyMix();
      },
      setWet: (next) => {
        bounded(next, 0, 1, "wet");
        wetLevel = next;
        applyMix();
      },
      setEnabled: (next) => {
        enabled = next;
        applyMix();
      },
    },
    dispose: () => {
      disconnectAll(input, dry, preDelay, convolver, wet, output);
    },
  };
}

function createDelayStage(
  context: AudioContext,
  config: AudioDelayEffectConfig,
): EffectStage {
  const input = context.createGain();
  const output = context.createGain();
  const dry = context.createGain();
  const wet = context.createGain();
  const maximum = config.maxDelaySeconds ?? Math.max(1, config.delaySeconds);
  const delay = context.createDelay(maximum);
  const feedback = context.createGain();
  delay.delayTime.value = config.delaySeconds;
  feedback.gain.value = config.feedback ?? 0.3;
  input.connect(dry).connect(output);
  input.connect(delay).connect(wet).connect(output);
  delay.connect(feedback).connect(delay);
  let enabled = config.enabled ?? true;
  let dryLevel = config.dry ?? 1;
  let wetLevel = config.wet ?? 0.3;
  const applyMix = (): void => {
    dry.gain.value = enabled ? dryLevel : 1;
    wet.gain.value = enabled ? wetLevel : 0;
  };
  applyMix();
  return {
    handle: {
      id: config.id,
      type: "delay",
      inputNode: input,
      outputNode: output,
      delayNode: delay,
      feedbackNode: feedback,
      dryNode: dry,
      wetNode: wet,
      setDelaySeconds: (next) => {
        bounded(next, 0.001, maximum, "delaySeconds");
        delay.delayTime.value = next;
      },
      setFeedback: (next) => {
        bounded(next, 0, 0.99, "feedback");
        feedback.gain.value = next;
      },
      setDry: (next) => {
        bounded(next, 0, 1, "dry");
        dryLevel = next;
        applyMix();
      },
      setWet: (next) => {
        bounded(next, 0, 1, "wet");
        wetLevel = next;
        applyMix();
      },
      setEnabled: (next) => {
        enabled = next;
        applyMix();
      },
    },
    dispose: () => {
      disconnectAll(input, dry, delay, feedback, wet, output);
    },
  };
}

function saturationCurve(drive: number): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(2_049);
  if (drive === 0) {
    for (let index = 0; index < curve.length; index += 1) {
      curve[index] = (index / (curve.length - 1)) * 2 - 1;
    }
    return curve;
  }
  const amount = 1 + drive * 0.25;
  const normalization = Math.tanh(amount);
  for (let index = 0; index < curve.length; index += 1) {
    const input = (index / (curve.length - 1)) * 2 - 1;
    curve[index] = Math.tanh(amount * input) / normalization;
  }
  return curve;
}

function createReverbImpulse(
  context: AudioContext,
  roomSize: number,
  damping: number,
  seed: number,
): AudioBuffer {
  const durationSeconds = 0.25 + roomSize * 3.75;
  const length = Math.max(1, Math.round(context.sampleRate * durationSeconds));
  const impulse = context.createBuffer(2, length, context.sampleRate);
  let randomState = seed === 0 ? 0x6d2b_79f5 : seed >>> 0;
  const exponent = 1 + (1 - roomSize) * 6;
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    let filtered = 0;
    for (let index = 0; index < length; index += 1) {
      randomState ^= randomState << 13;
      randomState ^= randomState >>> 17;
      randomState ^= randomState << 5;
      const noise = ((randomState >>> 0) / 0x1_0000_0000) * 2 - 1;
      filtered = noise * (1 - damping) + filtered * damping;
      data[index] = filtered * Math.pow(1 - index / length, exponent);
    }
  }
  return impulse;
}

function decibelsToGain(decibels: number): number {
  return Math.pow(10, decibels / 20);
}

function disconnectAll(...nodes: AudioNode[]): void {
  for (const node of nodes) node.disconnect();
}

function bounded(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be between ${String(minimum)} and ${String(maximum)}`,
    );
  }
}
