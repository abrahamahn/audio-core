import {
  validateAudioEffectChain,
  validateAudioEffectConfig,
  type AudioEffectConfig,
} from "./effects.js";
import type {
  WebAudioEffectChainFactory,
  WebAudioEffectInsert,
} from "./web-audio-effects.js";

export const RUST_AUDIO_WORKLET_PROCESSOR_NAME =
  "abrahamahn-audio-core-rust-effects";

export type AudioWorkletCapableContext = BaseAudioContext & {
  readonly audioWorklet: AudioWorklet;
};

export interface RustAudioWorkletLoadOptions {
  readonly processorUrl?: string | URL;
  readonly wasmUrl?: string | URL;
  readonly fetchWasm?: (input: RequestInfo | URL) => Promise<Response>;
  readonly channels?: number;
  readonly maxBlockFrames?: number;
  readonly controlTimeoutMs?: number;
  readonly onEvent?: (event: RustAudioWorkletEvent) => void;
}

export type RustAudioWorkletEvent =
  | { readonly type: "disposed" }
  | { readonly type: "processor-error"; readonly message: string }
  | { readonly type: "ready" };

export interface RustAudioWorkletEffectHandle {
  readonly id: string;
  readonly type: AudioEffectConfig["type"];
  setEnabled(enabled: boolean): Promise<boolean>;
  /** Replace the complete configuration without rebuilding the worklet node. */
  update(config: AudioEffectConfig): Promise<boolean>;
}

export interface RustAudioWorkletAssetUrls {
  readonly processor: URL;
  readonly wasm: URL;
}

interface ContextLoadCache {
  readonly processors: Map<string, Promise<void>>;
  readonly wasm: Map<string, Promise<WebAssembly.Module>>;
}

const loadedModules = new WeakMap<
  AudioWorkletCapableContext,
  ContextLoadCache
>();

export function rustAudioWorkletAssetUrls(): RustAudioWorkletAssetUrls {
  return {
    processor: new URL(
      "../dist/audio-worklet/rust-effects-processor.js",
      import.meta.url,
    ),
    wasm: new URL("../dist/wasm/audio_core_wasm_bg.wasm", import.meta.url),
  };
}

export async function loadRustAudioWorklet(
  context: AudioWorkletCapableContext,
  options: RustAudioWorkletLoadOptions = {},
): Promise<RustAudioWorkletFactory> {
  const defaults = rustAudioWorkletAssetUrls();
  const processorUrl = options.processorUrl ?? defaults.processor;
  const wasmUrl = options.wasmUrl ?? defaults.wasm;
  const fetchWasm =
    options.fetchWasm ??
    (typeof globalThis.fetch === "function"
      ? globalThis.fetch.bind(globalThis)
      : undefined);
  if (typeof fetchWasm !== "function")
    throw new Error("fetch is required to load Rust audio Wasm");
  let cache = loadedModules.get(context);
  if (cache === undefined) {
    cache = { processors: new Map(), wasm: new Map() };
    loadedModules.set(context, cache);
  }
  const processorKey = processorUrl.toString();
  let processorRequest = cache.processors.get(processorKey);
  if (processorRequest === undefined) {
    processorRequest = context.audioWorklet
      .addModule(processorKey)
      .catch((error: unknown) => {
        cache.processors.delete(processorKey);
        throw error;
      });
    cache.processors.set(processorKey, processorRequest);
  }
  const wasmKey = wasmUrl.toString();
  let wasmRequest = cache.wasm.get(wasmKey);
  if (wasmRequest === undefined) {
    wasmRequest = compileWasm(wasmUrl, fetchWasm).catch((error: unknown) => {
      cache.wasm.delete(wasmKey);
      throw error;
    });
    cache.wasm.set(wasmKey, wasmRequest);
  }
  const [wasmModule] = await Promise.all([wasmRequest, processorRequest]);
  return new RustAudioWorkletFactory(context, wasmModule, options);
}

/** A context-bound, already-loaded factory suitable for `WebAudioOutput.effectChainFactory`. */
export class RustAudioWorkletFactory implements WebAudioEffectChainFactory {
  readonly backend = "rust-worklet" as const;
  readonly #context: AudioWorkletCapableContext;
  readonly #wasmModule: WebAssembly.Module;
  readonly #channels: number;
  readonly #maxBlockFrames: number;
  readonly #controlTimeoutMs: number;
  readonly #onEvent: ((event: RustAudioWorkletEvent) => void) | undefined;

  constructor(
    context: AudioWorkletCapableContext,
    wasmModule: WebAssembly.Module,
    options: RustAudioWorkletLoadOptions = {},
  ) {
    this.#context = context;
    this.#wasmModule = wasmModule;
    this.#channels = integerBetween(options.channels ?? 2, 1, 32, "channels");
    this.#maxBlockFrames = integerBetween(
      options.maxBlockFrames ?? 128,
      1,
      4_096,
      "maxBlockFrames",
    );
    this.#controlTimeoutMs = integerBetween(
      options.controlTimeoutMs ?? 2_000,
      1,
      60_000,
      "controlTimeoutMs",
    );
    this.#onEvent = options.onEvent;
  }

  create(
    context: AudioContext,
    configs: readonly AudioEffectConfig[],
  ): RustAudioWorkletEffectChain {
    if (context !== this.#context) {
      throw new Error(
        "Rust audio worklet factories are bound to the context that loaded them",
      );
    }
    return this.createEffectChain(configs);
  }

  createEffectChain(
    configs: readonly AudioEffectConfig[],
  ): RustAudioWorkletEffectChain {
    validateAudioEffectChain(configs);
    return new RustAudioWorkletEffectChain(
      this.#context,
      this.#wasmModule,
      configs,
      this.#channels,
      this.#maxBlockFrames,
      this.#controlTimeoutMs,
      this.#onEvent,
    );
  }
}

interface PendingControl {
  readonly resolve: (updated: boolean) => void;
  readonly timer: ReturnType<typeof globalThis.setTimeout>;
}

export class RustAudioWorkletEffectChain implements WebAudioEffectInsert {
  readonly backend = "rust-worklet" as const;
  readonly node: AudioWorkletNode;
  readonly inputNode: AudioWorkletNode;
  readonly outputNode: AudioWorkletNode;
  readonly ready: Promise<void>;
  readonly #effects = new Map<string, RustAudioWorkletEffectHandle>();
  readonly #pending = new Map<number, PendingControl>();
  readonly #controlTimeoutMs: number;
  readonly #onEvent: ((event: RustAudioWorkletEvent) => void) | undefined;
  #resolveReady: (() => void) | undefined;
  #rejectReady: ((reason: Error) => void) | undefined;
  #requestId = 0;
  #disposed = false;

  constructor(
    context: BaseAudioContext,
    wasmModule: WebAssembly.Module,
    configs: readonly AudioEffectConfig[],
    channels: number,
    maxBlockFrames: number,
    controlTimeoutMs: number,
    onEvent?: (event: RustAudioWorkletEvent) => void,
  ) {
    this.#controlTimeoutMs = controlTimeoutMs;
    this.#onEvent = onEvent;
    this.ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve;
      this.#rejectReady = reject;
    });
    void this.ready.catch(() => undefined);
    this.node = new AudioWorkletNode(
      context,
      RUST_AUDIO_WORKLET_PROCESSOR_NAME,
      {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [channels],
        channelCount: channels,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
        processorOptions: {
          wasmModule,
          channels,
          maxBlockFrames,
          effects: configs.map(toRustEffectConfig),
        },
      },
    );
    this.inputNode = this.node;
    this.outputNode = this.node;
    for (const [index, config] of configs.entries()) {
      this.#effects.set(config.id, {
        id: config.id,
        type: config.type,
        setEnabled: (enabled) => this.#setEnabledAt(index, enabled),
        update: (next) =>
          this.#updateEffectAt(index, config.id, config.type, next),
      });
    }
    this.node.port.onmessage = (event: MessageEvent<unknown>) => {
      this.#handleMessage(event.data);
    };
    this.node.onprocessorerror = () => {
      this.#fail("Rust audio worklet processor terminated unexpectedly");
    };
  }

  get size(): number {
    return this.#effects.size;
  }

  effect(id: string): RustAudioWorkletEffectHandle | undefined {
    return this.#effects.get(id);
  }

  setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const effect = this.#effects.get(id);
    return effect === undefined
      ? Promise.resolve(false)
      : effect.setEnabled(enabled);
  }

  /** Replace one effect's complete configuration with a click-free Rust DSP transition. */
  updateEffect(config: AudioEffectConfig): Promise<boolean> {
    const effect = this.#effects.get(config.id);
    return effect === undefined
      ? Promise.resolve(false)
      : effect.update(config);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.node.disconnect();
    this.node.port.postMessage({ type: "dispose" });
    this.#rejectReady?.(
      new Error("Rust audio worklet effect chain was disposed before ready"),
    );
    this.#clearReadySettlers();
    for (const pending of this.#pending.values()) {
      globalThis.clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.#pending.clear();
    this.#effects.clear();
  }

  #setEnabledAt(index: number, enabled: boolean): Promise<boolean> {
    return this.#sendControl({
      type: "set-enabled",
      index,
      enabled,
    });
  }

  #updateEffectAt(
    index: number,
    id: string,
    type: AudioEffectConfig["type"],
    config: AudioEffectConfig,
  ): Promise<boolean> {
    validateAudioEffectConfig(config);
    if (config.id !== id) {
      throw new RangeError(
        "live audio effect updates must preserve effect identity",
      );
    }
    if (config.type !== type) {
      throw new RangeError(
        "live audio effect updates must preserve effect type",
      );
    }
    return this.#sendControl({
      type: "update-effect",
      index,
      effect: toRustEffectConfig(config),
    });
  }

  #sendControl(message: WorkletControlRequest): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false);
    const requestId = ++this.#requestId;
    return new Promise((resolve) => {
      const timer = globalThis.setTimeout(() => {
        this.#pending.delete(requestId);
        resolve(false);
      }, this.#controlTimeoutMs);
      this.#pending.set(requestId, { resolve, timer });
      this.node.port.postMessage({ ...message, requestId });
    });
  }

  #handleMessage(value: unknown): void {
    if (!isWorkletMessage(value)) return;
    if (value.type === "ready") {
      this.#resolveReady?.();
      this.#clearReadySettlers();
      this.#emit({ type: "ready" });
      return;
    }
    if (value.type === "processor-error") {
      this.#fail(value.message);
      return;
    }
    if (value.type === "disposed") {
      this.node.port.close();
      this.#emit({ type: "disposed" });
      return;
    }
    const pending = this.#pending.get(value.requestId);
    if (pending === undefined) return;
    globalThis.clearTimeout(pending.timer);
    this.#pending.delete(value.requestId);
    pending.resolve(value.updated);
  }

  #fail(message: string): void {
    const error = new Error(message);
    this.#rejectReady?.(error);
    this.#clearReadySettlers();
    for (const pending of this.#pending.values()) {
      globalThis.clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.#pending.clear();
    this.#emit({ type: "processor-error", message });
  }

  #clearReadySettlers(): void {
    this.#resolveReady = undefined;
    this.#rejectReady = undefined;
  }

  #emit(event: RustAudioWorkletEvent): void {
    try {
      this.#onEvent?.(event);
    } catch {
      // Observability cannot alter the audio path.
    }
  }
}

type WorkletMessage =
  | { readonly type: "disposed" }
  | {
      readonly type: "control-set";
      readonly requestId: number;
      readonly updated: boolean;
    }
  | { readonly type: "processor-error"; readonly message: string }
  | { readonly type: "ready" };

function isWorkletMessage(value: unknown): value is WorkletMessage {
  if (typeof value !== "object" || value === null || !("type" in value))
    return false;
  const type = value.type;
  if (type === "disposed" || type === "ready") return true;
  if (type === "processor-error")
    return "message" in value && typeof value.message === "string";
  return (
    type === "control-set" &&
    "requestId" in value &&
    Number.isSafeInteger(value.requestId) &&
    "updated" in value &&
    typeof value.updated === "boolean"
  );
}

type WorkletControlRequest =
  | {
      readonly type: "set-enabled";
      readonly index: number;
      readonly enabled: boolean;
    }
  | {
      readonly type: "update-effect";
      readonly index: number;
      readonly effect: object;
    };

async function compileWasm(
  url: string | URL,
  fetchWasm: (input: RequestInfo | URL) => Promise<Response>,
): Promise<WebAssembly.Module> {
  const response = await fetchWasm(url);
  if (!response.ok) {
    throw new Error(
      `failed to fetch Rust audio Wasm: ${String(response.status)}`,
    );
  }
  return WebAssembly.compile(await response.arrayBuffer());
}

function toRustEffectConfig(effect: AudioEffectConfig): object {
  const enabled = effect.enabled ?? true;
  switch (effect.type) {
    case "highpass":
    case "lowpass":
      return {
        type: "filter",
        enabled,
        kind: effect.type === "highpass" ? 0 : 1,
        frequencyHz: effect.frequencyHz,
        q: effect.q ?? 0.707,
      };
    case "equalizer":
      return {
        type: "equalizer",
        enabled,
        bands: effect.bands.map((band) => ({
          kind: band.type === "lowshelf" ? 0 : band.type === "peaking" ? 1 : 2,
          frequencyHz: band.frequencyHz,
          gainDb: band.gainDb,
          q: band.q ?? 0.707,
        })),
      };
    case "saturation":
      return {
        type: "saturation",
        enabled,
        drive: effect.drive ?? 1,
        mix: effect.mix ?? 1,
      };
    case "compressor":
      return {
        type: "compressor",
        enabled,
        thresholdDb: effect.thresholdDb ?? -24,
        kneeDb: effect.kneeDb ?? 30,
        ratio: effect.ratio ?? 4,
        attackSeconds: effect.attackSeconds ?? 0.003,
        releaseSeconds: effect.releaseSeconds ?? 0.25,
        makeupGainDb: effect.makeupGainDb ?? 0,
        mix: effect.mix ?? 1,
      };
    case "delay":
      return {
        type: "delay",
        enabled,
        delaySeconds: effect.delaySeconds,
        feedback: effect.feedback ?? 0.3,
        wet: effect.wet ?? 0.3,
        dry: effect.dry ?? 1,
      };
    case "reverb":
      return {
        type: "reverb",
        enabled,
        roomSize: effect.roomSize ?? 0.5,
        damping: effect.damping ?? 0.3,
        preDelaySeconds: effect.preDelaySeconds ?? 0,
        wet: effect.wet ?? 0.25,
        dry: effect.dry ?? 1,
      };
  }
}

function integerBetween(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${name} must be an integer between ${String(minimum)} and ${String(maximum)}`,
    );
  }
  return value;
}
