# Changelog

## 0.1.1

- Bound DSP channels, effects, sample rates, and persistent processor state before allocation.
- Sanitize non-finite PCM and preserve AudioWorklet passthrough after renderer failures.
- Execute the common filter, EQ, saturation, compressor, reverb, and delay validation contract in
  TypeScript and Rust.
- Verify native, Wasm, browser, npm, and Cargo package artifacts in CI.

## 0.1.0

- Add generic cue planning, throttling, cancellation groups, lateness policy, and bounded event
  replay deduplication.
- Add semantic cue, bus, priority, deterministic variation, and spatial-position contracts.
- Add bounded volume, level, seat, and table-position policy helpers.
- Add browser activation and visibility gates plus an injected audio-context lifecycle.
- Add bounded, injected encoded/decoded asset caching with fallback, retry, invalidation, and LRU
  eviction behavior.
- Add a Web Audio adapter with replaceable single-channel streaming and bounded multi-channel
  voices mixed through one master bus.
- Add validated final-limiter configuration and explicit channel ducking envelopes.
- Add ordered cue-sequence planning and renderer-neutral active-voice cancellation.
- Add serialized, readiness-aware media stream replacement with crossfades and visibility recovery.
- Add validated asset manifests, capability-aware variants, and decode/stream selection policy.
- Add storage-neutral preference normalization and effective-level calculation.
- Add typed, failure-isolated telemetry contracts without imposing a telemetry backend.
- Add context recovery and stream lifecycle telemetry, including soft autoplay/readiness failures.
- Add real-browser Web Audio graph coverage in Chromium and WebKit.
- Add serial per-channel and master Web Audio effect chains with high-pass, low-pass, multi-band EQ,
  saturation, compression, deterministic convolution reverb, and feedback delay.
- Add live Web Audio effect handles for bypass and parameter control.
- Add a Rust DSP crate with matching effect categories, in-place interleaved processing, native
  tests, strict linting, and `wasm32-unknown-unknown` compilation.
- Add an opt-in Rust AudioWorklet renderer with packaged Wasm, fixed-buffer processing,
  context-bound module loading, native-renderer fallback, and real Chromium/WebKit offline renders.
