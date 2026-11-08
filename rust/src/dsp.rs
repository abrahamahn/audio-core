use std::f32::consts::PI;

use crate::config::{
    CompressorConfig, DelayConfig, EqualizerBand, EqualizerBandKind, FilterKind, ReverbConfig,
};

pub(crate) struct LinearRamp {
    current: f32,
    target: f32,
    step: f32,
    remaining: usize,
}

impl LinearRamp {
    pub(crate) fn new(value: f32) -> Self {
        Self {
            current: value,
            target: value,
            step: 0.0,
            remaining: 0,
        }
    }

    pub(crate) fn transition(frames: usize) -> Self {
        let mut ramp = Self::new(0.0);
        ramp.set_target(1.0, frames);
        ramp
    }

    #[allow(clippy::cast_precision_loss)]
    pub(crate) fn set_target(&mut self, target: f32, frames: usize) {
        self.target = target;
        self.remaining = frames.max(1);
        self.step = (target - self.current) / self.remaining as f32;
    }

    pub(crate) fn next(&mut self) -> f32 {
        if self.remaining > 0 {
            self.current += self.step;
            self.remaining -= 1;
            if self.remaining == 0 {
                self.current = self.target;
            }
        }
        self.current
    }

    pub(crate) fn finished(&self) -> bool {
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

pub(crate) struct Biquad {
    coefficients: Coefficients,
    states: Vec<BiquadState>,
}

impl Biquad {
    pub(crate) fn filter(
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

    pub(crate) fn equalizer(channels: usize, sample_rate: f32, band: EqualizerBand) -> Self {
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

    pub(crate) fn process_frame(&mut self, frame: &mut [f32]) {
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

pub(crate) struct Equalizer {
    bands: Vec<Biquad>,
}

impl Equalizer {
    pub(crate) fn new(channels: usize, sample_rate: f32, bands: &[EqualizerBand]) -> Self {
        Self {
            bands: bands
                .iter()
                .copied()
                .map(|band| Biquad::equalizer(channels, sample_rate, band))
                .collect(),
        }
    }

    pub(crate) fn process_frame(&mut self, frame: &mut [f32]) {
        for band in &mut self.bands {
            band.process_frame(frame);
        }
    }
}

pub(crate) struct Saturation {
    amount: f32,
    normalization: f32,
    mix: f32,
    transparent: bool,
}

impl Saturation {
    pub(crate) fn new(drive: f32, mix: f32) -> Self {
        let amount = 1.0 + drive * 0.25;
        Self {
            amount,
            normalization: amount.tanh(),
            mix,
            transparent: drive == 0.0,
        }
    }

    pub(crate) fn process_frame(&self, frame: &mut [f32]) {
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

pub(crate) struct Compressor {
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
    pub(crate) fn new(sample_rate: f32, config: &CompressorConfig) -> Self {
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

    pub(crate) fn process_frame(&mut self, frame: &mut [f32]) {
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

pub(crate) struct Delay {
    buffers: Vec<Vec<f32>>,
    position: usize,
    feedback: f32,
    wet: f32,
    dry: f32,
}

impl Delay {
    pub(crate) fn new(sample_rate: f32, channels: usize, config: &DelayConfig) -> Self {
        let length = seconds_to_samples(sample_rate, config.delay_seconds).max(1);
        Self {
            buffers: vec![vec![0.0; length]; channels],
            position: 0,
            feedback: config.feedback,
            wet: config.wet,
            dry: config.dry,
        }
    }

    pub(crate) fn process_frame(&mut self, frame: &mut [f32]) {
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

pub(crate) struct Reverb {
    pre_delay: Option<FrameDelay>,
    combs: Vec<CombFilter>,
    predelayed: Vec<f32>,
    accumulation: Vec<f32>,
    wet: f32,
    dry: f32,
}

impl Reverb {
    pub(crate) fn new(sample_rate: f32, channels: usize, config: &ReverbConfig) -> Self {
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

    pub(crate) fn process_frame(&mut self, frame: &mut [f32]) {
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
pub(crate) fn seconds_to_samples(sample_rate: f32, seconds: f32) -> usize {
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
