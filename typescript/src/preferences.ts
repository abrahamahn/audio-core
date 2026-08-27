import { clampAudioLevel, type AudioPriority } from "./policy.js";

export interface AudioPreferences<Channel extends string> {
  readonly muted: boolean;
  readonly masterLevel: number;
  readonly channelLevels: Readonly<Record<Channel, number>>;
  readonly reducedIntensity: boolean;
}

export interface AudioIntensityPolicy {
  readonly material: number;
  readonly normal: number;
  readonly important: number;
}

export const DEFAULT_AUDIO_INTENSITY_POLICY: AudioIntensityPolicy = {
  material: 0.55,
  normal: 0.75,
  important: 1,
};

export function normalizeAudioPreferences<Channel extends string>(
  input: unknown,
  channels: readonly Channel[],
): AudioPreferences<Channel> {
  const source = isRecord(input) ? input : {};
  const storedChannels = isRecord(source["channelLevels"])
    ? source["channelLevels"]
    : {};
  const channelLevels = Object.fromEntries(
    channels.map((channel) => [
      channel,
      clampAudioLevel(numberOr(storedChannels[channel], 1)),
    ]),
  ) as Record<Channel, number>;
  return {
    muted: source["muted"] === true,
    masterLevel: clampAudioLevel(numberOr(source["masterLevel"], 1)),
    channelLevels,
    reducedIntensity: source["reducedIntensity"] === true,
  };
}

export function effectiveAudioLevel<Channel extends string>(
  preferences: AudioPreferences<Channel>,
  channel: Channel,
  priority: AudioPriority,
  cueLevel = 1,
  intensityPolicy: AudioIntensityPolicy = DEFAULT_AUDIO_INTENSITY_POLICY,
): number {
  if (preferences.muted) return 0;
  const intensity = preferences.reducedIntensity
    ? clampAudioLevel(intensityPolicy[priority])
    : 1;
  return (
    clampAudioLevel(preferences.masterLevel) *
    clampAudioLevel(preferences.channelLevels[channel]) *
    clampAudioLevel(cueLevel) *
    intensity
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}
