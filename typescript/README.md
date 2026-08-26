# @abrahamahn/audio-core

The TypeScript implementation of [`audio-core`](https://github.com/abrahamahn/audio-core):
framework-neutral cue planning, replay deduplication, spatial/mix policy, context lifecycle,
bounded injected asset caching, and optional Web Audio output topology with ducking and limiting.

The root entrypoint does not create an `AudioContext`, read browser storage, fetch a fixed asset, or
define application cue names. The `./web-audio` entrypoint routes caller-owned streams and decoded
buffers through either one replaceable channel or named simultaneous channels under a master bus.

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

```ts
import { WebAudioOutput } from '@abrahamahn/audio-core/web-audio';

const output = new WebAudioOutput(context, {
  mode: 'multi-channel',
  channels: {
    music: { maxVoices: 1, overflow: 'stop-oldest' },
    effects: { maxVoices: 16, overflow: 'reject-new' },
  },
}, { limiter: { thresholdDb: -8, ratio: 5 } });

output.playBuffer(explosion, { channel: 'effects', level: 0.8, pan: 0.2 });
output.duck([{ channel: 'music', level: 0.4 }], {
  attackMs: 20,
  holdMs: 250,
  releaseMs: 180,
});
```

See the repository README for responsibilities, invariants, and integration guidance.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```
