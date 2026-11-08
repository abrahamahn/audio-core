import type { AudioCueRequest } from "./policy.js";
import {
  finiteNumber,
  nonNegativeFinite,
  positiveSafeInteger,
} from "./validation.js";

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

export type CueDropReason = "cancelled" | "duplicate" | "late" | "rate-limited";

export type CuePlaybackDecision =
  | {
      readonly status: "ready";
      readonly dueAtMs: number;
      readonly lateByMs: number;
    }
  | {
      readonly status: "defer";
      readonly dueAtMs: number;
      readonly waitMs: number;
    }
  | {
      readonly status: "drop";
      readonly dueAtMs: number;
      readonly reason: CueDropReason;
    };

export class CueScheduler<Cue extends string> {
  readonly #defaultMinGapMs: number;
  readonly #minGapForCue: ((cue: Cue) => number | undefined) | undefined;
  readonly #maxLateByMs: number;
  readonly #maxRememberedEventIds: number;
  readonly #lastPlayed = new Map<Cue, number>();
  readonly #cancelledGroups = new Set<string>();
  readonly #rememberedEventIds = new Set<string>();

  constructor(options: CueSchedulerOptions<Cue> = {}) {
    this.#defaultMinGapMs = nonNegativeFinite(
      options.defaultMinGapMs ?? 0,
      "defaultMinGapMs",
    );
    this.#minGapForCue = options.minGapForCue;
    this.#maxLateByMs = options.maxLateByMs ?? Number.POSITIVE_INFINITY;
    if (Number.isNaN(this.#maxLateByMs) || this.#maxLateByMs < 0) {
      throw new RangeError("maxLateByMs must be non-negative");
    }
    this.#maxRememberedEventIds = positiveSafeInteger(
      options.maxRememberedEventIds ?? 1024,
      "maxRememberedEventIds",
    );
  }

  canPlay(cue: Cue, nowMs: number, cancellationGroup?: string): boolean {
    finiteNumber(nowMs, "nowMs");
    if (
      cancellationGroup !== undefined &&
      this.#cancelledGroups.has(cancellationGroup)
    ) {
      return false;
    }
    const configuredGap = nonNegativeFinite(
      this.#minGapForCue?.(cue) ?? this.#defaultMinGapMs,
      "cue minimum gap",
    );
    return (
      nowMs - (this.#lastPlayed.get(cue) ?? Number.NEGATIVE_INFINITY) >=
      configuredGap
    );
  }

  markPlayed(cue: Cue, nowMs: number, eventId?: string): void {
    finiteNumber(nowMs, "nowMs");
    this.#lastPlayed.set(cue, nowMs);
    if (eventId !== undefined && eventId !== "") this.#rememberEvent(eventId);
  }

  plan(
    request: AudioCueRequest<Cue>,
    receivedAtMs: number,
  ): PlannedAudioCue<Cue> {
    finiteNumber(receivedAtMs, "receivedAtMs");
    const scheduledAtMs = finiteNumber(
      request.scheduledAtMs ?? receivedAtMs,
      "scheduledAtMs",
    );
    const delayMs = nonNegativeFinite(request.delayMs ?? 0, "delayMs");
    const dueAtMs = finiteNumber(scheduledAtMs + delayMs, "dueAtMs");
    return { request, dueAtMs };
  }

  inspect(planned: PlannedAudioCue<Cue>, nowMs: number): CuePlaybackDecision {
    finiteNumber(nowMs, "nowMs");
    finiteNumber(planned.dueAtMs, "dueAtMs");
    const { request, dueAtMs } = planned;
    if (
      request.cancellationGroup !== undefined &&
      this.#cancelledGroups.has(request.cancellationGroup)
    ) {
      return { status: "drop", dueAtMs, reason: "cancelled" };
    }
    if (
      request.eventId !== undefined &&
      this.#rememberedEventIds.has(request.eventId)
    ) {
      return { status: "drop", dueAtMs, reason: "duplicate" };
    }
    if (nowMs < dueAtMs)
      return { status: "defer", dueAtMs, waitMs: dueAtMs - nowMs };
    const lateByMs = nowMs - dueAtMs;
    if (lateByMs > this.#maxLateByMs)
      return { status: "drop", dueAtMs, reason: "late" };
    if (!this.canPlay(request.cue, nowMs, request.cancellationGroup)) {
      return { status: "drop", dueAtMs, reason: "rate-limited" };
    }
    return { status: "ready", dueAtMs, lateByMs };
  }

  /** Atomically inspect and remember a cue that is ready for dispatch. */
  commit(planned: PlannedAudioCue<Cue>, nowMs: number): CuePlaybackDecision {
    const decision = this.inspect(planned, nowMs);
    if (decision.status === "ready") {
      this.markPlayed(planned.request.cue, nowMs, planned.request.eventId);
    }
    return decision;
  }

  forgetEvent(eventId: string): void {
    this.#rememberedEventIds.delete(eventId);
  }

  cancelGroup(group: string): void {
    if (group !== "") this.#cancelledGroups.add(group);
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
