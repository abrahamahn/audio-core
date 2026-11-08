#![forbid(unsafe_code)]

mod chain;
mod config;
mod dsp;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
mod wasm;

pub use chain::EffectChain;
pub use config::{
    CompressorConfig, DEFAULT_CONTROL_SMOOTHING_SECONDS, DelayConfig, EffectConfig, EffectError,
    EqualizerBand, EqualizerBandKind, EqualizerConfig, FilterConfig, FilterKind, MAX_DSP_CHANNELS,
    MAX_DSP_EFFECTS, MAX_DSP_SAMPLE_RATE, MAX_DSP_STATE_SAMPLES, ReverbConfig, SaturationConfig,
    validate_effect, validate_effect_chain,
};
