//! Сверка с эталонами из прежней TypeScript-реализации (`tools/fixtures/generate.ts`).
//! Допуск нулевой: оценка использует только операции IEEE-754 с точным округлением
//! (+, -, *, /, sqrt, floor, ceil, %) в том же порядке, поэтому результат обязан
//! совпадать бит в бит. Единственное послабление: -0 и +0 считаются равными.
use scoring_core::{PitchFrame, ScoreResult, Song, canonical_curve, correction_curve, outcome, score_performance};
use serde_json::Value;
use std::collections::HashMap;

fn load(name: &str) -> Value {
    let path = format!("{}/../../fixtures/scoring/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn num(v: &Value) -> Option<f64> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            _ => panic!("unexpected {s}"),
        }),
        v => Some(v.as_f64().unwrap()),
    }
}

fn frames(v: &Value) -> Vec<PitchFrame> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|f| PitchFrame { t: num(&f["t"]).unwrap(), midi: num(&f["midi"]) })
        .collect()
}

fn same(path: &str, want: &Value, got: &Value, diffs: &mut Vec<String>) {
    match (want, got) {
        (Value::Number(a), Value::Number(b)) => {
            if a.as_f64().unwrap() != b.as_f64().unwrap() {
                diffs.push(format!("{path}: want {a} got {b}"));
            }
        }
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            for (i, (x, y)) in a.iter().zip(b).enumerate() {
                same(&format!("{path}[{i}]"), x, y, diffs);
            }
        }
        (Value::Object(a), Value::Object(b)) if a.len() == b.len() => {
            for (k, x) in a {
                match b.get(k) {
                    Some(y) => same(&format!("{path}.{k}"), x, y, diffs),
                    None => diffs.push(format!("{path}.{k}: missing")),
                }
            }
        }
        (a, b) if a == b => {}
        (a, b) => diffs.push(format!("{path}: want {a} got {b}")),
    }
}

/// Прежний результат не содержал `rawScore`; поле добавлено и проверяется отдельно.
fn result_json(r: ScoreResult) -> Value {
    assert_eq!(js_round1(r.raw_score), r.score);
    let mut v = serde_json::to_value(r).unwrap();
    v.as_object_mut().unwrap().remove("rawScore");
    v
}

fn js_round1(x: f64) -> f64 {
    let f = (x * 10.0).floor();
    (if x * 10.0 - f >= 0.5 { f + 1.0 } else { f }) / 10.0
}

fn songs() -> HashMap<String, Song> {
    serde_json::from_value(load("songs.json")).unwrap()
}

#[test]
fn score_matches_legacy() {
    let songs = songs();
    let mut failed = Vec::new();
    for case in load("score.json").as_array().unwrap() {
        let song = &songs[case["song"].as_str().unwrap()];
        let got = result_json(score_performance(&frames(&case["frames"]), song));
        let mut diffs = Vec::new();
        same("", &case["expected"], &got, &mut diffs);
        if !diffs.is_empty() {
            failed.push(format!("{}: {}", case["name"], diffs[..diffs.len().min(3)].join("; ")));
        }
    }
    assert!(failed.is_empty(), "{} cases differ:\n{}", failed.len(), failed.join("\n"));
}

#[test]
fn duel_path_matches_legacy() {
    let songs = songs();
    let mut failed = Vec::new();
    for case in load("duel.json").as_array().unwrap() {
        let song = &songs[case["song"].as_str().unwrap()];
        let curve = canonical_curve(&frames(&case["frames"]), song.duration_s);
        let mut diffs = Vec::new();
        same("curve", &case["curve"], &serde_json::to_value(&curve).unwrap(), &mut diffs);
        let got = result_json(score_performance(&curve, song));
        same("", &case["expected"], &got, &mut diffs);
        if !diffs.is_empty() {
            failed.push(format!("{}: {}", case["name"], diffs[..diffs.len().min(3)].join("; ")));
        }
    }
    assert!(failed.is_empty(), "{} cases differ:\n{}", failed.len(), failed.join("\n"));
}

#[test]
fn match_outcomes_match_legacy() {
    let songs = songs();
    let scores: HashMap<String, f64> = load("duel.json")
        .as_array()
        .unwrap()
        .iter()
        .map(|c| {
            let song = &songs[c["song"].as_str().unwrap()];
            let curve = canonical_curve(&frames(&c["frames"]), song.duration_s);
            (c["name"].as_str().unwrap().to_owned(), score_performance(&curve, song).score)
        })
        .collect();
    for p in load("pairs.json").as_array().unwrap() {
        let got = outcome(scores[p["a"].as_str().unwrap()], scores[p["b"].as_str().unwrap()]);
        assert_eq!(serde_json::to_value(got).unwrap(), p["outcome"], "{} vs {}", p["a"], p["b"]);
    }
}

#[test]
fn correction_matches_legacy() {
    let songs = songs();
    for case in load("correction.json").as_array().unwrap() {
        let song = &songs[case["song"].as_str().unwrap()];
        let f = frames(&case["frames"]);
        let got = serde_json::to_value(correction_curve(&f, song, &score_performance(&f, song))).unwrap();
        let mut diffs = Vec::new();
        same("", &case["expected"], &got, &mut diffs);
        assert!(diffs.is_empty(), "{}: {:?}", case["name"], &diffs[..diffs.len().min(3)]);
    }
}
