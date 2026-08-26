# @abrahamahn/audio-core

The TypeScript implementation of [`audio-core`](https://github.com/abrahamahn/audio-core):
framework-neutral cue planning, replay deduplication, spatial/mix policy, context lifecycle, and
bounded injected asset caching.

The package does not create an `AudioContext`, read browser storage, fetch a fixed asset, define
application cue names, or produce audio output.

```ts
import {
  AudioAssetCache,
  AudioContextLifecycle,
  CueScheduler,
  clampPan,
} from '@abrahamahn/audio-core';

const scheduler = new CueScheduler<'notification'>({ defaultMinGapMs: 100 });
const planned = scheduler.plan(
  { cue: 'notification', bus: 'ui', priority: 'normal', eventId: 'message:42' },
  1_000,
);

const lifecycle = new AudioContextLifecycle({ createContext: () => new AudioContext() });

const assets = new AudioAssetCache({
  fetchEncoded: async (url: string) => fetch(url).then((response) => response.arrayBuffer()),
  decode: (context: AudioContext, bytes: ArrayBuffer) => context.decodeAudioData(bytes),
});

console.log(scheduler.commit(planned, 1_000), lifecycle, clampPan(1.4), assets);
```

See the repository README for responsibilities, invariants, and integration guidance.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```
