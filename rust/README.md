# audio-core Rust DSP

Portable, allocation-bounded sample processors for the shared `audio-core` effect contract:

- high-pass and low-pass biquad filters;
- ordered low-shelf, peaking, and high-shelf EQ bands;
- normalized soft saturation;
- linked compressor with soft knee and makeup gain;
- feedback delay;
- damped algorithmic reverb.

The crate owns DSP and validation, not device access, media decoding, browser lifecycle, or a native
audio callback. It compiles for native Rust and `wasm32-unknown-unknown`; a browser only uses the
Rust renderer after an explicit AudioWorklet/Wasm adapter is installed.

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo check -p abrahamahn-audio-core --target wasm32-unknown-unknown
```
