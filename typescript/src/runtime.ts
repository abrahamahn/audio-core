import type { AudioCueRequest } from './policy.js';
import {
  type CueDropReason,
  type CuePlaybackDecision,
  CueScheduler,
  type PlannedAudioCue,
} from './scheduler.js';
import {
  emitAudioTelemetry,
  type AudioCueRuntimeTelemetryEvent,
  type AudioTelemetrySink,
} from './telemetry.js';

export type AudioCueIntent<Cue extends string> = Omit<
  AudioCueRequest<Cue>,
  'scheduledAtMs' | 'delayMs'
>;

export interface AudioCueSequenceStep<Cue extends string> {
  readonly request: AudioCueIntent<Cue>;
  readonly offsetMs: number;
}

export interface StoppableAudioVoice {
  stop(): void;
  readonly ended?: Promise<unknown>;
}

export interface TrackedAudioPlayback {
  complete(): void;
}

export interface AudioCueRuntimeOptions<Cue extends string> {
  readonly telemetry?: AudioTelemetrySink<AudioCueRuntimeTelemetryEvent<Cue>>;
}

export type AudioCueDispatchResult<Voice extends StoppableAudioVoice> =
  | Exclude<CuePlaybackDecision, { readonly status: 'ready' }>
  | {
      readonly status: 'unavailable';
      readonly dueAtMs: number;
    }
  | {
      readonly status: 'started';
      readonly dueAtMs: number;
      readonly lateByMs: number;
      readonly voice: Voice;
      readonly playback: TrackedAudioPlayback;
    };

/** Turn ordered offsets into absolute plans while preserving the caller's deterministic clock. */
export function planAudioSequence<Cue extends string>(
  scheduler: CueScheduler<Cue>,
  steps: readonly AudioCueSequenceStep<Cue>[],
  startsAtMs: number,
): readonly PlannedAudioCue<Cue>[] {
  if (!Number.isFinite(startsAtMs)) throw new RangeError('startsAtMs must be finite');
  let previousOffset = Number.NEGATIVE_INFINITY;
  return steps.map(({ request, offsetMs }) => {
    if (!Number.isFinite(offsetMs) || offsetMs < 0) {
      throw new RangeError('sequence offsetMs must be finite and non-negative');
    }
    if (offsetMs < previousOffset) {
      throw new RangeError('sequence offsets must be ordered');
    }
    previousOffset = offsetMs;
    return scheduler.plan({ ...request, scheduledAtMs: startsAtMs, delayMs: offsetMs }, startsAtMs);
  });
}

/** Couples scheduler decisions to active voice cancellation without owning a renderer. */
export class AudioCueRuntime<Cue extends string, Voice extends StoppableAudioVoice> {
  readonly #scheduler: CueScheduler<Cue>;
  readonly #telemetry: AudioTelemetrySink<AudioCueRuntimeTelemetryEvent<Cue>> | undefined;
  readonly #active = new Set<Voice>();
  readonly #groups = new Map<string, Set<Voice>>();

  constructor(scheduler: CueScheduler<Cue>, options: AudioCueRuntimeOptions<Cue> = {}) {
    this.#scheduler = scheduler;
    this.#telemetry = options.telemetry;
  }

  get scheduler(): CueScheduler<Cue> {
    return this.#scheduler;
  }

  activeVoiceCount(group?: string): number {
    return group === undefined ? this.#active.size : (this.#groups.get(group)?.size ?? 0);
  }

  dispatch(
    planned: PlannedAudioCue<Cue>,
    nowMs: number,
    start: (request: AudioCueRequest<Cue>) => Voice | null,
  ): AudioCueDispatchResult<Voice> {
    const decision = this.#scheduler.inspect(planned, nowMs);
    if (decision.status !== 'ready') {
      if (decision.status === 'drop') {
        this.#emitDrop(planned.request, decision.reason);
      }
      return decision;
    }
    const voice = start(planned.request);
    if (voice === null) {
      this.#emitDrop(planned.request, 'unavailable');
      return { status: 'unavailable', dueAtMs: decision.dueAtMs };
    }
    this.#scheduler.markPlayed(planned.request.cue, nowMs, planned.request.eventId);
    const playback = this.#track(voice, planned.request.cancellationGroup);
    emitAudioTelemetry(this.#telemetry, {
      type: 'cue.started',
      cue: planned.request.cue,
      ...(planned.request.eventId === undefined ? {} : { eventId: planned.request.eventId }),
      lateByMs: decision.lateByMs,
    });
    return {
      status: 'started',
      dueAtMs: decision.dueAtMs,
      lateByMs: decision.lateByMs,
      voice,
      playback,
    };
  }

  cancelGroup(group: string): number {
    this.#scheduler.cancelGroup(group);
    const voices = this.#groups.get(group);
    const count = voices?.size ?? 0;
    if (voices !== undefined) {
      for (const voice of [...voices]) this.#stop(voice);
    }
    emitAudioTelemetry(this.#telemetry, {
      type: 'cue.group-cancelled',
      group,
      stoppedVoices: count,
    });
    return count;
  }

  reopenGroup(group: string): void {
    this.#scheduler.reopenGroup(group);
  }

  stopAll(): number {
    const count = this.#active.size;
    for (const voice of [...this.#active]) this.#stop(voice);
    return count;
  }

  reset(): void {
    this.stopAll();
    this.#scheduler.reset();
  }

  #track(voice: Voice, group: string | undefined): TrackedAudioPlayback {
    this.#active.add(voice);
    if (group !== undefined && group !== '') {
      const voices = this.#groups.get(group) ?? new Set();
      voices.add(voice);
      this.#groups.set(group, voices);
    }
    let completed = false;
    const complete = (): void => {
      if (completed) return;
      completed = true;
      this.#remove(voice);
    };
    void voice.ended?.then(complete, complete);
    return { complete };
  }

  #stop(voice: Voice): void {
    this.#remove(voice);
    try {
      voice.stop();
    } catch {
      // A naturally ended renderer voice is already stopped.
    }
  }

  #remove(voice: Voice): void {
    if (!this.#active.delete(voice)) return;
    for (const [group, voices] of this.#groups) {
      voices.delete(voice);
      if (voices.size === 0) this.#groups.delete(group);
    }
  }

  #emitDrop(request: AudioCueRequest<Cue>, reason: CueDropReason | 'unavailable'): void {
    emitAudioTelemetry(this.#telemetry, {
      type: 'cue.dropped',
      cue: request.cue,
      ...(request.eventId === undefined ? {} : { eventId: request.eventId }),
      reason,
    });
  }
}
