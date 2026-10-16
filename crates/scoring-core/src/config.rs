//! Пороги и веса оценки. Значения перенесены без изменений из `legacy/src/config.ts` (тег `legacy-react-fastify`).

pub const MAX_LAG: f64 = 0.3;
pub const SHIFT_WINDOW: f64 = 4.0;
pub const DTW_BAND: f64 = 0.4;
pub const INTERVAL_GOOD: f64 = 0.3;
pub const INTERVAL_BAD: f64 = 1.5;
pub const RHYTHM_GOOD: f64 = 0.08;
pub const RHYTHM_BAD: f64 = 0.3;
pub const SMOOTHING_SECONDS: f64 = 0.15;
pub const LONG_NOTE_SECONDS: f64 = 0.3;
pub const REFERENCE_NOTE_TOLERANCE: f64 = 0.5;
pub const STABILITY_GOOD: f64 = 0.12;
pub const STABILITY_BAD: f64 = 0.8;
pub const DRIFT_BAD: f64 = 3.0;
pub const DRIFT_PENALTY: f64 = 0.85;
pub const COVERAGE_FLOOR: f64 = 0.3;
pub const LOW_COVERAGE_CAP: f64 = 30.0;
pub const CONSTANT_SPREAD: f64 = 0.18;
pub const REFERENCE_SPREAD: f64 = 0.8;
pub const ONSET_JUMP: f64 = 0.7;
pub const ONSET_DEBOUNCE: f64 = 0.12;
pub const WEIGHT_INTERVALS: f64 = 0.45;
pub const WEIGHT_RHYTHM: f64 = 0.25;
pub const WEIGHT_STABILITY: f64 = 0.15;
pub const WEIGHT_COVERAGE: f64 = 0.15;

// Точная оценка (`precise.rs`). Значения выбраны для защиты 2026-10-17 и требуют
// калибровки на живых певцах.
/// Допуск начала слова после вычета общей задержки, секунды: тайминг 1.
pub const WORD_TIMING_TOL_S: f64 = 0.20;
/// Отклонение начала слова, при котором тайминг падает до 0, секунды.
pub const WORD_TIMING_ZERO_S: f64 = 0.60;
/// Если спето меньше этой доли слов, балл ограничен `WORDS_CAP` (мычание вместо слов).
pub const WORDS_CAP_FRACTION: f64 = 0.30;
pub const WORDS_CAP: f64 = 40.0;
/// Корреляция записи с гид-вокалом, начиная с которой считается, что пел динамик.
pub const BLEED_GUIDE_THRESHOLD: f64 = 0.45;
pub const BLEED_CAP: f64 = 30.0;

/// Шаг канонической кривой дуэли и живого матча, секунды.
pub const CANONICAL_HOP: f64 = 0.05;
