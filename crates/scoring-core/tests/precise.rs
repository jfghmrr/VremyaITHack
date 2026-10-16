//! Точная оценка: слова, их тайминг и ограничения балла поверх `score_performance`.
use scoring_core::{Bleed, Cap, LyricWord, PRECISE_ALGORITHM, PitchFrame, Song, WordEvidence, WordInput, score_performance, score_precise};
use std::collections::HashMap;

fn song() -> Song {
    let path = format!("{}/../../fixtures/scoring/songs.json", env!("CARGO_MANIFEST_DIR"));
    let songs: HashMap<String, Song> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    songs["test"].clone()
}

/// Кадры, совпадающие с эталоном.
fn reference_frames(song: &Song) -> Vec<PitchFrame> {
    let hop = song.hop_ms / 1000.0;
    song.f0_midi.iter().enumerate().map(|(i, m)| PitchFrame { t: i as f64 * hop, midi: *m }).collect()
}

/// Слова по 0.6 с внутри каждой фразы.
fn lyric_words(song: &Song) -> Vec<LyricWord> {
    let mut words = Vec::new();
    for p in &song.phrases {
        let mut t = p.start_s;
        while t + 0.6 <= p.end_s {
            words.push(LyricWord { index: words.len(), start_s: t, end_s: t + 0.6 });
            t += 0.6;
        }
    }
    assert!(words.len() > 10);
    words
}

fn input(song: &Song, sung: f64, onset_shift: f64) -> WordInput {
    let words = lyric_words(song);
    let evidence = words.iter().map(|w| WordEvidence { index: w.index, sung, onset_s: Some(w.start_s + onset_shift) }).collect();
    WordInput { words, evidence }
}

#[test]
fn perfect_words_keep_score() {
    let s = song();
    let frames = reference_frames(&s);
    let base = score_performance(&frames, &s);
    let r = score_precise(&frames, &s, Some(&input(&s, 1.0, 0.0)), None);
    assert_eq!(r.algorithm, PRECISE_ALGORITHM);
    assert!(r.words_checked);
    assert!(r.words_score > 0.95, "words_score {}", r.words_score);
    assert_eq!(r.words_sung, 1.0);
    assert_eq!(r.cap, None);
    assert!((r.base.score - base.score).abs() <= 2.0, "{} vs {}", r.base.score, base.score);
}

#[test]
fn humming_capped_by_words() {
    let s = song();
    let frames = reference_frames(&s);
    let r = score_precise(&frames, &s, Some(&input(&s, 0.0, 0.0)), None);
    assert!(r.words_checked);
    assert_eq!(r.words_sung, 0.0);
    assert_eq!(r.cap, Some(Cap::Words));
    assert!(r.base.score <= 40.0, "score {}", r.base.score);
}

#[test]
fn late_words_lower_rhythm() {
    let s = song();
    let frames = reference_frames(&s);
    let perfect = score_precise(&frames, &s, Some(&input(&s, 1.0, 0.0)), None);
    let late = score_precise(&frames, &s, Some(&input(&s, 1.0, 0.5)), None);
    assert!(
        perfect.base.axes.rhythm - late.base.axes.rhythm > 0.15,
        "rhythm {} vs {}",
        perfect.base.axes.rhythm,
        late.base.axes.rhythm
    );
    assert_eq!(late.cap, None);
}

#[test]
fn guide_bleed_caps() {
    let s = song();
    let frames = reference_frames(&s);
    let r = score_precise(&frames, &s, Some(&input(&s, 1.0, 0.0)), Some(&Bleed { guide: 0.6, instrumental: 0.7 }));
    assert_eq!(r.cap, Some(Cap::Bleed));
    assert!(r.base.score <= 30.0, "score {}", r.base.score);
    let quiet = score_precise(&frames, &s, None, Some(&Bleed { guide: 0.2, instrumental: 0.9 }));
    assert_eq!(quiet.cap, None, "instrumental bleed alone does not cap");
}

#[test]
fn bleed_hint_survives_other_caps() {
    // Тихий певец, телефон играет гид: слов мало, но причина — динамик, а не мычание.
    let s = song();
    let frames = reference_frames(&s);
    let r = score_precise(&frames, &s, Some(&input(&s, 0.0, 0.0)), Some(&Bleed { guide: 0.8, instrumental: 0.8 }));
    assert_eq!(r.cap, Some(Cap::Bleed));
    assert!(r.base.score <= 30.0);
    let silent = score_precise(&[], &s, None, Some(&Bleed { guide: 0.8, instrumental: 0.8 }));
    assert_eq!(silent.cap, Some(Cap::Bleed));
    let silent = score_precise(&[], &s, None, None);
    assert_eq!(silent.cap, Some(Cap::Coverage));
}

#[test]
fn no_words_equals_base() {
    let s = song();
    let frames = reference_frames(&s);
    let base = score_performance(&frames, &s);
    let r = score_precise(&frames, &s, None, None);
    assert!(!r.words_checked);
    assert_eq!(r.base.score, base.score);
    assert_eq!(r.base.axes, base.axes);
    assert_eq!(r.base, base);
    let empty = WordInput { words: vec![], evidence: vec![] };
    assert!(!score_precise(&frames, &s, Some(&empty), None).words_checked);
}

#[test]
fn missing_evidence_counts_as_unsung() {
    let s = song();
    let frames = reference_frames(&s);
    let mut half = input(&s, 1.0, 0.0);
    let keep = half.words.len() / 2;
    half.evidence.truncate(keep);
    let r = score_precise(&frames, &s, Some(&half), None);
    let want = keep as f64 / half.words.len() as f64;
    assert!((r.words_sung - want).abs() < 1e-9);
    assert!((r.words_score - want).abs() < 1e-9);
}

#[test]
fn result_json_is_camel_case_and_flat() {
    let s = song();
    let frames = reference_frames(&s);
    let r = score_precise(&frames, &s, Some(&input(&s, 0.0, 0.0)), None);
    let v = serde_json::to_value(&r).unwrap();
    assert_eq!(v["algorithm"], "precise-1");
    assert_eq!(v["wordsChecked"], true);
    assert_eq!(v["cap"], "words");
    assert!(v["wordsSung"].is_number() && v["wordsScore"].is_number());
    assert!(v["score"].is_number() && v["axes"]["rhythm"].is_number() && v["rawScore"].is_number());
    assert!(v.get("base").is_none());
}
