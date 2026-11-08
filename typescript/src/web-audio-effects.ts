import { validateAudioEffectChain, type AudioEffectConfig } from "./effects.js";
import { createEffectStage, type EffectStage } from "./web-audio-stages.js";

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
