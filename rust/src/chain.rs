use crate::config::{
    DEFAULT_CONTROL_SMOOTHING_SECONDS, EffectConfig, EffectError, MAX_DSP_CHANNELS,
    MAX_DSP_SAMPLE_RATE, MAX_DSP_STATE_SAMPLES, validate_effect, validate_effect_chain,
};
use crate::dsp::{
    Biquad, Compressor, Delay, Equalizer, LinearRamp, Reverb, Saturation, seconds_to_samples,
};

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
