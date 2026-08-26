# audio-core

`audio-core` provides deterministic semantic-audio primitives for browser and interactive
applications. It owns typed cue intent, absolute/relative timing, replay deduplication, lateness and
cancellation decisions, context lifecycle recovery, normalized level/pan calculations, browser
activation/visibility gates, bounded encoded/decoded asset caching, and an optional Web Audio
single/multi-channel output adapter with explicit ducking and limiter policy.

- [`typescript/`](typescript/) — npm package `@abrahamahn/audio-core`

The package is TypeScript-only because its current consumers are browser and Web Audio systems. A
Rust port would add a second source of truth without an actual native-audio consumer.

## What it is not

`audio-core` is not a cue synthesizer, media catalog, React package, game-audio library, transport,
storage layer, or authoritative event source. It does not contain application cue names, product
asset URLs, local-storage keys, procedural sound design, or UI behavior. The optional Web Audio
adapter routes caller-owned streams and buffers; it does not choose or fetch them.

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
```

## Important invariants

- Cue timing and throttling depend only on caller-supplied time.
- Planned cue commits remember bounded event identities so replayed events can be dropped.
- Late, cancelled, duplicate, and rate-limited cues produce explicit decisions.
- Cancellation groups remain closed until explicitly reopened or reset.
- Level and pan helpers always return bounded finite values.
- Concurrent requests share encoded downloads and per-context decoded work.
- Encoded and per-context decoded caches have explicit, bounded capacities.
- Failed fetch/decode attempts are retryable rather than cached forever.
- Decode candidates are snapshotted before asynchronous work begins.
- Decoded assets are never shared across distinct audio contexts.
- Context creation is activation-gated and concurrent resume attempts are coalesced.
- Single-channel mode replaces the previous tracked stream/voice instead of stacking it.
- Multi-channel mode enforces explicit per-channel voice bounds under one master bus.
- Ducking envelopes restore each channel to its current configured base level.
- Limiter parameters are checked against Web Audio's defined value ranges.
- The root module performs no global fetch, decode, clock, storage, DOM, or output operation.

## Example

```ts
import {
  AudioAssetCache,
  AudioContextLifecycle,
  CueScheduler,
  gainForVolume,
} from '@abrahamahn/audio-core';

type Cue = 'message' | 'warning';
const scheduler = new CueScheduler<Cue>({ defaultMinGapMs: 80, maxLateByMs: 500 });
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
const gameOutput = new WebAudioOutput(context, {
  mode: 'multi-channel',
  channels: {
    music: { maxVoices: 1, overflow: 'stop-oldest' },
    effects: { maxVoices: 24, overflow: 'reject-new' },
    dialogue: { maxVoices: 2, overflow: 'stop-oldest' },
    ui: { maxVoices: 4, overflow: 'reject-new' },
  },
}, { limiter: { thresholdDb: -8, ratio: 5 } });
gameOutput.playBuffer(cardBuffer, { channel: 'effects', pan: -0.35 });
gameOutput.playBuffer(chipBuffer, { channel: 'effects', pan: 0.4 });
gameOutput.duck([{ channel: 'music', level: 0.35 }], {
  attackMs: 20,
  holdMs: 300,
  releaseMs: 180,
});
```

## Extension points

`AudioAssetCache` accepts any object-shaped decode context and any decoded result type.
`AudioContextLifecycle` accepts a caller-owned context factory. These ports keep the core
independent of browser globals while preserving the essential rule that decoded buffers belong to
one context. `AudioCueRequest` is generic over the application cue vocabulary.

## Deliberate next-stage work

The initial extraction does not claim to be the complete future audio engine. Asset-manifest
selection, adaptive streaming policy, telemetry, and an optional Babylon spatial adapter should be
added only with real consumers and browser parity tests. They should not be simulated in Rust or
hidden inside product-specific synthesis.

## Development

```bash
cd typescript
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm pack --dry-run
```
