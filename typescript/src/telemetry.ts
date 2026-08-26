import type { CueDropReason } from './scheduler.js';

export type AudioTelemetrySink<Event> = (event: Event) => void;

export type AudioOutputSourceKind = 'buffer' | 'node' | 'stream';

export type AudioOutputTelemetryEvent<Channel extends string> =
  | {
      readonly type: 'output.voice-started';
      readonly atMs: number;
      readonly channel: Channel;
      readonly source: AudioOutputSourceKind;
      readonly activeVoices: number;
    }
  | {
      readonly type: 'output.voice-stopped';
      readonly atMs: number;
      readonly channel: Channel;
      readonly source: AudioOutputSourceKind;
      readonly activeVoices: number;
    }
  | {
      readonly type: 'output.voice-dropped';
      readonly atMs: number;
      readonly channel: Channel;
      readonly source: AudioOutputSourceKind;
      readonly reason: 'capacity';
      readonly activeVoices: number;
    }
  | {
      readonly type: 'output.duck';
      readonly atMs: number;
      readonly channels: readonly Channel[];
    };

export type AudioAssetCacheTelemetryEvent =
  | { readonly type: 'asset.fetch-failed'; readonly url: string }
  | { readonly type: 'asset.decode-failed'; readonly url: string }
  | {
      readonly type: 'asset.cache-evicted';
      readonly cache: 'decoded' | 'encoded';
      readonly key: string;
    };

export type AudioCueRuntimeTelemetryEvent<Cue extends string> =
  | {
      readonly type: 'cue.started';
      readonly cue: Cue;
      readonly eventId?: string;
      readonly lateByMs: number;
    }
  | {
      readonly type: 'cue.dropped';
      readonly cue: Cue;
      readonly eventId?: string;
      readonly reason: CueDropReason | 'unavailable';
    }
  | {
      readonly type: 'cue.group-cancelled';
      readonly group: string;
      readonly stoppedVoices: number;
    };

/** Telemetry must never alter playback behavior. */
export function emitAudioTelemetry<Event>(
  sink: AudioTelemetrySink<Event> | undefined,
  event: Event,
): void {
  try {
    sink?.(event);
  } catch {
    // Operational telemetry is best effort and is never audio authority.
  }
}
