//! Обязательные продуктовые регрессии из ТЗ на тех же входах, что и у прежних тестов.
use scoring_core::{PitchFrame, ScoreResult, Song, score_performance};
use serde_json::Value;
use std::collections::HashMap;

fn cases() -> HashMap<String, ScoreResult> {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/scoring/");
    let songs: HashMap<String, Song> =
        serde_json::from_str(&std::fs::read_to_string(format!("{root}songs.json")).unwrap()).unwrap();
    let all: Value = serde_json::from_str(&std::fs::read_to_string(format!("{root}score.json")).unwrap()).unwrap();
    all.as_array()
        .unwrap()
        .iter()
        .filter(|c| c["frames"].as_array().unwrap().iter().all(|f| f["t"].is_number() && !f["midi"].is_string()))
        .map(|c| {
            let frames: Vec<PitchFrame> = serde_json::from_value(c["frames"].clone()).unwrap();
            let song = &songs[c["song"].as_str().unwrap()];
            (c["name"].as_str().unwrap().to_owned(), score_performance(&frames, song))
        })
        .collect()
}

#[test]
fn product_regressions() {
    let r = cases();
    let perfect = r["perfect"].score;
    assert!(perfect >= 95.0);
    assert!(r["transpose +5"].score >= 95.0);
    assert!(r["transpose -7"].score >= 95.0);
    assert!(r["octave -12"].score >= 95.0);
    assert!(r["wrong noisy"].score < 50.0);
    assert!(r["silence"].score <= 30.0);
    assert!(r["constant note"].score <= 30.0);
    assert!(r["delay 200 ms"].score >= perfect - 5.0);
    assert!((r["delay 200 ms"].lag - 0.2).abs() < 0.005);
    assert!(r["vibrato 60 cents"].score >= perfect - 5.0);
    let drift = &r["key drift"];
    assert!(drift.axes.intervals > 0.95 && drift.axes.stability < 0.5);
    assert!(r["local timing 240 ms (legacy test)"].note_offsets.iter().any(|n| n.offset.abs() > 0.15));
    assert!(r["perfect"].moments.is_empty(), "идеальное исполнение без выдуманных ошибок");
}
