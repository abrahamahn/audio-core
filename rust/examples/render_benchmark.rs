use std::hint::black_box;
use std::time::Instant;

use audio_core::{
    CompressorConfig, DelayConfig, EffectChain, EffectConfig, EqualizerBand, EqualizerBandKind,
    EqualizerConfig, FilterConfig, FilterKind, ReverbConfig, SaturationConfig,
};

const SAMPLE_RATE: usize = 48_000;
const SAMPLE_RATE_HZ: f32 = 48_000.0;
const CHANNELS: usize = 2;
const BLOCK_FRAMES: usize = 128;
const RENDER_SECONDS: usize = 30;
const RENDER_DURATION_SECONDS: f64 = 30.0;

fn main() {
    let effects = full_effect_chain();
    let mut chain = EffectChain::new(SAMPLE_RATE_HZ, CHANNELS, &effects).expect("valid chain");
    let mut block = vec![0.0_f32; BLOCK_FRAMES * CHANNELS];
    let block_count = SAMPLE_RATE * RENDER_SECONDS / BLOCK_FRAMES;
    let started = Instant::now();
    for block_index in 0..block_count {
        block.fill(0.0);
        if block_index % 100 == 0 {
            block[0] = 0.5;
            block[1] = -0.5;
        }
        chain
            .process_interleaved(black_box(&mut block))
            .expect("complete frames");
    }
    let elapsed = started.elapsed();
    let realtime_factor = RENDER_DURATION_SECONDS / elapsed.as_secs_f64();
    println!(
        "rendered {RENDER_SECONDS}s of stereo audio in {:.3}s ({realtime_factor:.1}x realtime)",
        elapsed.as_secs_f64()
    );
}

fn full_effect_chain() -> Vec<EffectConfig> {
    vec![
        EffectConfig::Filter(FilterConfig {
            id: "highpass".to_owned(),
            enabled: true,
            kind: FilterKind::HighPass,
            frequency_hz: 30.0,
            q: 0.707,
        }),
        EffectConfig::Equalizer(EqualizerConfig {
            id: "equalizer".to_owned(),
            enabled: true,
            bands: vec![
                EqualizerBand {
                    kind: EqualizerBandKind::LowShelf,
                    frequency_hz: 120.0,
                    gain_db: 2.0,
                    q: 0.707,
                },
                EqualizerBand {
                    kind: EqualizerBandKind::Peaking,
                    frequency_hz: 2_000.0,
                    gain_db: -1.5,
                    q: 1.0,
                },
                EqualizerBand {
                    kind: EqualizerBandKind::HighShelf,
                    frequency_hz: 10_000.0,
                    gain_db: 1.0,
                    q: 0.707,
                },
            ],
        }),
        EffectConfig::Saturation(SaturationConfig {
            id: "saturation".to_owned(),
            enabled: true,
            drive: 3.0,
            mix: 0.25,
        }),
        EffectConfig::Compressor(CompressorConfig {
            id: "compressor".to_owned(),
            enabled: true,
            threshold_db: -18.0,
            knee_db: 6.0,
            ratio: 3.0,
            attack_seconds: 0.003,
            release_seconds: 0.2,
            makeup_gain_db: 1.0,
            mix: 1.0,
        }),
        EffectConfig::Delay(DelayConfig {
            id: "delay".to_owned(),
            enabled: true,
            delay_seconds: 0.15,
            feedback: 0.3,
            wet: 0.15,
            dry: 1.0,
        }),
        EffectConfig::Reverb(ReverbConfig {
            id: "reverb".to_owned(),
            enabled: true,
            room_size: 0.5,
            damping: 0.4,
            pre_delay_seconds: 0.01,
            wet: 0.2,
            dry: 1.0,
        }),
    ]
}
