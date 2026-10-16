//! Тонкие привязки `scoring-core` для браузера. Данные передаются JSON-строками:
//! это проще типизированных буферов, а разбор занимает доли миллисекунды по сравнению
//! с самой оценкой. Нечисловые кадры отбрасывает обёртка на стороне JS до сериализации,
//! так же как это делает ядро для native-вызовов.
use scoring_core::{PitchFrame, ScoreResult, Song};
use wasm_bindgen::prelude::*;

fn parse<'a, T: serde::Deserialize<'a>>(what: &str, json: &'a str) -> Result<T, JsError> {
    serde_json::from_str(json).map_err(|e| JsError::new(&format!("{what}: {e}")))
}

fn json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("результат всегда сериализуется")
}

#[wasm_bindgen(js_name = algorithmVersion)]
pub fn algorithm_version() -> u32 {
    scoring_core::ALGORITHM_VERSION
}

#[wasm_bindgen]
pub fn score(frames: &str, song: &str) -> Result<String, JsError> {
    let frames: Vec<PitchFrame> = parse("frames", frames)?;
    let song: Song = parse("song", song)?;
    Ok(json(&scoring_core::score_performance(&frames, &song)))
}

#[wasm_bindgen(js_name = canonicalCurve)]
pub fn canonical_curve(frames: &str, duration: f64) -> Result<String, JsError> {
    let frames: Vec<PitchFrame> = parse("frames", frames)?;
    Ok(json(&scoring_core::canonical_curve(&frames, duration)))
}

#[wasm_bindgen(js_name = correctionCurve)]
pub fn correction_curve(frames: &str, song: &str, result: &str) -> Result<String, JsError> {
    let frames: Vec<PitchFrame> = parse("frames", frames)?;
    let song: Song = parse("song", song)?;
    let result: ScoreResult = parse("result", result)?;
    Ok(json(&scoring_core::correction_curve(&frames, &song, &result)))
}

#[wasm_bindgen]
pub fn outcome(a: f64, b: f64) -> String {
    json(&scoring_core::outcome(a, b)).trim_matches('"').to_owned()
}
