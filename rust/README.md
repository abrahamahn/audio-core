# audio-core Rust DSP

Portable, allocation-bounded sample processors for the shared `audio-core` effect contract:

- high-pass and low-pass biquad filters;
- ordered low-shelf, peaking, and high-shelf EQ bands;
- normalized soft saturation;
- linked compressor with soft knee and makeup gain;
- feedback delay;
- damped algorithmic reverb.

The crate owns DSP and validation, not device access, media decoding, browser lifecycle, or a native
audio callback. It compiles for native Rust and `wasm32-unknown-unknown`. The TypeScript package's
`./rust-audio-worklet` entrypoint provides the browser adapter and packaged Wasm artifact.

Construction fails before processor allocation when the stream shape, effect count, or estimated
persistent `f32` state exceeds the exported DSP limits. Non-finite PCM is replaced with silence
before it can enter stateful processors. `EffectChain::update_effect` replaces a complete effect
configuration while preserving identity and type, with an allocation-free 20 ms render-path
crossfade between old and new processor state.

```bash
cargo test --workspace
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo check -p abrahamahn-audio-core --target wasm32-unknown-unknown --features wasm
cargo run --release -p abrahamahn-audio-core --example render_benchmark
```
