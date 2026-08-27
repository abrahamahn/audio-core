import { describe, expect, it, vi } from "vitest";

import {
  loadRustAudioWorklet,
  RustAudioWorkletFactory,
  type AudioWorkletCapableContext,
} from "../src/rust-audio-worklet.js";

describe("Rust AudioWorklet loading policy", () => {
  it("coalesces processor registration and Wasm compilation per context", async () => {
    const addModule = vi.fn(() => Promise.resolve());
    const context = {
      audioWorklet: { addModule },
    } as unknown as AudioWorkletCapableContext;
    const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    const fetchWasm = vi.fn(() => Promise.resolve(new Response(wasm)));
    const options = {
      processorUrl: "https://audio.invalid/processor-coalesced.js",
      wasmUrl: "https://audio.invalid/audio-coalesced.wasm",
      fetchWasm,
    } as const;

    const [first, second] = await Promise.all([
      loadRustAudioWorklet(context, options),
      loadRustAudioWorklet(context, options),
    ]);
    expect(first).toBeInstanceOf(RustAudioWorkletFactory);
    expect(second).toBeInstanceOf(RustAudioWorkletFactory);
    expect(fetchWasm).toHaveBeenCalledOnce();
    expect(addModule).toHaveBeenCalledOnce();
  });

  it("reports Wasm fetch failures and permits a later retry", async () => {
    const addModule = vi.fn(() => Promise.resolve());
    const context = {
      audioWorklet: { addModule },
    } as unknown as AudioWorkletCapableContext;
    const fetchWasm = vi.fn(() =>
      Promise.resolve(
        new Response(null, { status: 503, statusText: "Unavailable" }),
      ),
    );
    const options = {
      processorUrl: "https://audio.invalid/processor.js",
      wasmUrl: "https://audio.invalid/audio.wasm",
      fetchWasm,
    } as const;

    await expect(loadRustAudioWorklet(context, options)).rejects.toThrow(
      /503/u,
    );
    await expect(loadRustAudioWorklet(context, options)).rejects.toThrow(
      /503/u,
    );
    expect(fetchWasm).toHaveBeenCalledTimes(2);
    expect(addModule).toHaveBeenCalledOnce();
  });

  it("rejects unsafe fixed worklet dimensions before node construction", () => {
    const context = { audioWorklet: {} } as AudioWorkletCapableContext;
    const module = {} as WebAssembly.Module;
    expect(
      () => new RustAudioWorkletFactory(context, module, { channels: 0 }),
    ).toThrow(/channels/u);
    expect(
      () =>
        new RustAudioWorkletFactory(context, module, { maxBlockFrames: 4_097 }),
    ).toThrow(/maxBlockFrames/u);
  });
});
