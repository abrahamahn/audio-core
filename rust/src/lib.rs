#![forbid(unsafe_code)]

use std::collections::HashSet;
use std::error::Error;
use std::f32::consts::PI;
use std::fmt::{Display, Formatter};

pub const MAX_DSP_CHANNELS: usize = 32;
pub const MAX_DSP_EFFECTS: usize = 128;
pub const MAX_DSP_SAMPLE_RATE: f32 = 384_000.0;
/// Default click-free transition time for bypass and live effect configuration changes.
pub const DEFAULT_CONTROL_SMOOTHING_SECONDS: f32 = 0.02;
/// At most 128 MiB of persistent `f32` delay/filter state per chain.
pub const MAX_DSP_STATE_SAMPLES: usize = 33_554_432;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
mod wasm;

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

    fn enabled(&self) -> bool {
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

pub struct EffectChain {
    sample_rate: f32,
    channels: usize,
    configs: Vec<EffectConfig>,
    processors: Vec<Processor>,
}

impl EffectChain {
    /// Construct an allocation-bounded processor chain for a fixed stream shape.
    ///
    /// # Errors
    ///
    /// Returns [`EffectError`] for an invalid sample rate, channel count, or effect configuration.
    pub fn new(
        sample_rate: f32,
        channels: usize,
        configs: &[EffectConfig],
    ) -> Result<Self, EffectError> {
        if !sample_rate.is_finite() || !(1.0..=MAX_DSP_SAMPLE_RATE).contains(&sample_rate) {
            return Err(EffectError::InvalidSampleRate);
        }
        if channels == 0 || channels > MAX_DSP_CHANNELS {
            return Err(EffectError::InvalidChannelCount);
        }
        validate_effect_chain(configs)?;
        if effect_chain_state_samples(sample_rate, channels, configs)? > MAX_DSP_STATE_SAMPLES {
            return Err(EffectError::ResourceBudgetExceeded);
        }
        let processors = configs
            .iter()
            .map(|config| Processor::new(sample_rate, channels, config))
            .collect();
        Ok(Self {
            sample_rate,
            channels,
            configs: configs.to_vec(),
            processors,
        })
    }

    /// Process complete interleaved frames in place without allocating.
    ///
    /// # Errors
    ///
    /// Returns [`EffectError::InvalidBufferShape`] when the slice ends in a partial frame.
    pub fn process_interleaved(&mut self, samples: &mut [f32]) -> Result<(), EffectError> {
        if !samples.len().is_multiple_of(self.channels) {
            return Err(EffectError::InvalidBufferShape);
        }
        for frame in samples.chunks_exact_mut(self.channels) {
            for sample in &mut *frame {
                if !sample.is_finite() {
                    *sample = 0.0;
                }
            }
            for processor in &mut self.processors {
                processor.process_frame(frame);
            }
            for sample in frame {
                if !sample.is_finite() {
                    *sample = 0.0;
                }
            }
        }
        Ok(())
    }

    #[must_use]
    pub fn effect_count(&self) -> usize {
        self.processors.len()
    }

    /// Enable or bypass one processor without rebuilding or allocating.
    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> bool {
        let Some(index) = self
            .processors
            .iter()
            .position(|processor| processor.id == id)
        else {
            return false;
        };
        self.set_enabled_at(index, enabled)
    }

    /// Enable or bypass one processor by stable chain position without rebuilding or allocating.
    pub fn set_enabled_at(&mut self, index: usize, enabled: bool) -> bool {
        let Some(processor) = self.processors.get_mut(index) else {
            return false;
        };
        processor.set_enabled(enabled, control_smoothing_frames(self.sample_rate));
        set_config_enabled(&mut self.configs[index], enabled);
        true
    }

    /// Replace one effect's complete configuration while preserving identity and chain position.
    ///
    /// The old and new processors are rendered in parallel for the default control smoothing
    /// period. This keeps filter, EQ, dynamics, delay, and reverb changes click-free without
    /// allocating in [`Self::process_interleaved`].
    ///
    /// # Errors
    ///
    /// Returns [`EffectError`] when the new configuration is invalid, changes the effect's
    /// identity or type, or would exceed the temporary transition-state budget.
    pub fn update_effect(&mut self, id: &str, config: EffectConfig) -> Result<bool, EffectError> {
        let Some(index) = self
            .processors
            .iter()
            .position(|processor| processor.id == id)
        else {
            return Ok(false);
        };
        self.update_effect_at(index, config)
    }

    /// Replace one effect's complete configuration by stable chain position.
    ///
    /// # Errors
    ///
    /// Returns [`EffectError`] under the same conditions as [`Self::update_effect`].
    pub fn update_effect_at(
        &mut self,
        index: usize,
        config: EffectConfig,
    ) -> Result<bool, EffectError> {
        let Some(current) = self.configs.get(index) else {
            return Ok(false);
        };
        validate_effect(&config)?;
        if current.id() != config.id() {
            return Err(EffectError::EffectIdentityMismatch);
        }
        if std::mem::discriminant(current) != std::mem::discriminant(&config) {
            return Err(EffectError::EffectTypeMismatch);
        }

        let mut next_configs = self.configs.clone();
        next_configs[index] = config.clone();
        let next_state =
            effect_chain_state_samples(self.sample_rate, self.channels, &next_configs)?;
        let transition_state = effect_chain_state_samples(
            self.sample_rate,
            self.channels,
            std::slice::from_ref(current),
        )?;
        if next_state
            .checked_add(transition_state)
            .ok_or(EffectError::ResourceBudgetExceeded)?
            > MAX_DSP_STATE_SAMPLES
        {
            return Err(EffectError::ResourceBudgetExceeded);
        }

        self.processors[index].update(
            self.sample_rate,
            self.channels,
            &config,
            control_smoothing_frames(self.sample_rate),
        );
        self.configs[index] = config;
        Ok(true)
    }
}

fn set_config_enabled(config: &mut EffectConfig, enabled: bool) {
    match config {
        EffectConfig::Compressor(config) => config.enabled = enabled,
        EffectConfig::Delay(config) => config.enabled = enabled,
        EffectConfig::Equalizer(config) => config.enabled = enabled,
        EffectConfig::Filter(config) => config.enabled = enabled,
        EffectConfig::Reverb(config) => config.enabled = enabled,
        EffectConfig::Saturation(config) => config.enabled = enabled,
    }
}

fn control_smoothing_frames(sample_rate: f32) -> usize {
    seconds_to_samples(sample_rate, DEFAULT_CONTROL_SMOOTHING_SECONDS).max(1)
}

fn effect_chain_state_samples(
    sample_rate: f32,
    channels: usize,
    configs: &[EffectConfig],
) -> Result<usize, EffectError> {
    configs.iter().try_fold(0_usize, |total, config| {
        let samples = match config {
            EffectConfig::Filter(_) => channels,
            EffectConfig::Equalizer(config) => checked_samples(channels, config.bands.len())?,
            EffectConfig::Saturation(_) => 0,
            EffectConfig::Compressor(_) => 1,
            EffectConfig::Delay(config) => checked_samples(
                channels,
                seconds_to_samples(sample_rate, config.delay_seconds).max(1),
            )?,
            EffectConfig::Reverb(config) => {
                let scale = 0.7 + config.room_size * 0.6;
                let comb_lengths = [0.0297_f32, 0.0371, 0.0411, 0.0437]
                    .into_iter()
                    .map(|seconds| seconds_to_samples(sample_rate, seconds * scale).max(1))
                    .try_fold(0_usize, |sum, length| {
                        sum.checked_add(length)
                            .ok_or(EffectError::ResourceBudgetExceeded)
                    })?;
                let pre_delay = seconds_to_samples(sample_rate, config.pre_delay_seconds);
                let per_channel = comb_lengths
                    .checked_add(pre_delay)
                    .and_then(|value| value.checked_add(6))
                    .ok_or(EffectError::ResourceBudgetExceeded)?;
                checked_samples(channels, per_channel)?
            }
        };
        total
            .checked_add(samples)
            .ok_or(EffectError::ResourceBudgetExceeded)
    })
}

fn checked_samples(left: usize, right: usize) -> Result<usize, EffectError> {
    left.checked_mul(right)
        .ok_or(EffectError::ResourceBudgetExceeded)
}

enum ProcessorKind {
    Compressor(Compressor),
    Delay(Delay),
    Equalizer(Equalizer),
    Filter(Biquad),
    Reverb(Reverb),
    Saturation(Saturation),
}

struct Processor {
    id: String,
    enabled_mix: LinearRamp,
    kind: ProcessorKind,
    transition: Option<ProcessorTransition>,
}

impl Processor {
    fn new(sample_rate: f32, channels: usize, config: &EffectConfig) -> Self {
        let kind = match config {
            EffectConfig::Filter(config) => ProcessorKind::Filter(Biquad::filter(
                channels,
                sample_rate,
                config.kind,
                config.frequency_hz,
                config.q,
            )),
            EffectConfig::Equalizer(config) => {
                ProcessorKind::Equalizer(Equalizer::new(channels, sample_rate, &config.bands))
            }
            EffectConfig::Saturation(config) => {
                ProcessorKind::Saturation(Saturation::new(config.drive, config.mix))
            }
            EffectConfig::Compressor(config) => {
                ProcessorKind::Compressor(Compressor::new(sample_rate, config))
            }
            EffectConfig::Delay(config) => {
                ProcessorKind::Delay(Delay::new(sample_rate, channels, config))
            }
            EffectConfig::Reverb(config) => {
                ProcessorKind::Reverb(Reverb::new(sample_rate, channels, config))
            }
        };
        Self {
            id: config.id().to_owned(),
            enabled_mix: LinearRamp::new(if config.enabled() { 1.0 } else { 0.0 }),
            kind,
            transition: None,
        }
    }

    fn process_frame(&mut self, frame: &mut [f32]) {
        let mut dry = [0.0_f32; MAX_DSP_CHANNELS];
        dry[..frame.len()].copy_from_slice(frame);

        if let Some(transition) = &mut self.transition {
            let mut previous = [0.0_f32; MAX_DSP_CHANNELS];
            previous[..frame.len()].copy_from_slice(frame);
            transition
                .previous
                .process_frame(&mut previous[..frame.len()]);
            self.kind.process_frame(frame);
            let mix = transition.mix.next();
            for (sample, old) in frame.iter_mut().zip(previous) {
                *sample = old * (1.0 - mix) + *sample * mix;
            }
            if transition.mix.finished() {
                self.transition = None;
            }
        } else {
            self.kind.process_frame(frame);
        }

        let enabled = self.enabled_mix.next();
        for (sample, dry) in frame.iter_mut().zip(dry) {
            *sample = dry * (1.0 - enabled) + *sample * enabled;
        }
    }

    fn set_enabled(&mut self, enabled: bool, smoothing_frames: usize) {
        self.enabled_mix
            .set_target(if enabled { 1.0 } else { 0.0 }, smoothing_frames);
    }

    fn update(
        &mut self,
        sample_rate: f32,
        channels: usize,
        config: &EffectConfig,
        smoothing_frames: usize,
    ) {
        let next = Processor::new(sample_rate, channels, config);
        let previous = std::mem::replace(&mut self.kind, next.kind);
        self.transition = Some(ProcessorTransition {
            previous,
            mix: LinearRamp::transition(smoothing_frames),
        });
        self.set_enabled(config.enabled(), smoothing_frames);
    }
}

impl ProcessorKind {
    fn process_frame(&mut self, frame: &mut [f32]) {
        match self {
            ProcessorKind::Compressor(processor) => processor.process_frame(frame),
            ProcessorKind::Delay(processor) => processor.process_frame(frame),
            ProcessorKind::Equalizer(processor) => processor.process_frame(frame),
            ProcessorKind::Filter(processor) => processor.process_frame(frame),
            ProcessorKind::Reverb(processor) => processor.process_frame(frame),
            ProcessorKind::Saturation(processor) => processor.process_frame(frame),
        }
    }
}

struct ProcessorTransition {
    previous: ProcessorKind,
    mix: LinearRamp,
}

struct LinearRamp {
    current: f32,
    target: f32,
    step: f32,
    remaining: usize,
}

impl LinearRamp {
    fn new(value: f32) -> Self {
        Self {
            current: value,
            target: value,
            step: 0.0,
            remaining: 0,
        }
    }

    fn transition(frames: usize) -> Self {
        let mut ramp = Self::new(0.0);
        ramp.set_target(1.0, frames);
        ramp
    }

    #[allow(clippy::cast_precision_loss)]
    fn set_target(&mut self, target: f32, frames: usize) {
        self.target = target;
        self.remaining = frames.max(1);
        self.step = (target - self.current) / self.remaining as f32;
    }

    fn next(&mut self) -> f32 {
        if self.remaining > 0 {
            self.current += self.step;
            self.remaining -= 1;
            if self.remaining == 0 {
                self.current = self.target;
            }
        }
        self.current
    }

    fn finished(&self) -> bool {
        self.remaining == 0
    }
}

#[derive(Clone, Copy, Default)]
struct BiquadState {
    z1: f32,
    z2: f32,
}

#[derive(Clone, Copy)]
struct Coefficients {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
}

struct Biquad {
    coefficients: Coefficients,
    states: Vec<BiquadState>,
}

impl Biquad {
    fn filter(
        channels: usize,
        sample_rate: f32,
        kind: FilterKind,
        frequency_hz: f32,
        q: f32,
    ) -> Self {
        let omega = normalized_omega(sample_rate, frequency_hz);
        let sine = omega.sin();
        let cos = omega.cos();
        let alpha = sine / (2.0 * q.max(0.0001));
        let (b0, b1, b2) = match kind {
            FilterKind::LowPass => ((1.0 - cos) / 2.0, 1.0 - cos, (1.0 - cos) / 2.0),
            FilterKind::HighPass => (
                f32::midpoint(1.0, cos),
                -(1.0 + cos),
                f32::midpoint(1.0, cos),
            ),
        };
        Self::from_raw(channels, b0, b1, b2, 1.0 + alpha, -2.0 * cos, 1.0 - alpha)
    }

    fn equalizer(channels: usize, sample_rate: f32, band: EqualizerBand) -> Self {
        let omega = normalized_omega(sample_rate, band.frequency_hz);
        let sine = omega.sin();
        let cos = omega.cos();
        let amplitude = 10.0_f32.powf(band.gain_db / 40.0);
        match band.kind {
            EqualizerBandKind::Peaking => {
                let alpha = sine / (2.0 * band.q.max(0.0001));
                Self::from_raw(
                    channels,
                    1.0 + alpha * amplitude,
                    -2.0 * cos,
                    1.0 - alpha * amplitude,
                    1.0 + alpha / amplitude,
                    -2.0 * cos,
                    1.0 - alpha / amplitude,
                )
            }
            EqualizerBandKind::LowShelf => Self::shelf(channels, amplitude, cos, sine, false),
            EqualizerBandKind::HighShelf => Self::shelf(channels, amplitude, cos, sine, true),
        }
    }

    fn shelf(channels: usize, amplitude: f32, cos: f32, sine: f32, high: bool) -> Self {
        let alpha = sine / 2.0 * 2.0_f32.sqrt();
        let root = 2.0 * amplitude.sqrt() * alpha;
        let polarity = if high { -1.0 } else { 1.0 };
        let b0 = amplitude * ((amplitude + 1.0) - polarity * (amplitude - 1.0) * cos + root);
        let b1 =
            polarity * 2.0 * amplitude * ((amplitude - 1.0) - polarity * (amplitude + 1.0) * cos);
        let b2 = amplitude * ((amplitude + 1.0) - polarity * (amplitude - 1.0) * cos - root);
        let a0 = (amplitude + 1.0) + polarity * (amplitude - 1.0) * cos + root;
        let a1 = -polarity * 2.0 * ((amplitude - 1.0) + polarity * (amplitude + 1.0) * cos);
        let a2 = (amplitude + 1.0) + polarity * (amplitude - 1.0) * cos - root;
        Self::from_raw(channels, b0, b1, b2, a0, a1, a2)
    }

    fn from_raw(channels: usize, b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) -> Self {
        Self {
            coefficients: Coefficients {
                b0: b0 / a0,
                b1: b1 / a0,
                b2: b2 / a0,
                a1: a1 / a0,
                a2: a2 / a0,
            },
            states: vec![BiquadState::default(); channels],
        }
    }

    fn process_frame(&mut self, frame: &mut [f32]) {
        for (sample, state) in frame.iter_mut().zip(&mut self.states) {
            let input = *sample;
            let output = self.coefficients.b0.mul_add(input, state.z1);
            state.z1 = self
                .coefficients
                .b1
                .mul_add(input, state.z2 - self.coefficients.a1 * output);
            state.z2 = self
                .coefficients
                .b2
                .mul_add(input, -self.coefficients.a2 * output);
            *sample = output;
        }
    }
}

struct Equalizer {
    bands: Vec<Biquad>,
}

impl Equalizer {
    fn new(channels: usize, sample_rate: f32, bands: &[EqualizerBand]) -> Self {
        Self {
            bands: bands
                .iter()
                .copied()
                .map(|band| Biquad::equalizer(channels, sample_rate, band))
                .collect(),
        }
    }

    fn process_frame(&mut self, frame: &mut [f32]) {
        for band in &mut self.bands {
            band.process_frame(frame);
        }
    }
}

struct Saturation {
    amount: f32,
    normalization: f32,
    mix: f32,
    transparent: bool,
}

impl Saturation {
    fn new(drive: f32, mix: f32) -> Self {
        let amount = 1.0 + drive * 0.25;
        Self {
            amount,
            normalization: amount.tanh(),
            mix,
            transparent: drive == 0.0,
        }
    }

    fn process_frame(&self, frame: &mut [f32]) {
        if self.transparent {
            return;
        }
        for sample in frame {
            let dry = *sample;
            let wet = (self.amount * dry).tanh() / self.normalization;
            *sample = dry * (1.0 - self.mix) + wet * self.mix;
        }
    }
}

struct Compressor {
    threshold_db: f32,
    knee_db: f32,
    ratio: f32,
    attack_coefficient: f32,
    release_coefficient: f32,
    makeup_gain: f32,
    mix: f32,
    envelope: f32,
}

impl Compressor {
    fn new(sample_rate: f32, config: &CompressorConfig) -> Self {
        Self {
            threshold_db: config.threshold_db,
            knee_db: config.knee_db,
            ratio: config.ratio,
            attack_coefficient: time_coefficient(sample_rate, config.attack_seconds),
            release_coefficient: time_coefficient(sample_rate, config.release_seconds),
            makeup_gain: decibels_to_gain(config.makeup_gain_db),
            mix: config.mix,
            envelope: 0.0,
        }
    }

    fn process_frame(&mut self, frame: &mut [f32]) {
        let peak = frame
            .iter()
            .fold(0.0_f32, |level, sample| level.max(sample.abs()));
        let coefficient = if peak > self.envelope {
            self.attack_coefficient
        } else {
            self.release_coefficient
        };
        self.envelope = coefficient * self.envelope + (1.0 - coefficient) * peak;
        let input_db = gain_to_decibels(self.envelope.max(1.0e-9));
        let output_db = compressed_level_db(input_db, self.threshold_db, self.knee_db, self.ratio);
        let gain = decibels_to_gain(output_db - input_db) * self.makeup_gain;
        for sample in frame {
            let dry = *sample;
            *sample = dry * (1.0 - self.mix) + dry * gain * self.mix;
        }
    }
}

struct Delay {
    buffers: Vec<Vec<f32>>,
    position: usize,
    feedback: f32,
    wet: f32,
    dry: f32,
}

impl Delay {
    fn new(sample_rate: f32, channels: usize, config: &DelayConfig) -> Self {
        let length = seconds_to_samples(sample_rate, config.delay_seconds).max(1);
        Self {
            buffers: vec![vec![0.0; length]; channels],
            position: 0,
            feedback: config.feedback,
            wet: config.wet,
            dry: config.dry,
        }
    }

    fn process_frame(&mut self, frame: &mut [f32]) {
        for (channel, sample) in frame.iter_mut().enumerate() {
            let delayed = self.buffers[channel][self.position];
            let input = *sample;
            self.buffers[channel][self.position] = input + delayed * self.feedback;
            *sample = input * self.dry + delayed * self.wet;
        }
        self.position = (self.position + 1) % self.buffers[0].len();
    }
}

struct CombFilter {
    buffers: Vec<Vec<f32>>,
    filtered: Vec<f32>,
    position: usize,
    feedback: f32,
    damping: f32,
}

impl CombFilter {
    fn new(channels: usize, length: usize, feedback: f32, damping: f32) -> Self {
        Self {
            buffers: vec![vec![0.0; length.max(1)]; channels],
            filtered: vec![0.0; channels],
            position: 0,
            feedback,
            damping,
        }
    }

    fn process(&mut self, input: &[f32], accumulation: &mut [f32]) {
        for channel in 0..input.len() {
            let delayed = self.buffers[channel][self.position];
            self.filtered[channel] =
                delayed * (1.0 - self.damping) + self.filtered[channel] * self.damping;
            self.buffers[channel][self.position] =
                input[channel] + self.filtered[channel] * self.feedback;
            accumulation[channel] += delayed;
        }
        self.position = (self.position + 1) % self.buffers[0].len();
    }
}

struct FrameDelay {
    buffers: Vec<Vec<f32>>,
    position: usize,
}

impl FrameDelay {
    fn new(channels: usize, length: usize) -> Option<Self> {
        (length > 0).then(|| Self {
            buffers: vec![vec![0.0; length]; channels],
            position: 0,
        })
    }

    fn process(&mut self, input: &[f32], output: &mut [f32]) {
        for channel in 0..input.len() {
            output[channel] = self.buffers[channel][self.position];
            self.buffers[channel][self.position] = input[channel];
        }
        self.position = (self.position + 1) % self.buffers[0].len();
    }
}

struct Reverb {
    pre_delay: Option<FrameDelay>,
    combs: Vec<CombFilter>,
    predelayed: Vec<f32>,
    accumulation: Vec<f32>,
    wet: f32,
    dry: f32,
}

impl Reverb {
    fn new(sample_rate: f32, channels: usize, config: &ReverbConfig) -> Self {
        let scale = 0.7 + config.room_size * 0.6;
        let feedback = 0.65 + config.room_size * 0.3;
        let combs = [0.0297_f32, 0.0371, 0.0411, 0.0437]
            .into_iter()
            .map(|seconds| {
                CombFilter::new(
                    channels,
                    seconds_to_samples(sample_rate, seconds * scale),
                    feedback,
                    config.damping,
                )
            })
            .collect();
        Self {
            pre_delay: FrameDelay::new(
                channels,
                seconds_to_samples(sample_rate, config.pre_delay_seconds),
            ),
            combs,
            predelayed: vec![0.0; channels],
            accumulation: vec![0.0; channels],
            wet: config.wet,
            dry: config.dry,
        }
    }

    fn process_frame(&mut self, frame: &mut [f32]) {
        if let Some(pre_delay) = &mut self.pre_delay {
            pre_delay.process(frame, &mut self.predelayed);
        } else {
            self.predelayed.copy_from_slice(frame);
        }
        self.accumulation.fill(0.0);
        for comb in &mut self.combs {
            comb.process(&self.predelayed, &mut self.accumulation);
        }
        let normalization = 0.25;
        for (sample, reverberated) in frame.iter_mut().zip(&self.accumulation) {
            *sample = *sample * self.dry + *reverberated * normalization * self.wet;
        }
    }
}

fn normalized_omega(sample_rate: f32, frequency_hz: f32) -> f32 {
    2.0 * PI * frequency_hz.min(sample_rate * 0.499) / sample_rate
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn seconds_to_samples(sample_rate: f32, seconds: f32) -> usize {
    (sample_rate * seconds).round().max(0.0) as usize
}

fn time_coefficient(sample_rate: f32, seconds: f32) -> f32 {
    if seconds == 0.0 {
        0.0
    } else {
        (-1.0 / (sample_rate * seconds)).exp()
    }
}

fn compressed_level_db(input_db: f32, threshold_db: f32, knee_db: f32, ratio: f32) -> f32 {
    if knee_db == 0.0 {
        return if input_db <= threshold_db {
            input_db
        } else {
            threshold_db + (input_db - threshold_db) / ratio
        };
    }
    let lower = threshold_db - knee_db / 2.0;
    let upper = threshold_db + knee_db / 2.0;
    if input_db < lower {
        input_db
    } else if input_db > upper {
        threshold_db + (input_db - threshold_db) / ratio
    } else {
        input_db + (1.0 / ratio - 1.0) * (input_db - lower).powi(2) / (2.0 * knee_db)
    }
}

fn gain_to_decibels(gain: f32) -> f32 {
    20.0 * gain.log10()
}

fn decibels_to_gain(decibels: f32) -> f32 {
    10.0_f32.powf(decibels / 20.0)
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
