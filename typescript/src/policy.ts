export type SemanticAudioBus =
  | "music"
  | "ambience"
  | "dialogue"
  | "game-foley"
  | "ui"
  | "spatial";

export type AudioPriority = "material" | "normal" | "important";

export interface AudioSpatialPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface AudioCueRequest<Cue extends string> {
  readonly cue: Cue;
  readonly bus: SemanticAudioBus;
  readonly priority: AudioPriority;
  readonly eventId?: string;
  readonly scheduledAtMs?: number;
  readonly delayMs?: number;
  readonly pan?: number;
  readonly position?: AudioSpatialPosition;
  readonly level?: number;
  readonly cancellationGroup?: string;
  readonly variationSeed?: string | number;
}

export function clampAudioLevel(level: number): number {
  return Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 1;
}

export function clampPan(pan: number): number {
  return Number.isFinite(pan) ? Math.min(1, Math.max(-1, pan)) : 0;
}

export function gainForVolume(volume: number): number {
  const clamped = Number.isFinite(volume)
    ? Math.min(100, Math.max(0, volume))
    : 0;
  return (clamped / 100) ** 2;
}

export function panForTablePosition(leftPercent: number): number {
  const safeLeft = Number.isFinite(leftPercent) ? leftPercent : 50;
  const clamped = Math.min(100, Math.max(0, safeLeft));
  return ((clamped - 50) / 50) * 0.82;
}

export function panForSeat(seatIndex: number, seatCount: number): number {
  if (!Number.isFinite(seatCount) || seatCount <= 1) return 0;
  const count = Math.max(1, Math.trunc(seatCount));
  const safeIndex = Number.isFinite(seatIndex) ? Math.trunc(seatIndex) : 0;
  const clampedIndex = Math.min(count - 1, Math.max(0, safeIndex));
  return ((clampedIndex / (count - 1)) * 2 - 1) * 0.82;
}

export function audioActivationAllowsPlayback(
  activation: { readonly hasBeenActive: boolean } | undefined,
): boolean {
  return activation === undefined || activation.hasBeenActive;
}

export function visibilityAllowsSound(
  visibilityState: string | undefined,
): boolean {
  return visibilityState === undefined || visibilityState === "visible";
}
