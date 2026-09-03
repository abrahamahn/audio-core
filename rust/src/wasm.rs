use wasm_bindgen::prelude::*;

use crate::{
    CompressorConfig, DelayConfig, EffectChain, EffectConfig, EqualizerBand, EqualizerBandKind,
    EqualizerConfig, FilterConfig, FilterKind, MAX_DSP_CHANNELS, ReverbConfig, SaturationConfig,
};

const MAX_BLOCK_FRAMES: usize = 4_096;

/// Allocation-bounded Wasm bridge for an AudioWorklet render quantum.
///
/// Configuration uses numeric builder calls so browser worklet globals do not need text codecs.
/// After `finalize`, JavaScript writes interleaved samples directly into the fixed buffer, calls
/// `process`, and copies the results back to Web Audio's planar output.
#[wasm_bindgen]
pub struct WasmEffectChain {
    sample_rate: f32,
    channels: usize,
    max_frames: usize,
    buffer: Vec<f32>,
    configs: Vec<EffectConfig>,
    pending_equalizer: Option<EqualizerConfig>,
    pending_equalizer_update: Option<(usize, EqualizerConfig)>,
    inner: Option<EffectChain>,
}

#[wasm_bindgen]
impl WasmEffectChain {
    /// Create an unfinalized fixed-capacity processor builder.
    #[must_use]
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32, channels: usize, max_frames: usize) -> Self {
        let dimensions_valid = channels > 0
            && channels <= MAX_DSP_CHANNELS
            && max_frames > 0
            && max_frames <= MAX_BLOCK_FRAMES;
        let sample_capacity = dimensions_valid
            .then(|| channels.checked_mul(max_frames))
            .flatten()
            .unwrap_or(0);
        Self {
            sample_rate,
            channels,
            max_frames,
            buffer: vec![0.0; sample_capacity],
            configs: Vec::new(),
            pending_equalizer: None,
            pending_equalizer_update: None,
            inner: None,
        }
    }

    pub fn add_filter(&mut self, enabled: bool, kind: u8, frequency_hz: f32, q: f32) -> bool {
        let Some(kind) = filter_kind(kind) else {
            return false;
        };
        self.push(EffectConfig::Filter(FilterConfig {
            id: self.next_id(),
            enabled,
            kind,
            frequency_hz,
            q,
        }))
    }

    pub fn begin_equalizer(&mut self, enabled: bool) -> bool {
        if !self.can_configure() || self.pending_equalizer.is_some() {
            return false;
        }
        self.pending_equalizer = Some(EqualizerConfig {
            id: self.next_id(),
            enabled,
            bands: Vec::new(),
        });
        true
    }

    pub fn add_equalizer_band(
        &mut self,
        kind: u8,
        frequency_hz: f32,
        gain_db: f32,
        q: f32,
    ) -> bool {
        let Some(kind) = equalizer_kind(kind) else {
            return false;
        };
        let Some(equalizer) = &mut self.pending_equalizer else {
            return false;
        };
        equalizer.bands.push(EqualizerBand {
            kind,
            frequency_hz,
            gain_db,
            q,
        });
        true
    }

    pub fn finish_equalizer(&mut self) -> bool {
        let Some(equalizer) = self.pending_equalizer.take() else {
            return false;
        };
        if equalizer.bands.is_empty() {
            return false;
        }
        self.push(EffectConfig::Equalizer(equalizer))
    }

    pub fn add_saturation(&mut self, enabled: bool, drive: f32, mix: f32) -> bool {
        self.push(EffectConfig::Saturation(SaturationConfig {
            id: self.next_id(),
            enabled,
            drive,
            mix,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_compressor(
        &mut self,
        enabled: bool,
        threshold_db: f32,
        knee_db: f32,
        ratio: f32,
        attack_seconds: f32,
        release_seconds: f32,
        makeup_gain_db: f32,
        mix: f32,
    ) -> bool {
        self.push(EffectConfig::Compressor(CompressorConfig {
            id: self.next_id(),
            enabled,
            threshold_db,
            knee_db,
            ratio,
            attack_seconds,
            release_seconds,
            makeup_gain_db,
            mix,
        }))
    }

    pub fn add_delay(
        &mut self,
        enabled: bool,
        delay_seconds: f32,
        feedback: f32,
        wet: f32,
        dry: f32,
    ) -> bool {
        self.push(EffectConfig::Delay(DelayConfig {
            id: self.next_id(),
            enabled,
            delay_seconds,
            feedback,
            wet,
            dry,
        }))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn add_reverb(
        &mut self,
        enabled: bool,
        room_size: f32,
        damping: f32,
        pre_delay_seconds: f32,
        wet: f32,
        dry: f32,
    ) -> bool {
        self.push(EffectConfig::Reverb(ReverbConfig {
            id: self.next_id(),
            enabled,
            room_size,
            damping,
            pre_delay_seconds,
            wet,
            dry,
        }))
    }

    /// Validate all effects and make the processor immutable except for bypass state.
    pub fn finalize(&mut self) -> bool {
        if !self.can_configure()
            || self.pending_equalizer.is_some()
            || self.buffer.is_empty()
            || self.inner.is_some()
        {
            return false;
        }
        let Ok(inner) = EffectChain::new(self.sample_rate, self.channels, &self.configs) else {
            return false;
        };
        self.inner = Some(inner);
        self.configs.clear();
        self.configs.shrink_to_fit();
        true
    }

    /// Byte offset of the fixed interleaved `f32` buffer in Wasm linear memory.
    #[must_use]
    #[wasm_bindgen(getter)]
    pub fn buffer_ptr(&self) -> usize {
        self.buffer.as_ptr() as usize
    }

    /// Total number of interleaved samples available in the fixed buffer.
    #[must_use]
    #[wasm_bindgen(getter)]
    pub fn buffer_len(&self) -> usize {
        self.buffer.len()
    }

    /// Process complete frames in place without allocating.
    pub fn process(&mut self, frame_count: usize) -> bool {
        let Some(inner) = &mut self.inner else {
            return false;
        };
        if frame_count > self.max_frames {
            return false;
        }
        let sample_count = frame_count * self.channels;
        inner
            .process_interleaved(&mut self.buffer[..sample_count])
            .is_ok()
    }

    /// Enable or bypass an effect by stable chain position without allocating.
    pub fn set_enabled_at(&mut self, index: usize, enabled: bool) -> bool {
        self.inner
            .as_mut()
            .is_some_and(|inner| inner.set_enabled_at(index, enabled))
    }

    /// Replace a filter configuration at a stable chain position.
    pub fn update_filter_at(
        &mut self,
        index: usize,
        enabled: bool,
        kind: u8,
        frequency_hz: f32,
        q: f32,
    ) -> bool {
        let Some(kind) = filter_kind(kind) else {
            return false;
        };
        self.apply_update(
            index,
            EffectConfig::Filter(FilterConfig {
                id: index.to_string(),
                enabled,
                kind,
                frequency_hz,
                q,
            }),
        )
    }

    /// Start replacing an equalizer configuration at a stable chain position.
    pub fn begin_equalizer_update(&mut self, index: usize, enabled: bool) -> bool {
        if self.inner.is_none()
            || self.pending_equalizer.is_some()
            || self.pending_equalizer_update.is_some()
        {
            return false;
        }
        self.pending_equalizer_update = Some((
            index,
            EqualizerConfig {
                id: index.to_string(),
                enabled,
                bands: Vec::new(),
            },
        ));
        true
    }

    /// Add one band to an in-progress equalizer replacement.
    pub fn add_equalizer_update_band(
        &mut self,
        kind: u8,
        frequency_hz: f32,
        gain_db: f32,
        q: f32,
    ) -> bool {
        let Some(kind) = equalizer_kind(kind) else {
            return false;
        };
        let Some((_, equalizer)) = &mut self.pending_equalizer_update else {
            return false;
        };
        equalizer.bands.push(EqualizerBand {
            kind,
            frequency_hz,
            gain_db,
            q,
        });
        true
    }

    /// Commit an in-progress equalizer replacement.
    pub fn finish_equalizer_update(&mut self) -> bool {
        let Some((index, equalizer)) = self.pending_equalizer_update.take() else {
            return false;
        };
        if equalizer.bands.is_empty() {
            return false;
        }
        self.apply_update(index, EffectConfig::Equalizer(equalizer))
    }

    /// Discard an invalid or interrupted equalizer replacement.
    pub fn cancel_equalizer_update(&mut self) {
        self.pending_equalizer_update = None;
    }

    /// Replace a saturation configuration at a stable chain position.
    pub fn update_saturation_at(
        &mut self,
        index: usize,
        enabled: bool,
        drive: f32,
        mix: f32,
    ) -> bool {
        self.apply_update(
            index,
            EffectConfig::Saturation(SaturationConfig {
                id: index.to_string(),
                enabled,
                drive,
                mix,
            }),
        )
    }

    /// Replace a compressor configuration at a stable chain position.
    #[allow(clippy::too_many_arguments)]
    pub fn update_compressor_at(
        &mut self,
        index: usize,
        enabled: bool,
        threshold_db: f32,
        knee_db: f32,
        ratio: f32,
        attack_seconds: f32,
        release_seconds: f32,
        makeup_gain_db: f32,
        mix: f32,
    ) -> bool {
        self.apply_update(
            index,
            EffectConfig::Compressor(CompressorConfig {
                id: index.to_string(),
                enabled,
                threshold_db,
                knee_db,
                ratio,
                attack_seconds,
                release_seconds,
                makeup_gain_db,
                mix,
            }),
        )
    }

    /// Replace a delay configuration at a stable chain position.
    #[allow(clippy::too_many_arguments)]
    pub fn update_delay_at(
        &mut self,
        index: usize,
        enabled: bool,
        delay_seconds: f32,
        feedback: f32,
        wet: f32,
        dry: f32,
    ) -> bool {
        self.apply_update(
            index,
            EffectConfig::Delay(DelayConfig {
                id: index.to_string(),
                enabled,
                delay_seconds,
                feedback,
                wet,
                dry,
            }),
        )
    }

    /// Replace a reverb configuration at a stable chain position.
    #[allow(clippy::too_many_arguments)]
    pub fn update_reverb_at(
        &mut self,
        index: usize,
        enabled: bool,
        room_size: f32,
        damping: f32,
        pre_delay_seconds: f32,
        wet: f32,
        dry: f32,
    ) -> bool {
        self.apply_update(
            index,
            EffectConfig::Reverb(ReverbConfig {
                id: index.to_string(),
                enabled,
                room_size,
                damping,
                pre_delay_seconds,
                wet,
                dry,
            }),
        )
    }
}

impl WasmEffectChain {
    fn next_id(&self) -> String {
        self.configs.len().to_string()
    }

    fn can_configure(&self) -> bool {
        self.inner.is_none() && self.pending_equalizer_update.is_none()
    }

    fn push(&mut self, config: EffectConfig) -> bool {
        if !self.can_configure() || self.pending_equalizer.is_some() {
            return false;
        }
        self.configs.push(config);
        true
    }

    fn apply_update(&mut self, index: usize, config: EffectConfig) -> bool {
        self.inner
            .as_mut()
            .is_some_and(|inner| inner.update_effect_at(index, config).unwrap_or(false))
    }
}

/// Return the instance memory so the worklet can retain a zero-copy typed-array view.
#[wasm_bindgen(js_name = wasmMemory)]
pub fn wasm_memory() -> JsValue {
    wasm_bindgen::memory()
}

fn filter_kind(value: u8) -> Option<FilterKind> {
    match value {
        0 => Some(FilterKind::HighPass),
        1 => Some(FilterKind::LowPass),
        _ => None,
    }
}

fn equalizer_kind(value: u8) -> Option<EqualizerBandKind> {
    match value {
        0 => Some(EqualizerBandKind::LowShelf),
        1 => Some(EqualizerBandKind::Peaking),
        2 => Some(EqualizerBandKind::HighShelf),
        _ => None,
    }
}
