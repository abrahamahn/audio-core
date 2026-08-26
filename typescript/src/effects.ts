export interface AudioEffectBase {
  /** Stable application-owned identity used for live control and diagnostics. */
  readonly id: string;
  readonly enabled?: boolean;
}

export interface AudioFilterEffectConfig extends AudioEffectBase {
  readonly type: 'highpass' | 'lowpass';
  readonly frequencyHz: number;
  readonly q?: number;
}

export interface AudioSaturationEffectConfig extends AudioEffectBase {
  readonly type: 'saturation';
  /** Non-negative curve drive. Zero is transparent; 100 is the supported maximum. */
  readonly drive?: number;
  /** Wet proportion from zero to one. */
  readonly mix?: number;
  readonly oversample?: '2x' | '4x' | 'none';
}

export interface AudioEqualizerBand {
  readonly type: 'highshelf' | 'lowshelf' | 'peaking';
  readonly frequencyHz: number;
  readonly gainDb: number;
  readonly q?: number;
}

export interface AudioEqualizerEffectConfig extends AudioEffectBase {
  readonly type: 'equalizer';
  /** Ordered low-shelf, peaking, or high-shelf bands. */
  readonly bands: readonly AudioEqualizerBand[];
}

export interface AudioCompressorEffectConfig extends AudioEffectBase {
  readonly type: 'compressor';
  readonly thresholdDb?: number;
  readonly kneeDb?: number;
  readonly ratio?: number;
  readonly attackSeconds?: number;
  readonly releaseSeconds?: number;
  readonly makeupGainDb?: number;
  readonly mix?: number;
}

export interface AudioReverbEffectConfig extends AudioEffectBase {
  readonly type: 'reverb';
  /** Normalized room size from zero to one. */
  readonly roomSize?: number;
  /** Normalized high-frequency damping from zero to one. */
  readonly damping?: number;
  readonly preDelaySeconds?: number;
  readonly wet?: number;
  readonly dry?: number;
  /** Deterministic unsigned 32-bit seed for generated browser impulse responses. */
  readonly seed?: number;
}

export interface AudioDelayEffectConfig extends AudioEffectBase {
  readonly type: 'delay';
  readonly delaySeconds: number;
  readonly maxDelaySeconds?: number;
  /** Feedback from zero up to, but excluding, one. */
  readonly feedback?: number;
  readonly wet?: number;
  readonly dry?: number;
}

export type AudioEffectConfig =
  | AudioCompressorEffectConfig
  | AudioDelayEffectConfig
  | AudioEqualizerEffectConfig
  | AudioFilterEffectConfig
  | AudioReverbEffectConfig
  | AudioSaturationEffectConfig;

export function validateAudioEffectChain(effects: readonly AudioEffectConfig[]): void {
  const ids = new Set<string>();
  for (const effect of effects) {
    validateAudioEffectConfig(effect);
    if (ids.has(effect.id)) throw new RangeError(`duplicate audio effect id: ${effect.id}`);
    ids.add(effect.id);
  }
}

export function validateAudioEffectConfig(effect: AudioEffectConfig): void {
  const id: unknown = effect.id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new RangeError('audio effect id must not be empty');
  }
  const enabled: unknown = effect.enabled;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new RangeError('audio effect enabled must be boolean');
  }
  switch (effect.type) {
    case 'highpass':
    case 'lowpass':
      bounded(effect.frequencyHz, 1, 96_000, 'frequencyHz');
      bounded(effect.q ?? 0.707, 0, 1_000, 'q');
      return;
    case 'saturation':
      bounded(effect.drive ?? 1, 0, 100, 'drive');
      unit(effect.mix ?? 1, 'mix');
      const oversample: unknown = effect.oversample;
      if (
        oversample !== undefined &&
        oversample !== 'none' &&
        oversample !== '2x' &&
        oversample !== '4x'
      ) {
        throw new RangeError('oversample must be none, 2x, or 4x');
      }
      return;
    case 'equalizer':
      const bands: readonly AudioEqualizerBand[] = effect.bands;
      const runtimeBands: unknown = effect.bands;
      if (!Array.isArray(runtimeBands) || bands.length === 0 || bands.length > 32) {
        throw new RangeError('equalizer requires between 1 and 32 bands');
      }
      for (const band of bands) {
        const bandType: unknown = band.type;
        if (bandType !== 'lowshelf' && bandType !== 'peaking' && bandType !== 'highshelf') {
          throw new RangeError('equalizer band type must be lowshelf, peaking, or highshelf');
        }
        bounded(band.frequencyHz, 1, 96_000, 'equalizer frequencyHz');
        bounded(band.gainDb, -24, 24, 'equalizer gainDb');
        bounded(band.q ?? 0.707, 0.0001, 1_000, 'equalizer q');
      }
      return;
    case 'compressor':
      bounded(effect.thresholdDb ?? -24, -100, 0, 'thresholdDb');
      bounded(effect.kneeDb ?? 30, 0, 40, 'kneeDb');
      bounded(effect.ratio ?? 4, 1, 20, 'ratio');
      bounded(effect.attackSeconds ?? 0.003, 0, 1, 'attackSeconds');
      bounded(effect.releaseSeconds ?? 0.25, 0, 1, 'releaseSeconds');
      bounded(effect.makeupGainDb ?? 0, -24, 24, 'makeupGainDb');
      unit(effect.mix ?? 1, 'mix');
      return;
    case 'reverb':
      unit(effect.roomSize ?? 0.5, 'roomSize');
      unit(effect.damping ?? 0.3, 'damping');
      bounded(effect.preDelaySeconds ?? 0, 0, 1, 'preDelaySeconds');
      unit(effect.wet ?? 0.25, 'wet');
      unit(effect.dry ?? 1, 'dry');
      if (
        effect.seed !== undefined &&
        (!Number.isSafeInteger(effect.seed) || effect.seed < 0 || effect.seed > 0xffff_ffff)
      ) {
        throw new RangeError('seed must be an unsigned 32-bit integer');
      }
      return;
    case 'delay': {
      const maximum = effect.maxDelaySeconds ?? Math.max(1, effect.delaySeconds);
      bounded(maximum, 0.001, 180, 'maxDelaySeconds');
      bounded(effect.delaySeconds, 0.001, maximum, 'delaySeconds');
      bounded(effect.feedback ?? 0.3, 0, 0.99, 'feedback');
      unit(effect.wet ?? 0.3, 'wet');
      unit(effect.dry ?? 1, 'dry');
      return;
    }
    default:
      throw new RangeError(
        `unsupported audio effect type: ${String((effect as { type: unknown }).type)}`,
      );
  }
}

function unit(value: number, name: string): void {
  bounded(value, 0, 1, name);
}

function bounded(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${String(minimum)} and ${String(maximum)}`);
  }
}
