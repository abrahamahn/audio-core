import type { AudioEffectConfig } from "./effects.js";

export type WorkletMessage =
  | { readonly type: "disposed" }
  | {
      readonly type: "control-set";
      readonly requestId: number;
      readonly updated: boolean;
    }
  | { readonly type: "processor-error"; readonly message: string }
  | { readonly type: "ready" };

export function isWorkletMessage(value: unknown): value is WorkletMessage {
  if (typeof value !== "object" || value === null || !("type" in value))
    return false;
  const type = value.type;
  if (type === "disposed" || type === "ready") return true;
  if (type === "processor-error")
    return "message" in value && typeof value.message === "string";
  return (
    type === "control-set" &&
    "requestId" in value &&
    Number.isSafeInteger(value.requestId) &&
    "updated" in value &&
    typeof value.updated === "boolean"
  );
}

export type WorkletControlRequest =
  | {
      readonly type: "set-enabled";
      readonly index: number;
      readonly enabled: boolean;
    }
  | {
      readonly type: "update-effect";
      readonly index: number;
      readonly effect: object;
    };

export function toRustEffectConfig(effect: AudioEffectConfig): object {
  const enabled = effect.enabled ?? true;
  switch (effect.type) {
    case "highpass":
    case "lowpass":
      return {
        type: "filter",
        enabled,
        kind: effect.type === "highpass" ? 0 : 1,
        frequencyHz: effect.frequencyHz,
        q: effect.q ?? 0.707,
      };
    case "equalizer":
      return {
        type: "equalizer",
        enabled,
        bands: effect.bands.map((band) => ({
          kind: band.type === "lowshelf" ? 0 : band.type === "peaking" ? 1 : 2,
          frequencyHz: band.frequencyHz,
          gainDb: band.gainDb,
          q: band.q ?? 0.707,
        })),
      };
    case "saturation":
      return {
        type: "saturation",
        enabled,
        drive: effect.drive ?? 1,
        mix: effect.mix ?? 1,
      };
    case "compressor":
      return {
        type: "compressor",
        enabled,
        thresholdDb: effect.thresholdDb ?? -24,
        kneeDb: effect.kneeDb ?? 30,
        ratio: effect.ratio ?? 4,
        attackSeconds: effect.attackSeconds ?? 0.003,
        releaseSeconds: effect.releaseSeconds ?? 0.25,
        makeupGainDb: effect.makeupGainDb ?? 0,
        mix: effect.mix ?? 1,
      };
    case "delay":
      return {
        type: "delay",
        enabled,
        delaySeconds: effect.delaySeconds,
        feedback: effect.feedback ?? 0.3,
        wet: effect.wet ?? 0.3,
        dry: effect.dry ?? 1,
      };
    case "reverb":
      return {
        type: "reverb",
        enabled,
        roomSize: effect.roomSize ?? 0.5,
        damping: effect.damping ?? 0.3,
        preDelaySeconds: effect.preDelaySeconds ?? 0,
        wet: effect.wet ?? 0.25,
        dry: effect.dry ?? 1,
      };
  }
}
