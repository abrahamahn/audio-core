# audio-core

`audio-core` provides small semantic-audio primitives for browser and interactive applications.
It owns cue planning, throttling, cancellation and event deduplication, normalized level/pan
calculations, context lifecycle policy, browser activation/visibility gates, typed cue intent, and
bounded encoded/decoded asset caching through injected fetch and decode functions.

- [`typescript/`](typescript/) — npm package `@abrahamahn/audio-core`

The package is TypeScript-only because its current consumers are browser and Web Audio systems. A
Rust port would add a second source of truth without an actual native-audio consumer.

## What it is not

`audio-core` is not a Web Audio renderer, media player, asset catalog, React package, game-audio
library, transport, storage layer, or authoritative event source. It does not contain application
cue names, product asset URLs, local-storage keys, procedural synthesis, or UI behavior.

Applications provide:

- their semantic cue vocabulary and mapping from authoritative domain events;
- Web Audio, HTML media, native, or third-party playback adapters;
- encoded asset fetch and context-specific decode functions;
- asset URLs and fallback order;
- persistence for player audio preferences;
- a clock value when planning or consulting `CueScheduler`;
- context construction and playback output.

## Core responsibilities

```text
domain event → application cue mapping → AudioCueRequest
                                         ↓
                         scheduler + policy + asset cache
                                         ↓
                            application-owned renderer
```

## Important invariants

- Cue timing and throttling depend only on caller-supplied time.
- Planned cue commits remember bounded event identities so replayed events can be dropped.
- Cancellation groups remain closed until explicitly reopened or reset.
- Level and pan helpers always return bounded finite values.
- Concurrent requests share encoded downloads and per-context decoded work.
- Encoded and per-context decoded caches have explicit, bounded capacities.
- Failed fetch/decode attempts are retryable rather than cached forever.
- Decode candidates are snapshotted before asynchronous work begins.
- Decoded assets are never shared across distinct audio contexts.
- Context creation is activation-gated and concurrent resume attempts are coalesced.
- The core performs no global fetch, decode, clock, storage, DOM, or audio output operation.

## Example

```ts
import {
  AudioAssetCache,
  AudioContextLifecycle,
  CueScheduler,
  gainForVolume,
} from '@abrahamahn/audio-core';

type Cue = 'message' | 'warning';
const scheduler = new CueScheduler<Cue>({ defaultMinGapMs: 80 });

if (scheduler.canPlay('message', performance.now())) {
  scheduler.markPlayed('message', performance.now());
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

## Extension points

`AudioAssetCache` accepts any object-shaped decode context and any decoded result type.
`AudioContextLifecycle` accepts a caller-owned context factory. These ports keep the core
independent of browser globals while preserving the essential rule that decoded buffers belong to
one context. `AudioCueRequest` is generic over the application cue vocabulary.

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
