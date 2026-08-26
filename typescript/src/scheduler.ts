import type { AudioCueRequest } from './policy.js';

export interface CueSchedulerOptions<Cue extends string> {
  readonly defaultMinGapMs?: number;
  readonly minGapForCue?: (cue: Cue) => number | undefined;
  /** Maximum lateness before a planned cue is dropped. Defaults to no limit. */
  readonly maxLateByMs?: number;
  /** Number of committed event IDs retained for replay deduplication. Defaults to 1,024. */
  readonly maxRememberedEventIds?: number;
}

export interface PlannedAudioCue<Cue extends string> {
  readonly request: AudioCueRequest<Cue>;
  readonly dueAtMs: number;
}

export type CueDropReason = 'cancelled' | 'duplicate' | 'late' | 'rate-limited';

export type CuePlaybackDecision =
  | { readonly status: 'ready'; readonly dueAtMs: number; readonly lateByMs: number }
  | { readonly status: 'defer'; readonly dueAtMs: number; readonly waitMs: number }
  | { readonly status: 'drop'; readonly dueAtMs: number; readonly reason: CueDropReason };

export class CueScheduler<Cue extends string> {
  readonly #defaultMinGapMs: number;
  readonly #minGapForCue: ((cue: Cue) => number | undefined) | undefined;
  readonly #maxLateByMs: number;
  readonly #maxRememberedEventIds: number;
  readonly #lastPlayed = new Map<Cue, number>();
  readonly #cancelledGroups = new Set<string>();
  readonly #rememberedEventIds = new Set<string>();

  constructor(options: CueSchedulerOptions<Cue> = {}) {
    this.#defaultMinGapMs = options.defaultMinGapMs ?? 0;
    if (!Number.isFinite(this.#defaultMinGapMs) || this.#defaultMinGapMs < 0) {
      throw new RangeError('defaultMinGapMs must be finite and non-negative');
    }
    this.#minGapForCue = options.minGapForCue;
    this.#maxLateByMs = options.maxLateByMs ?? Number.POSITIVE_INFINITY;
    if (Number.isNaN(this.#maxLateByMs) || this.#maxLateByMs < 0) {
      throw new RangeError('maxLateByMs must be non-negative');
    }
    this.#maxRememberedEventIds = options.maxRememberedEventIds ?? 1024;
    if (!Number.isSafeInteger(this.#maxRememberedEventIds) || this.#maxRememberedEventIds <= 0) {
      throw new RangeError('maxRememberedEventIds must be a positive safe integer');
    }
  }

  canPlay(cue: Cue, nowMs: number, cancellationGroup?: string): boolean {
    if (!Number.isFinite(nowMs)) throw new RangeError('nowMs must be finite');
    if (cancellationGroup !== undefined && this.#cancelledGroups.has(cancellationGroup)) {
      return false;
    }
    const configuredGap = this.#minGapForCue?.(cue) ?? this.#defaultMinGapMs;
    if (!Number.isFinite(configuredGap) || configuredGap < 0) {
      throw new RangeError('cue minimum gap must be finite and non-negative');
    }
    return nowMs - (this.#lastPlayed.get(cue) ?? Number.NEGATIVE_INFINITY) >= configuredGap;
  }

  markPlayed(cue: Cue, nowMs: number, eventId?: string): void {
    if (!Number.isFinite(nowMs)) throw new RangeError('nowMs must be finite');
    this.#lastPlayed.set(cue, nowMs);
    if (eventId !== undefined && eventId !== '') this.#rememberEvent(eventId);
  }

  plan(request: AudioCueRequest<Cue>, receivedAtMs: number): PlannedAudioCue<Cue> {
    finiteTime(receivedAtMs, 'receivedAtMs');
    const scheduledAtMs = request.scheduledAtMs ?? receivedAtMs;
    finiteTime(scheduledAtMs, 'scheduledAtMs');
    const delayMs = request.delayMs ?? 0;
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError('delayMs must be finite and non-negative');
    }
    const dueAtMs = scheduledAtMs + delayMs;
    finiteTime(dueAtMs, 'dueAtMs');
    return { request, dueAtMs };
  }

  inspect(planned: PlannedAudioCue<Cue>, nowMs: number): CuePlaybackDecision {
    finiteTime(nowMs, 'nowMs');
    finiteTime(planned.dueAtMs, 'dueAtMs');
    const { request, dueAtMs } = planned;
    if (
      request.cancellationGroup !== undefined &&
      this.#cancelledGroups.has(request.cancellationGroup)
    ) {
      return { status: 'drop', dueAtMs, reason: 'cancelled' };
    }
    if (request.eventId !== undefined && this.#rememberedEventIds.has(request.eventId)) {
      return { status: 'drop', dueAtMs, reason: 'duplicate' };
    }
    if (nowMs < dueAtMs) return { status: 'defer', dueAtMs, waitMs: dueAtMs - nowMs };
    const lateByMs = nowMs - dueAtMs;
    if (lateByMs > this.#maxLateByMs) return { status: 'drop', dueAtMs, reason: 'late' };
    if (!this.canPlay(request.cue, nowMs, request.cancellationGroup)) {
      return { status: 'drop', dueAtMs, reason: 'rate-limited' };
    }
    return { status: 'ready', dueAtMs, lateByMs };
  }

  /** Atomically inspect and remember a cue that is ready for dispatch. */
  commit(planned: PlannedAudioCue<Cue>, nowMs: number): CuePlaybackDecision {
    const decision = this.inspect(planned, nowMs);
    if (decision.status === 'ready') {
      this.markPlayed(planned.request.cue, nowMs, planned.request.eventId);
    }
    return decision;
  }

  forgetEvent(eventId: string): void {
    this.#rememberedEventIds.delete(eventId);
  }

  cancelGroup(group: string): void {
    if (group !== '') this.#cancelledGroups.add(group);
  }

  reopenGroup(group: string): void {
    this.#cancelledGroups.delete(group);
  }

  reset(): void {
    this.#lastPlayed.clear();
    this.#cancelledGroups.clear();
    this.#rememberedEventIds.clear();
  }

  #rememberEvent(eventId: string): void {
    this.#rememberedEventIds.delete(eventId);
    this.#rememberedEventIds.add(eventId);
    while (this.#rememberedEventIds.size > this.#maxRememberedEventIds) {
      const oldest = this.#rememberedEventIds.values().next().value;
      if (oldest === undefined) return;
      this.#rememberedEventIds.delete(oldest);
    }
  }
}

function finiteTime(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}
