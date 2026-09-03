# audio-core

`audio-core` provides deterministic semantic-audio primitives for browser and interactive
applications. It owns typed cue intent, absolute/relative timing, replay deduplication, lateness and
cancellation decisions, ordered cue sequences, renderer-neutral active-voice tracking, context
lifecycle recovery, normalized level/pan calculations, browser activation/visibility gates,
preference normalization, asset-manifest selection, bounded encoded/decoded asset caching, and an
optional Web Audio single/multi-channel output adapter with explicit stream replacement, ducking,
limiter policy, serial effect chains, and failure-isolated telemetry hooks. A matching Rust crate
provides allocation-bounded PCM processing for native and browser AudioWorklet/Wasm consumers.

- [`typescript/`](typescript/) — npm package `@abrahamahn/audio-core`
- [`rust/`](rust/) — Rust crate `abrahamahn-audio-core` (`audio_core` library)

## What it is not

`audio-core` is not a cue synthesizer, media catalog, React package, game-audio library, transport,
storage layer, or authoritative event source. It does not contain application cue names, product
asset URLs, local-storage keys, procedural sound design, or UI behavior. The optional Web Audio
adapter routes caller-owned streams and buffers; it does not choose or fetch them.

Browser applications can select native Web Audio nodes or the packaged Rust AudioWorklet/Wasm
renderer. The Rust crate processes caller-owned interleaved PCM buffers and does not open an audio
device. Applications remain responsible for loading the worklet after browser activation and may
fall back to the native renderer if that asynchronous load fails.

Applications provide:

- their semantic cue vocabulary and mapping from authoritative domain events;
- a native or third-party playback adapter when the optional Web Audio adapter is not used;
- encoded asset fetch and context-specific decode functions;
- asset URLs and fallback order;
- persistence for player audio preferences;
- a clock value when planning or consulting `CueScheduler`;
- context construction and media play/pause ownership.

## Core responsibilities

```text
domain event → application cue mapping → AudioCueRequest
                                         ↓
                         scheduler + policy + asset cache
                                         ↓
                      caller renderer → output topology
                                           ├─ single channel → MASTER
                                           └─ named channels → MASTER
                                                    ↓
                         per-channel effects → faders → master effects → limiter
```

## Important invariants

- Cue timing and throttling depend only on caller-supplied time.
- Planned cue commits remember bounded event identities so replayed events can be dropped.
- Renderer-unavailable cues do not consume event identities or throttling windows.
- Late, cancelled, duplicate, and rate-limited cues produce explicit decisions.
- Cancellation groups remain closed until explicitly reopened or reset.
- Runtime group cancellation stops and untracks every active renderer voice in that group.
- Level and pan helpers always return bounded finite values.
- Preference normalization accepts only an explicit application-owned channel vocabulary.
- Asset selection preserves declared fallback order and rejects malformed manifest metadata.
- Concurrent requests share encoded downloads and per-context decoded work.
- Encoded and per-context decoded caches have explicit, bounded capacities.
- Failed fetch/decode attempts are retryable rather than cached forever.
- Decode candidates are snapshotted before asynchronous work begins.
- Decoded assets are never shared across distinct audio contexts.
- Context creation is activation-gated and concurrent resume attempts are coalesced.
- Single-channel mode replaces the previous tracked stream/voice instead of stacking it.
- Multi-channel mode enforces explicit per-channel voice bounds under one master bus.
- Stream replacements execute in caller order and wait for readiness before replacing current audio.
- Disposing a stream controller aborts pending readiness work and tears down tracked routes.
- Telemetry sinks cannot throw into or alter the playback path.
- Ducking envelopes restore each channel to its current configured base level.
- Limiter parameters are checked against Web Audio's defined value ranges.
- Effect identities are unique within a chain and every parameter has an explicit safe range.
- High/low-pass filters, multi-band EQ, saturation, compression, reverb, and delay can be inserted
  independently on a channel or the master bus.
- Channel and master faders follow their insert effects so ducking and mute also control effect
  tails.
- Rust processes complete interleaved frames in place without allocating in the audio loop.
- Rust live updates crossfade old and new processors over 20 ms; validation and replacement
  allocation happen only on the control path.
- Rust rejects stream shapes and effect chains that exceed fixed sample-rate, channel, effect-count,
  or persistent-state memory budgets before allocating processor state.
- Non-finite input samples are sanitized before reaching stateful DSP.
- Worklet render calls reuse one fixed Wasm buffer and use numeric initialization/control calls.
- A worklet DSP failure reports an error and remains alive as a transparent pass-through path.
- Worklet and Wasm module loads are context-bound, coalesced, and retryable after failure.
- The root module performs no global fetch, decode, clock, storage, DOM, or output operation.

## Example

```ts
import {
  AudioAssetCache,
  AudioContextLifecycle,
  AudioCueRuntime,
  CueScheduler,
  gainForVolume,
  planAudioSequence,
} from '@abrahamahn/audio-core';

type Cue = 'message' | 'warning';
const scheduler = new CueScheduler<Cue>({
  defaultMinGapMs: 80,
  maxLateByMs: 500,
});
const runtime = new AudioCueRuntime(scheduler);
const receivedAtMs = performance.now();
const planned = scheduler.plan(
  {
    cue: 'warning',
    bus: 'ui',
    priority: 'important',
    eventId: 'connection:warning:42',
    delayMs: 50,
  },
  receivedAtMs,
);

const decision = scheduler.commit(planned, receivedAtMs + 50);
if (decision.status === 'ready') {
  const gain = gainForVolume(60);
  // Pass the cue and gain to an application-owned renderer.
}

const sequence = planAudioSequence(
  scheduler,
  [{ request: { cue: 'message', bus: 'ui', priority: 'normal' }, offsetMs: 0 }],
  receivedAtMs,
);
runtime.dispatch(sequence[0]!, receivedAtMs, (request) => applicationRenderer.play(request));

const lifecycle = new AudioContextLifecycle({
  createContext: () => new AudioContext(),
});
const context = lifecycle.acquire(navigator.userActivation);

const assets = new AudioAssetCache({
  fetchEncoded: async (url: string) => fetch(url).then((response) => response.arrayBuffer()),
  decode: (context: AudioContext, bytes: ArrayBuffer) => context.decodeAudioData(bytes),
});

if (context) await assets.loadFirst(context, ['/audio/message.ogg', '/audio/message.mp3']);
```

Choose one output topology for an application runtime:

```ts
import { WebAudioOutput } from '@abrahamahn/audio-core/web-audio';

// Music/radio/ambience: the next connection replaces the current one.
const musicOutput = new WebAudioOutput(context, {
  mode: 'single-channel',
  channel: 'music',
});
musicOutput.connectMediaElement(audioElement, { channel: 'music' });

// Games: independent channels mix simultaneous bounded voices into MASTER.
const gameOutput = new WebAudioOutput(
  context,
  {
    mode: 'multi-channel',
    channels: {
      music: { maxVoices: 1, overflow: 'stop-oldest' },
      effects: { maxVoices: 24, overflow: 'reject-new' },
      dialogue: { maxVoices: 2, overflow: 'stop-oldest' },
      ui: { maxVoices: 4, overflow: 'reject-new' },
    },
  },
  {
    channelEffects: {
      music: [{ id: 'music-lowpass', type: 'lowpass', frequencyHz: 16_000 }],
    },
    masterEffects: [
      { id: 'rumble-cut', type: 'highpass', frequencyHz: 30 },
      {
        id: 'master-eq',
        type: 'equalizer',
        bands: [
          { type: 'lowshelf', frequencyHz: 100, gainDb: 1.5 },
          { type: 'peaking', frequencyHz: 1_500, gainDb: -1, q: 1.2 },
          { type: 'highshelf', frequencyHz: 8_000, gainDb: 1 },
        ],
      },
      { id: 'warmth', type: 'saturation', drive: 2, mix: 0.25 },
      { id: 'glue', type: 'compressor', thresholdDb: -18, ratio: 3, mix: 0.8 },
      { id: 'room', type: 'reverb', roomSize: 0.35, damping: 0.4, wet: 0.12 },
      {
        id: 'echo',
        type: 'delay',
        delaySeconds: 0.18,
        feedback: 0.2,
        wet: 0.08,
      },
    ],
    limiter: { thresholdDb: -8, ratio: 5 },
  },
);
gameOutput.playBuffer(cardBuffer, { channel: 'effects', pan: -0.35 });
gameOutput.playBuffer(chipBuffer, { channel: 'effects', pan: 0.4 });
gameOutput.duck([{ channel: 'music', level: 0.35 }], {
  attackMs: 20,
  holdMs: 300,
  releaseMs: 180,
});

const compressor = gameOutput.masterEffectChain?.effect('glue');
if (compressor?.type === 'compressor') compressor.setMakeupGainDb(1.5);
```

`WebAudioStreamController`, available from the same `./web-audio` entrypoint, provides serialized,
readiness-aware replacement and optional crossfades for one logical music or radio stream. Media
elements and their URLs remain caller-owned.

The Web Audio graph is exercised in real headless Chromium and WebKit in addition to the pure unit
suite. The browser gate covers single-channel replacement, simultaneous named-channel voices,
capacity rejection, the complete effect set, limiter construction, ducking, telemetry delivery,
and an offline render whose delayed sample is produced inside Rust Wasm.

### Rust AudioWorklet renderer

Load the packaged worklet once for an `AudioContext`, then pass its context-bound factory to any
output that should use Rust effects. Omitting `effectChainFactory` keeps the native Web Audio path,
which is also a straightforward fallback when loading fails.

```ts
import { loadRustAudioWorklet } from '@abrahamahn/audio-core/rust-audio-worklet';
import { WebAudioOutput } from '@abrahamahn/audio-core/web-audio';

const rustEffects = await loadRustAudioWorklet(context).catch(() => undefined);
const output = new WebAudioOutput(context, topology, {
  effectChainFactory: rustEffects,
  masterEffects: [
    {
      id: 'master-eq',
      type: 'equalizer',
      bands: [
        { type: 'lowshelf', frequencyHz: 100, gainDb: 1.5 },
        { type: 'peaking', frequencyHz: 1_500, gainDb: -1, q: 1.2 },
        { type: 'highshelf', frequencyHz: 8_000, gainDb: 1 },
      ],
    },
    { id: 'glue', type: 'compressor', thresholdDb: -18, ratio: 3 },
  ],
});

await output.masterEffectInsert?.setEnabled('glue', true);
```

The Rust worklet also accepts a complete validated replacement for an existing effect. Identity,
effect type, and chain position remain stable across the update:

```ts
const chain = rustEffects?.createEffectChain([
  { id: 'tone', type: 'lowpass', frequencyHz: 18_000 },
]);
await chain?.ready;
await chain?.updateEffect({
  id: 'tone',
  type: 'lowpass',
  frequencyHz: 8_000,
  q: 0.9,
});
```

`masterEffectChain` and `channelEffectChain` expose native-node automation only. The backend-neutral
`masterEffectInsert` and `channelEffectInsert` expose backend identity and asynchronous bypass
control for both renderers.

## Rust DSP

The Rust crate owns real sample processors for the same effect categories and bounds: RBJ biquad
filters/EQ, normalized soft saturation, linked soft-knee compression, feedback delay, and damped
algorithmic reverb. The algorithms are renderer-appropriate rather than bit-identical to browser
native nodes.

```rust
use audio_core::{EffectChain, EffectConfig, FilterConfig, FilterKind};

let effects = [EffectConfig::Filter(FilterConfig {
    id: "rumble-cut".into(),
    enabled: true,
    kind: FilterKind::HighPass,
    frequency_hz: 30.0,
    q: 0.707,
})];
let mut chain = EffectChain::new(48_000.0, 2, &effects)?;
chain.process_interleaved(&mut stereo_pcm)?;
chain.update_effect(
    "rumble-cut",
    EffectConfig::Filter(FilterConfig {
        id: "rumble-cut".into(),
        enabled: true,
        kind: FilterKind::HighPass,
        frequency_hz: 60.0,
        q: 0.9,
    }),
)?;
```

## Extension points

`AudioAssetCache` accepts any object-shaped decode context and any decoded result type.
`AudioContextLifecycle` accepts a caller-owned context factory. These ports keep the core
independent of browser globals while preserving the essential rule that decoded buffers belong to
one context. `AudioCueRequest` is generic over the application cue vocabulary.

## Runtime boundary and optional adapters

The reusable `0.2` engine boundary is complete for its declared scope. It deliberately does not own
adaptive bitrate delivery, captions, a media catalog, React settings, or Babylon world positioning.
Those are integration packages or product behavior and should be added only with real consumers.
The Rust renderer is opt-in because worklet loading is asynchronous and native Web Audio remains a
useful compatibility fallback. Product-specific listening tests and performance budgets determine
which backend an application selects.

## Development

```bash
cd typescript
pnpm install --frozen-lockfile
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.127 --locked
pnpm build
pnpm build:wasm
pnpm typecheck
pnpm lint
pnpm test
pnpm exec playwright install chromium webkit
pnpm test:browser
pnpm pack --dry-run
```

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo check -p abrahamahn-audio-core --target wasm32-unknown-unknown --features wasm
```
