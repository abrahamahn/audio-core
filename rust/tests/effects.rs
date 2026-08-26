use audio_core::{
    CompressorConfig, DelayConfig, EffectChain, EffectConfig, EffectError, EqualizerBand,
    EqualizerBandKind, EqualizerConfig, FilterConfig, FilterKind, ReverbConfig, SaturationConfig,
    validate_effect_chain,
};

const SAMPLE_RATE: f32 = 1_000.0;

fn filter(id: &str, kind: FilterKind, frequency_hz: f32) -> EffectConfig {
    EffectConfig::Filter(FilterConfig {
        id: id.to_owned(),
        enabled: true,
        kind,
        frequency_hz,
        q: 0.707,
    })
}

#[test]
fn validates_complete_effect_contract_and_duplicate_ids() {
    let effects = vec![
        filter("hp", FilterKind::HighPass, 20.0),
        filter("lp", FilterKind::LowPass, 400.0),
        EffectConfig::Equalizer(EqualizerConfig {
            id: "eq".to_owned(),
            enabled: true,
            bands: vec![EqualizerBand {
                kind: EqualizerBandKind::Peaking,
                frequency_hz: 200.0,
                gain_db: 3.0,
                q: 1.0,
            }],
        }),
        EffectConfig::Saturation(SaturationConfig {
            id: "sat".to_owned(),
            enabled: true,
            drive: 3.0,
            mix: 0.5,
        }),
        EffectConfig::Compressor(CompressorConfig {
            id: "comp".to_owned(),
            enabled: true,
            threshold_db: -18.0,
            knee_db: 6.0,
            ratio: 4.0,
            attack_seconds: 0.003,
            release_seconds: 0.1,
            makeup_gain_db: 2.0,
            mix: 1.0,
        }),
        EffectConfig::Delay(DelayConfig {
            id: "delay".to_owned(),
            enabled: true,
            delay_seconds: 0.1,
            feedback: 0.3,
            wet: 0.2,
            dry: 1.0,
        }),
        EffectConfig::Reverb(ReverbConfig {
            id: "verb".to_owned(),
            enabled: true,
            room_size: 0.5,
            damping: 0.3,
            pre_delay_seconds: 0.01,
            wet: 0.2,
            dry: 1.0,
        }),
    ];
    assert!(validate_effect_chain(&effects).is_ok());
    assert_eq!(
        validate_effect_chain(&[
            filter("same", FilterKind::HighPass, 20.0),
            filter("same", FilterKind::LowPass, 400.0),
        ]),
        Err(EffectError::DuplicateId("same".to_owned()))
    );
}

#[test]
fn lowpass_attenuates_high_frequency_and_highpass_rejects_dc() {
    let mut low = EffectChain::new(SAMPLE_RATE, 1, &[filter("lp", FilterKind::LowPass, 50.0)])
        .expect("valid lowpass");
    let mut alternating: Vec<f32> = (0..1_000)
        .map(|index| if index % 2 == 0 { 1.0 } else { -1.0 })
        .collect();
    low.process_interleaved(&mut alternating)
        .expect("complete frames");
    let tail_energy: f32 = alternating[500..]
        .iter()
        .map(|sample| sample.abs())
        .sum::<f32>()
        / 500.0;
    assert!(
        tail_energy < 0.1,
        "unexpected lowpass energy: {tail_energy}"
    );

    let mut high = EffectChain::new(SAMPLE_RATE, 1, &[filter("hp", FilterKind::HighPass, 50.0)])
        .expect("valid highpass");
    let mut dc = vec![1.0; 1_000];
    high.process_interleaved(&mut dc).expect("complete frames");
    let tail = dc[900..].iter().map(|sample| sample.abs()).sum::<f32>() / 100.0;
    assert!(tail < 0.01, "unexpected highpass DC: {tail}");
}

#[test]
fn saturation_and_compression_are_bounded_and_effective() {
    let mut transparent = EffectChain::new(
        48_000.0,
        1,
        &[EffectConfig::Saturation(SaturationConfig {
            id: "transparent".to_owned(),
            enabled: true,
            drive: 0.0,
            mix: 1.0,
        })],
    )
    .expect("valid transparent saturation");
    let mut unchanged = [-0.75, 0.25, 1.5];
    transparent
        .process_interleaved(&mut unchanged)
        .expect("complete frames");
    assert!(
        unchanged
            .iter()
            .zip([-0.75, 0.25, 1.5])
            .all(|(actual, expected)| (*actual - expected).abs() < f32::EPSILON)
    );

    let mut saturation = EffectChain::new(
        48_000.0,
        1,
        &[EffectConfig::Saturation(SaturationConfig {
            id: "sat".to_owned(),
            enabled: true,
            drive: 20.0,
            mix: 1.0,
        })],
    )
    .expect("valid saturation");
    let mut samples = [-2.0, -0.5, 0.5, 2.0];
    saturation
        .process_interleaved(&mut samples)
        .expect("complete frames");
    assert!(samples.iter().all(|sample| sample.abs() <= 1.001));

    let mut compressor = EffectChain::new(
        SAMPLE_RATE,
        1,
        &[EffectConfig::Compressor(CompressorConfig {
            id: "comp".to_owned(),
            enabled: true,
            threshold_db: -20.0,
            knee_db: 0.0,
            ratio: 10.0,
            attack_seconds: 0.0,
            release_seconds: 0.1,
            makeup_gain_db: 0.0,
            mix: 1.0,
        })],
    )
    .expect("valid compressor");
    let mut loud = [1.0; 32];
    compressor
        .process_interleaved(&mut loud)
        .expect("complete frames");
    assert!(loud[31] < 0.2);
}

#[test]
fn equalizer_applies_ordered_shelf_and_peaking_bands() {
    let mut chain = EffectChain::new(
        SAMPLE_RATE,
        1,
        &[EffectConfig::Equalizer(EqualizerConfig {
            id: "eq".to_owned(),
            enabled: true,
            bands: vec![
                EqualizerBand {
                    kind: EqualizerBandKind::LowShelf,
                    frequency_hz: 100.0,
                    gain_db: 6.0,
                    q: 0.707,
                },
                EqualizerBand {
                    kind: EqualizerBandKind::Peaking,
                    frequency_hz: 250.0,
                    gain_db: -3.0,
                    q: 1.2,
                },
                EqualizerBand {
                    kind: EqualizerBandKind::HighShelf,
                    frequency_hz: 400.0,
                    gain_db: 1.0,
                    q: 0.707,
                },
            ],
        })],
    )
    .expect("valid equalizer");
    let phase_step = 2.0 * std::f32::consts::PI * 20.0 / SAMPLE_RATE;
    let mut phase = 0.0_f32;
    let mut low_tone: Vec<f32> = (0..1_000)
        .map(|_| {
            let sample = phase.sin() * 0.1;
            phase += phase_step;
            sample
        })
        .collect();
    let before = low_tone[500..]
        .iter()
        .map(|sample| sample * sample)
        .sum::<f32>();
    chain
        .process_interleaved(&mut low_tone)
        .expect("complete frames");
    let after = low_tone[500..]
        .iter()
        .map(|sample| sample * sample)
        .sum::<f32>();
    assert!(after > before * 2.0, "low shelf did not boost the low tone");
    assert!(low_tone.iter().all(|sample| sample.is_finite()));
}

#[test]
fn delay_and_reverb_create_bounded_tails_without_allocating_per_frame() {
    let mut delay = EffectChain::new(
        100.0,
        1,
        &[EffectConfig::Delay(DelayConfig {
            id: "delay".to_owned(),
            enabled: true,
            delay_seconds: 0.1,
            feedback: 0.5,
            wet: 1.0,
            dry: 0.0,
        })],
    )
    .expect("valid delay");
    let mut impulse = vec![0.0; 31];
    impulse[0] = 1.0;
    delay
        .process_interleaved(&mut impulse)
        .expect("complete frames");
    assert!((impulse[10] - 1.0).abs() < f32::EPSILON);
    assert!((impulse[20] - 0.5).abs() < f32::EPSILON);

    let mut reverb = EffectChain::new(
        SAMPLE_RATE,
        1,
        &[EffectConfig::Reverb(ReverbConfig {
            id: "verb".to_owned(),
            enabled: true,
            room_size: 0.5,
            damping: 0.2,
            pre_delay_seconds: 0.0,
            wet: 1.0,
            dry: 0.0,
        })],
    )
    .expect("valid reverb");
    let mut response = vec![0.0; 250];
    response[0] = 1.0;
    reverb
        .process_interleaved(&mut response)
        .expect("complete frames");
    assert!(response[20..].iter().any(|sample| sample.abs() > 0.01));
    assert!(response.iter().all(|sample| sample.is_finite()));
}

#[test]
fn rejects_partial_interleaved_frames() {
    let mut chain = EffectChain::new(SAMPLE_RATE, 2, &[filter("lp", FilterKind::LowPass, 200.0)])
        .expect("valid chain");
    assert_eq!(
        chain.process_interleaved(&mut [0.0, 0.0, 0.0]),
        Err(EffectError::InvalidBufferShape)
    );
    assert!(chain.set_enabled("lp", false));
    assert!(!chain.set_enabled("missing", false));
}
