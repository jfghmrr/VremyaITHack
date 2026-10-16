use crate::alignment::{prepare, resample};
use crate::config::CANONICAL_HOP;
use crate::js;
use crate::math::{clamp, smooth};
use crate::{PitchFrame, ScoreResult, Song};
use serde::{Deserialize, Serialize};

/// Каноническая кривая дуэли: сетка 50 мс, высота с точностью 0.1 полутона.
/// Обе стороны дуэли и живого матча оцениваются по этой кривой.
pub fn canonical_curve(frames: &[PitchFrame], duration: f64) -> Vec<PitchFrame> {
    let sorted = prepare(frames);
    let length = (duration / CANONICAL_HOP).ceil() as usize;
    resample(&sorted, length, CANONICAL_HOP, 0.0)
        .into_iter()
        .enumerate()
        .map(|(i, m)| PitchFrame {
            t: i as f64 * CANONICAL_HOP,
            midi: m.map(|m| js::round(m * 10.0) / 10.0),
        })
        .collect()
}

/// Высота в десятых долях полутона, как в ссылке-вызове и пакетах живого матча.
pub fn quantize(midi: Option<f64>) -> Option<i16> {
    midi.map(|m| js::round(m * 10.0) as i16)
}

/// Восстанавливает каноническую кривую из десятых долей полутона.
pub fn dequantize(values: &[Option<i16>]) -> Vec<PitchFrame> {
    values
        .iter()
        .enumerate()
        .map(|(i, q)| PitchFrame { t: i as f64 * CANONICAL_HOP, midi: q.map(|q| q as f64 / 10.0) })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Win,
    Draw,
    Loss,
}

/// Исход для первого участника. Оба итога округляются до двух знаков; равные значения
/// означают ничью. Канонический балл уже округлён до 0.1, поэтому правило совпадает
/// с прежней дуэлью и не объявляет победителя по скрытой разнице.
pub fn outcome(a: f64, b: f64) -> Outcome {
    if js::round(a * 100.0) == js::round(b * 100.0) {
        Outcome::Draw
    } else if a > b {
        Outcome::Win
    } else {
        Outcome::Loss
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CorrectionPoint {
    pub t: f64,
    pub pitch: Option<f64>,
    pub target: Option<f64>,
}

/// Поправка высоты для «Мой голос (эксперимент)»: к регистру певца, не к исходной тональности.
pub fn correction_curve(frames: &[PitchFrame], song: &Song, result: &ScoreResult) -> Vec<CorrectionPoint> {
    let sorted = prepare(frames);
    let user = resample(&sorted, song.f0_midi.len(), song.hop_ms / 1000.0, result.lag);
    let raw: Vec<Option<f64>> = song
        .f0_midi
        .iter()
        .zip(&user)
        .zip(&result.shift_curve)
        .map(|((r, u), s)| match (r, u) {
            (Some(r), Some(u)) => Some(clamp(r + s - u, -12.0, 12.0)),
            _ => None,
        })
        .collect();
    smooth(&raw, 3)
        .into_iter()
        .step_by(2)
        .enumerate()
        .map(|(i, pitch)| CorrectionPoint {
            t: i as f64 * 0.02,
            pitch,
            target: song.f0_midi[i * 2].map(|r| r + result.shift_curve[i * 2]),
        })
        .collect()
}
