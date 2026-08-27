export type AudioAssetDeliveryPolicy = "auto" | "decode" | "stream";
export type AudioAssetLoadMode = Exclude<AudioAssetDeliveryPolicy, "auto">;

export interface AudioAssetVariant {
  readonly url: string;
  readonly mimeType?: string;
  readonly codec?: string;
  readonly byteLength?: number;
  readonly contentHash?: string;
}

export interface AudioAssetProvenance {
  readonly source?: string;
  readonly creator?: string;
  readonly license?: string;
  readonly pipelineVersion?: string;
}

export interface AudioAssetManifestEntry {
  readonly version: string;
  readonly variants: readonly AudioAssetVariant[];
  readonly delivery?: AudioAssetDeliveryPolicy;
  readonly durationMs?: number;
  readonly loop?: boolean;
  readonly loudnessLufs?: number;
  readonly provenance?: AudioAssetProvenance;
}

export interface AudioAssetManifest<Asset extends string> {
  readonly version: string;
  readonly assets: Readonly<Record<Asset, AudioAssetManifestEntry>>;
}

export interface AudioAssetCapabilities {
  readonly canPlayType?: (
    mimeType: string,
    codec?: string,
  ) => boolean | "" | "maybe" | "probably";
}

export interface AudioAssetLoadPolicy {
  readonly streamingSupported?: boolean;
  readonly lowMemory?: boolean;
  readonly maxDecodedDurationMs?: number;
}

export function selectAudioAssetVariant(
  entry: AudioAssetManifestEntry,
  capabilities: AudioAssetCapabilities = {},
): AudioAssetVariant | null {
  validateManifestEntry(entry);
  for (const variant of entry.variants) {
    if (
      variant.mimeType === undefined ||
      capabilities.canPlayType === undefined
    )
      return variant;
    const support = capabilities.canPlayType(variant.mimeType, variant.codec);
    if (support === true || support === "maybe" || support === "probably")
      return variant;
  }
  return null;
}

export function audioAssetCandidateUrls(
  entry: AudioAssetManifestEntry,
  capabilities: AudioAssetCapabilities = {},
): readonly string[] {
  validateManifestEntry(entry);
  return entry.variants
    .filter((variant) => {
      if (
        variant.mimeType === undefined ||
        capabilities.canPlayType === undefined
      )
        return true;
      const support = capabilities.canPlayType(variant.mimeType, variant.codec);
      return support === true || support === "maybe" || support === "probably";
    })
    .map(({ url }) => url);
}

export function resolveAudioAssetLoadMode(
  entry: AudioAssetManifestEntry,
  policy: AudioAssetLoadPolicy = {},
): AudioAssetLoadMode | null {
  validateManifestEntry(entry);
  const streamingSupported = policy.streamingSupported ?? true;
  const delivery = entry.delivery ?? "auto";
  if (delivery === "decode") return "decode";
  if (delivery === "stream") return streamingSupported ? "stream" : null;
  if (!streamingSupported) return "decode";
  if (policy.lowMemory === true) return "stream";
  const maxDecodedDurationMs = policy.maxDecodedDurationMs ?? 120_000;
  if (!Number.isFinite(maxDecodedDurationMs) || maxDecodedDurationMs < 0) {
    throw new RangeError(
      "maxDecodedDurationMs must be finite and non-negative",
    );
  }
  return entry.durationMs !== undefined &&
    entry.durationMs > maxDecodedDurationMs
    ? "stream"
    : "decode";
}

export function validateManifestEntry(entry: AudioAssetManifestEntry): void {
  if (entry.version === "")
    throw new RangeError("audio asset version must not be empty");
  if (entry.variants.length === 0)
    throw new RangeError("audio asset requires a variant");
  if (
    entry.durationMs !== undefined &&
    (!Number.isFinite(entry.durationMs) || entry.durationMs < 0)
  ) {
    throw new RangeError(
      "audio asset durationMs must be finite and non-negative",
    );
  }
  if (
    entry.loudnessLufs !== undefined &&
    !Number.isFinite(entry.loudnessLufs)
  ) {
    throw new RangeError("audio asset loudnessLufs must be finite");
  }
  for (const variant of entry.variants) {
    if (variant.url === "")
      throw new RangeError("audio asset variant URL must not be empty");
    if (
      variant.byteLength !== undefined &&
      (!Number.isSafeInteger(variant.byteLength) || variant.byteLength < 0)
    ) {
      throw new RangeError(
        "audio asset byteLength must be a non-negative safe integer",
      );
    }
  }
}
