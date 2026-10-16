//! Общее ядро оценки Перепева.
//!
//! Чистые функции без DOM, Web Audio, HTTP и базы данных. Одна реализация
//! используется сервером как обычная библиотека и браузером через `scoring-wasm`.
//! Поведение совпадает с прежней TypeScript-версией бит в бит; это проверяют
//! эталонные примеры в `fixtures/scoring`.

mod alignment;
pub mod config;
mod curve;
mod js;
mod math;
mod precise;
mod score;

pub use curve::{
    CorrectionPoint, Outcome, canonical_curve, correction_curve, dequantize, outcome, quantize,
};
pub use precise::{
    Bleed, Cap, LyricWord, PRECISE_ALGORITHM, PreciseResult, WordEvidence, WordInput, score_precise,
};
pub use score::score_performance;

/// Версия алгоритма оценки. Меняется при любом изменении результата; обе стороны
/// матча и сохранённые результаты ссылаются на неё.
pub const ALGORITHM_VERSION: u32 = 1;
use serde::{Deserialize, Serialize};

/// Кадр высоты: время в секундах от начала песни, MIDI-высота или пауза.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PitchFrame {
    pub t: f64,
    pub midi: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Phrase {
    pub start_s: f64,
    pub end_s: f64,
}

/// Поля эталона, нужные для оценки. Остальные поля `reference.json` игнорируются.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Song {
    pub hop_ms: f64,
    pub duration_s: f64,
    pub f0_midi: Vec<Option<f64>>,
    #[serde(default)]
    pub phrases: Vec<Phrase>,
}

pub(crate) fn phrases_or_whole(song: &Song) -> Vec<Phrase> {
    if song.phrases.is_empty() {
        vec![Phrase { start_s: 0.0, end_s: song.duration_s }]
    } else {
        song.phrases.clone()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct Axes {
    pub intervals: f64,
    pub rhythm: f64,
    pub stability: f64,
    pub coverage: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Reason {
    Pitch,
    Rhythm,
    Missing,
}

/// Проблемный момент: окно до 2 секунд внутри фразы с объяснением.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Moment {
    pub start_s: f64,
    pub end_s: f64,
    pub phrase: usize,
    pub loss: f64,
    pub reason: Reason,
    pub text: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PhraseResult {
    pub start_s: f64,
    pub end_s: f64,
    pub score: f64,
    pub shift: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SecondSummary {
    pub t: f64,
    pub error: f64,
    pub coverage: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct NoteOffset {
    pub t: f64,
    pub offset: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreResult {
    /// Канонический балл, округлённый до 0.1.
    pub score: f64,
    /// Исходное значение до округления, для анализа.
    pub raw_score: f64,
    pub axes: Axes,
    pub lag: f64,
    pub shift: f64,
    pub register_shift: f64,
    pub shift_curve: Vec<f64>,
    pub errors: Vec<Option<f64>>,
    pub seconds: Vec<SecondSummary>,
    pub phrases: Vec<PhraseResult>,
    pub moments: Vec<Moment>,
    pub note_offsets: Vec<NoteOffset>,
    pub constant_tone: bool,
}
