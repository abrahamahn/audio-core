import { initSync, wasmMemory, WasmEffectChain } from '../wasm/audio_core_wasm.js';

const PROCESSOR_NAME = 'abrahamahn-audio-core-rust-effects';

let wasmInitialized = false;

class RustEffectsProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.failed = false;
    try {
      const processorOptions = options.processorOptions;
      if (processorOptions === undefined) throw new Error('missing Rust effect processor options');
      if (!wasmInitialized) {
        initSync({ module: processorOptions.wasmModule });
        wasmInitialized = true;
      }
      this.channels = processorOptions.channels;
      this.maxBlockFrames = processorOptions.maxBlockFrames;
      this.engine = new WasmEffectChain(sampleRate, this.channels, this.maxBlockFrames);
      configureEngine(this.engine, processorOptions.effects);
      this.memory = wasmMemory();
      this.buffer = this.createBufferView();
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return;
    }
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message?.type === 'dispose') {
        this.engine.free();
        this.failed = true;
        this.port.postMessage({ type: 'disposed' });
        return;
      }
      if (message?.type !== 'set-enabled') return;
      const updated = this.engine.set_enabled_at(message.index, message.enabled);
      this.port.postMessage({
        type: 'enabled-set',
        requestId: message.requestId,
        updated,
      });
    };
    this.port.postMessage({ type: 'ready' });
  }

  createBufferView() {
    return new Float32Array(this.memory.buffer, this.engine.buffer_ptr, this.engine.buffer_len);
  }

  process(inputs, outputs) {
    if (this.failed) return false;
    const output = outputs[0];
    if (output === undefined || output.length === 0) return true;
    const frameCount = output[0]?.length ?? 0;
    if (frameCount === 0) return true;
    if (frameCount > this.maxBlockFrames) {
      this.fail(
        `render quantum ${String(frameCount)} exceeds ${String(this.maxBlockFrames)} frames`,
      );
      return false;
    }
    if (this.buffer.buffer !== this.memory.buffer) this.buffer = this.createBufferView();

    const input = inputs[0];
    for (let channel = 0; channel < this.channels; channel += 1) {
      const source =
        input === undefined || input.length === 0
          ? undefined
          : input[Math.min(channel, input.length - 1)];
      for (let frame = 0; frame < frameCount; frame += 1) {
        this.buffer[frame * this.channels + channel] = source?.[frame] ?? 0;
      }
    }

    try {
      if (!this.engine.process(frameCount)) throw new Error('Rust DSP rejected the render quantum');
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
      return false;
    }

    for (let channel = 0; channel < output.length; channel += 1) {
      const destination = output[channel];
      if (destination === undefined) continue;
      const sourceChannel = Math.min(channel, this.channels - 1);
      for (let frame = 0; frame < frameCount; frame += 1) {
        destination[frame] = this.buffer[frame * this.channels + sourceChannel] ?? 0;
      }
    }
    return true;
  }

  fail(message) {
    this.failed = true;
    this.port.postMessage({ type: 'processor-error', message });
  }
}

registerProcessor(PROCESSOR_NAME, RustEffectsProcessor);

function configureEngine(engine, effects) {
  for (const effect of effects) {
    let configured = false;
    switch (effect.type) {
      case 'filter':
        configured = engine.add_filter(effect.enabled, effect.kind, effect.frequencyHz, effect.q);
        break;
      case 'equalizer':
        configured = engine.begin_equalizer(effect.enabled);
        for (const band of effect.bands) {
          configured &&= engine.add_equalizer_band(
            band.kind,
            band.frequencyHz,
            band.gainDb,
            band.q,
          );
        }
        configured &&= engine.finish_equalizer();
        break;
      case 'saturation':
        configured = engine.add_saturation(effect.enabled, effect.drive, effect.mix);
        break;
      case 'compressor':
        configured = engine.add_compressor(
          effect.enabled,
          effect.thresholdDb,
          effect.kneeDb,
          effect.ratio,
          effect.attackSeconds,
          effect.releaseSeconds,
          effect.makeupGainDb,
          effect.mix,
        );
        break;
      case 'delay':
        configured = engine.add_delay(
          effect.enabled,
          effect.delaySeconds,
          effect.feedback,
          effect.wet,
          effect.dry,
        );
        break;
      case 'reverb':
        configured = engine.add_reverb(
          effect.enabled,
          effect.roomSize,
          effect.damping,
          effect.preDelaySeconds,
          effect.wet,
          effect.dry,
        );
        break;
    }
    if (!configured) throw new Error(`Rust DSP rejected ${String(effect.type)} configuration`);
  }
  if (!engine.finalize()) throw new Error('Rust DSP failed to finalize the effect chain');
}
