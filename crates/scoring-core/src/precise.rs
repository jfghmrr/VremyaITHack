//! Точная оценка исполнения по данным GPU-обработчика: кривая высоты из записи,
//! свидетельства о спетых словах и проверка проникновения гида из динамика.
//!
//! Основа — `score_performance` без изменений. Ось ритма становится «ритм и слова»:
//! половина прежнего ритма, половина оценки слов. Веса осей прежние. Сверху действуют
//! ограничения балла: прежние (покрытие, постоянная нота), гид в динамике и мычание.
use crate::config as c;
use crate::js;
use crate::math::{clamp01, mean, quality};
use crate::{PitchFrame, Song, ScoreResult, score_performance};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Метка алгоритма точной оценки; дуэли по-прежнему используют `ALGORITHM_VERSION`.
pub const PRECISE_ALGORITHM: &str = "precise-1";

/// Слово известного текста песни: порядковый номер и границы в секундах песни.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LyricWord {
    pub index: usize,
    pub start_s: f64,
    pub end_s: f64,
}

/// Свидетельство обработчика о слове: насколько оно спето (0..1) и когда началось.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct WordEvidence {
    pub index: usize,
    pub sung: f64,
    pub onset_s: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WordInput {
    pub words: Vec<LyricWord>,
    pub evidence: Vec<WordEvidence>,
}

/// Наибольшая нормированная корреляция записи с проигранными дорожками, 0..1.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bleed {
    pub instrumental: f64,
    pub guide: f64,
}

/// Причина ограничения балла.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Cap {
    Coverage,
    Constant,
    Bleed,
    Words,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreciseResult {
    /// Поля обычного результата; `axes.rhythm` уже включает слова, если они проверены.
    #[serde(flatten)]
    pub base: ScoreResult,
    pub algorithm: String,
    pub words_checked: bool,
    /// Доля слов текста, спетых с уверенностью от 0.5.
    pub words_sung: f64,
    /// Среднее по словам: спето × тайминг.
    pub words_score: f64,
    pub cap: Option<Cap>,
}

/// Значение 0..1; нечисловое считается нулём.
fn unit(x: f64) -> f64 {
    if x.is_finite() { clamp01(x) } else { 0.0 }
}

/// Тайминг слова после вычета общей задержки: 1 в пределах допуска, линейно до 0.
fn timing(word: &LyricWord, onset: Option<f64>, lag: f64) -> f64 {
    onset
        .filter(|t| t.is_finite())
        .map_or(0.0, |t| quality(t - lag - word.start_s, c::WORD_TIMING_TOL_S, c::WORD_TIMING_ZERO_S))
}

/// Доля спетых слов и оценка слов. Слово без свидетельства считается неспетым.
fn words_component(input: &WordInput, lag: f64) -> (f64, f64) {
    let evidence: HashMap<usize, &WordEvidence> = input.evidence.iter().map(|e| (e.index, e)).collect();
    let mut sung = 0usize;
    let scores: Vec<f64> = input
        .words
        .iter()
        .map(|w| {
            let Some(e) = evidence.get(&w.index) else { return 0.0 };
            let s = unit(e.sung);
            if s >= 0.5 {
                sung += 1;
            }
            s * timing(w, e.onset_s, lag)
        })
        .collect();
    (sung as f64 / input.words.len() as f64, mean(&scores))
}

/// Точная оценка. Без слов (`None` или пустой текст) и без проникновения гида
/// совпадает с `score_performance`.
pub fn score_precise(frames: &[PitchFrame], song: &Song, words: Option<&WordInput>, bleed: Option<&Bleed>) -> PreciseResult {
    let mut base = score_performance(frames, song);
    let checked = words.filter(|w| !w.words.is_empty());
    let (words_sung, words_score) = checked.map_or((0.0, 0.0), |w| words_component(w, base.lag));
    if checked.is_some() {
        base.axes.rhythm = 0.5 * base.axes.rhythm + 0.5 * words_score;
    }
    let a = base.axes;
    let raw = 100.0
        * (c::WEIGHT_INTERVALS * a.intervals
            + c::WEIGHT_RHYTHM * a.rhythm
            + c::WEIGHT_STABILITY * a.stability
            + c::WEIGHT_COVERAGE * a.coverage);

    // Ограничения применяются по порядку. Причиной считается самое строгое из сработавших;
    // при равных пределах — более позднее: гид в динамике объясняет и низкое покрытие,
    // и пропуск слов, а подсказка про наушники полезнее.
    let (mut limit, mut cap) = (f64::INFINITY, None);
    let mut apply = |hit: bool, value: f64, which: Cap| {
        if hit && value <= limit {
            limit = value;
            cap = Some(which);
        }
    };
    apply(a.coverage < c::COVERAGE_FLOOR, c::LOW_COVERAGE_CAP, Cap::Coverage);
    apply(a.coverage >= c::COVERAGE_FLOOR && base.constant_tone, c::LOW_COVERAGE_CAP, Cap::Constant);
    apply(bleed.is_some_and(|b| unit(b.guide) >= c::BLEED_GUIDE_THRESHOLD), c::BLEED_CAP, Cap::Bleed);
    apply(checked.is_some() && words_sung < c::WORDS_CAP_FRACTION, c::WORDS_CAP, Cap::Words);

    let score = if cap.is_some() { js::min(limit, raw) } else { raw };
    base.raw_score = score;
    base.score = js::round(score * 10.0) / 10.0;
    PreciseResult {
        base,
        algorithm: PRECISE_ALGORITHM.to_owned(),
        words_checked: checked.is_some(),
        words_sung,
        words_score,
        cap,
    }
}
