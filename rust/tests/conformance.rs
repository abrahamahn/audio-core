use audio_core::{
    CompressorConfig, DelayConfig, EffectChain, EffectConfig, EqualizerBand, EqualizerBandKind,
    EqualizerConfig, FilterConfig, FilterKind, ReverbConfig, SaturationConfig,
    validate_effect_chain,
};
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BandVector {
    r#type: String,
    frequency_hz: f32,
    gain_db: f32,
    q: f32,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum EffectVector {
    Highpass {
        id: String,
        enabled: bool,
        frequency_hz: f32,
        q: f32,
    },
    Lowpass {
        id: String,
        enabled: bool,
        frequency_hz: f32,
        q: f32,
    },
    Equalizer {
        id: String,
        enabled: bool,
        bands: Vec<BandVector>,
    },
    Saturation {
        id: String,
        enabled: bool,
        drive: f32,
        mix: f32,
    },
    Compressor {
        id: String,
        enabled: bool,
        threshold_db: f32,
        knee_db: f32,
        ratio: f32,
        attack_seconds: f32,
        release_seconds: f32,
        makeup_gain_db: f32,
        mix: f32,
    },
    Reverb {
        id: String,
        enabled: bool,
        room_size: f32,
        damping: f32,
        pre_delay_seconds: f32,
        wet: f32,
        dry: f32,
    },
    Delay {
        id: String,
        enabled: bool,
        delay_seconds: f32,
        feedback: f32,
        wet: f32,
        dry: f32,
    },
}

#[derive(Deserialize)]
struct ChainVector {
    name: String,
    valid: bool,
    effects: Vec<EffectVector>,
}

#[derive(Deserialize)]
struct EffectFixture {
    profile: String,
    chains: Vec<ChainVector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderSample {
    frame: usize,
    value: f32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenderFixture {
    profile: String,
    sample_rate: f32,
    frame_count: usize,
    effects: Vec<EffectVector>,
    samples: Vec<RenderSample>,
}

fn equalizer_kind(kind: &str) -> EqualizerBandKind {
    match kind {
        "lowshelf" => EqualizerBandKind::LowShelf,
        "peaking" => EqualizerBandKind::Peaking,
        "highshelf" => EqualizerBandKind::HighShelf,
        _ => panic!("fixture contains an unsupported equalizer kind"),
    }
}

fn filter(id: String, enabled: bool, frequency_hz: f32, q: f32, kind: FilterKind) -> EffectConfig {
    EffectConfig::Filter(FilterConfig {
        id,
        enabled,
        kind,
        frequency_hz,
        q,
    })
}

fn effect(vector: EffectVector) -> EffectConfig {
    match vector {
        EffectVector::Highpass {
            id,
            enabled,
            frequency_hz,
            q,
        } => filter(id, enabled, frequency_hz, q, FilterKind::HighPass),
        EffectVector::Lowpass {
            id,
            enabled,
            frequency_hz,
            q,
        } => filter(id, enabled, frequency_hz, q, FilterKind::LowPass),
        EffectVector::Equalizer { id, enabled, bands } => {
            EffectConfig::Equalizer(EqualizerConfig {
                id,
                enabled,
                bands: bands
                    .into_iter()
                    .map(|band| EqualizerBand {
                        kind: equalizer_kind(&band.r#type),
                        frequency_hz: band.frequency_hz,
                        gain_db: band.gain_db,
                        q: band.q,
                    })
                    .collect(),
            })
        }
        EffectVector::Saturation {
            id,
            enabled,
            drive,
            mix,
        } => EffectConfig::Saturation(SaturationConfig {
            id,
            enabled,
            drive,
            mix,
        }),
        EffectVector::Compressor {
            id,
            enabled,
            threshold_db,
            knee_db,
            ratio,
            attack_seconds,
            release_seconds,
            makeup_gain_db,
            mix,
        } => EffectConfig::Compressor(CompressorConfig {
            id,
            enabled,
            threshold_db,
            knee_db,
            ratio,
            attack_seconds,
            release_seconds,
            makeup_gain_db,
            mix,
        }),
        EffectVector::Reverb {
            id,
            enabled,
            room_size,
            damping,
            pre_delay_seconds,
            wet,
            dry,
        } => EffectConfig::Reverb(ReverbConfig {
            id,
            enabled,
            room_size,
            damping,
            pre_delay_seconds,
            wet,
            dry,
        }),
        EffectVector::Delay {
            id,
            enabled,
            delay_seconds,
            feedback,
            wet,
            dry,
        } => EffectConfig::Delay(DelayConfig {
            id,
            enabled,
            delay_seconds,
            feedback,
            wet,
            dry,
        }),
    }
}

#[test]
fn effect_validation_matches_the_cross_language_conformance_corpus() {
    let fixture: EffectFixture =
        serde_json::from_str(include_str!("../fixtures/effects-v1.json")).unwrap();
    assert_eq!(fixture.profile, "audio-core-effects-v1");
    for vector in fixture.chains {
        let actual =
            validate_effect_chain(&vector.effects.into_iter().map(effect).collect::<Vec<_>>())
                .is_ok();
        assert_eq!(actual, vector.valid, "{}", vector.name);
    }
}

#[test]
fn native_dsp_matches_the_cross_runtime_render_corpus() {
    let fixture: RenderFixture =
        serde_json::from_str(include_str!("../fixtures/render-v1.json")).unwrap();
    assert_eq!(fixture.profile, "audio-core-render-v1");
    let effects = fixture.effects.into_iter().map(effect).collect::<Vec<_>>();
    let mut chain = EffectChain::new(fixture.sample_rate, 1, &effects).unwrap();
    let mut output = vec![0.0; fixture.frame_count];
    output[0] = 1.0;
    chain.process_interleaved(&mut output).unwrap();
    for sample in fixture.samples {
        assert!(
            (output[sample.frame] - sample.value).abs() <= 1.0e-6,
            "frame {}: expected {}, got {}",
            sample.frame,
            sample.value,
            output[sample.frame]
        );
    }
}
