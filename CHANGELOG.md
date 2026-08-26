# Changelog

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
