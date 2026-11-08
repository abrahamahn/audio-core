use std::collections::HashSet;
use std::error::Error;
use std::fmt::{Display, Formatter};

pub const MAX_DSP_CHANNELS: usize = 32;
pub const MAX_DSP_EFFECTS: usize = 128;
pub const MAX_DSP_SAMPLE_RATE: f32 = 384_000.0;
/// Default click-free transition time for bypass and live effect configuration changes.
pub const DEFAULT_CONTROL_SMOOTHING_SECONDS: f32 = 0.02;
/// At most 128 MiB of persistent `f32` delay/filter state per chain.
pub const MAX_DSP_STATE_SAMPLES: usize = 33_554_432;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FilterKind {
    HighPass,
    LowPass,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EqualizerBandKind {
    HighShelf,
    LowShelf,
    Peaking,
}

#[derive(Clone, Debug, PartialEq)]
pub struct FilterConfig {
    pub id: String,
    pub enabled: bool,
    pub kind: FilterKind,
    pub frequency_hz: f32,
    pub q: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EqualizerBand {
    pub kind: EqualizerBandKind,
    pub frequency_hz: f32,
    pub gain_db: f32,
    pub q: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EqualizerConfig {
    pub id: String,
    pub enabled: bool,
    pub bands: Vec<EqualizerBand>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SaturationConfig {
    pub id: String,
    pub enabled: bool,
    pub drive: f32,
    pub mix: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompressorConfig {
    pub id: String,
    pub enabled: bool,
    pub threshold_db: f32,
    pub knee_db: f32,
    pub ratio: f32,
    pub attack_seconds: f32,
    pub release_seconds: f32,
    pub makeup_gain_db: f32,
    pub mix: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DelayConfig {
    pub id: String,
    pub enabled: bool,
    pub delay_seconds: f32,
    pub feedback: f32,
    pub wet: f32,
    pub dry: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReverbConfig {
    pub id: String,
    pub enabled: bool,
    pub room_size: f32,
    pub damping: f32,
    pub pre_delay_seconds: f32,
    pub wet: f32,
    pub dry: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub enum EffectConfig {
    Compressor(CompressorConfig),
    Delay(DelayConfig),
    Equalizer(EqualizerConfig),
    Filter(FilterConfig),
    Reverb(ReverbConfig),
    Saturation(SaturationConfig),
}

impl EffectConfig {
    #[must_use]
    pub fn id(&self) -> &str {
        match self {
            Self::Compressor(config) => &config.id,
            Self::Delay(config) => &config.id,
            Self::Equalizer(config) => &config.id,
            Self::Filter(config) => &config.id,
            Self::Reverb(config) => &config.id,
            Self::Saturation(config) => &config.id,
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        match self {
            Self::Compressor(config) => config.enabled,
            Self::Delay(config) => config.enabled,
            Self::Equalizer(config) => config.enabled,
            Self::Filter(config) => config.enabled,
            Self::Reverb(config) => config.enabled,
            Self::Saturation(config) => config.enabled,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EffectError {
    DuplicateId(String),
    EmptyEqualizer,
    EmptyId,
    EffectIdentityMismatch,
    EffectTypeMismatch,
    InvalidBufferShape,
    InvalidChannelCount,
    InvalidSampleRate,
    InvalidValue(&'static str),
    ResourceBudgetExceeded,
    TooManyEffects,
    TooManyEqualizerBands,
}

impl Display for EffectError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DuplicateId(id) => write!(formatter, "duplicate audio effect id: {id}"),
            Self::EmptyEqualizer => formatter.write_str("equalizer requires a band"),
            Self::EmptyId => formatter.write_str("audio effect id must not be empty"),
            Self::EffectIdentityMismatch => {
                formatter.write_str("live audio effect updates must preserve effect identity")
            }
            Self::EffectTypeMismatch => {
                formatter.write_str("live audio effect updates must preserve effect type")
            }
            Self::InvalidBufferShape => {
                formatter.write_str("interleaved samples must contain complete frames")
            }
            Self::InvalidChannelCount => {
                formatter.write_str("channels must be within the supported DSP range")
            }
            Self::InvalidSampleRate => {
                formatter.write_str("sample rate must be finite and within the supported DSP range")
            }
            Self::InvalidValue(field) => write!(formatter, "invalid audio effect value: {field}"),
            Self::ResourceBudgetExceeded => {
                formatter.write_str("audio effect chain exceeds its persistent DSP memory budget")
            }
            Self::TooManyEffects => formatter.write_str("audio effect chain has too many effects"),
            Self::TooManyEqualizerBands => {
                formatter.write_str("equalizer supports at most 32 bands")
            }
        }
    }
}

impl Error for EffectError {}

/// Validate field bounds and unique, non-empty effect identities.
///
/// # Errors
///
/// Returns [`EffectError`] when a field is outside the shared contract or an identity is invalid.
pub fn validate_effect_chain(configs: &[EffectConfig]) -> Result<(), EffectError> {
    if configs.len() > MAX_DSP_EFFECTS {
        return Err(EffectError::TooManyEffects);
    }
    let mut ids = HashSet::new();
    for config in configs {
        if config.id().trim().is_empty() {
            return Err(EffectError::EmptyId);
        }
        if !ids.insert(config.id()) {
            return Err(EffectError::DuplicateId(config.id().to_owned()));
        }
        validate_effect(config)?;
    }
    Ok(())
}

/// Validate one effect configuration.
///
/// # Errors
///
/// Returns [`EffectError`] when a field is outside the shared effect contract.
pub fn validate_effect(config: &EffectConfig) -> Result<(), EffectError> {
    match config {
        EffectConfig::Filter(config) => {
            bounded(config.frequency_hz, 1.0, 96_000.0, "frequency_hz")?;
            bounded(config.q, 0.0, 1_000.0, "q")
        }
        EffectConfig::Equalizer(config) => {
            if config.bands.is_empty() {
                return Err(EffectError::EmptyEqualizer);
            }
            if config.bands.len() > 32 {
                return Err(EffectError::TooManyEqualizerBands);
            }
            for band in &config.bands {
                bounded(band.frequency_hz, 1.0, 96_000.0, "equalizer.frequency_hz")?;
                bounded(band.gain_db, -24.0, 24.0, "equalizer.gain_db")?;
                bounded(band.q, 0.0001, 1_000.0, "equalizer.q")?;
            }
            Ok(())
        }
        EffectConfig::Saturation(config) => {
            bounded(config.drive, 0.0, 100.0, "drive")?;
            unit(config.mix, "mix")
        }
        EffectConfig::Compressor(config) => {
            bounded(config.threshold_db, -100.0, 0.0, "threshold_db")?;
            bounded(config.knee_db, 0.0, 40.0, "knee_db")?;
            bounded(config.ratio, 1.0, 20.0, "ratio")?;
            bounded(config.attack_seconds, 0.0, 1.0, "attack_seconds")?;
            bounded(config.release_seconds, 0.0, 1.0, "release_seconds")?;
            bounded(config.makeup_gain_db, -24.0, 24.0, "makeup_gain_db")?;
            unit(config.mix, "mix")
        }
        EffectConfig::Delay(config) => {
            bounded(config.delay_seconds, 0.001, 180.0, "delay_seconds")?;
            bounded(config.feedback, 0.0, 0.99, "feedback")?;
            unit(config.wet, "wet")?;
            unit(config.dry, "dry")
        }
        EffectConfig::Reverb(config) => {
            unit(config.room_size, "room_size")?;
            unit(config.damping, "damping")?;
            bounded(config.pre_delay_seconds, 0.0, 1.0, "pre_delay_seconds")?;
            unit(config.wet, "wet")?;
            unit(config.dry, "dry")
        }
    }
}

fn unit(value: f32, field: &'static str) -> Result<(), EffectError> {
    bounded(value, 0.0, 1.0, field)
}

fn bounded(value: f32, minimum: f32, maximum: f32, field: &'static str) -> Result<(), EffectError> {
    if value.is_finite() && value >= minimum && value <= maximum {
        Ok(())
    } else {
        Err(EffectError::InvalidValue(field))
    }
}
