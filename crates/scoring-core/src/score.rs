use crate::alignment::{find_lag, prepare, resample, rhythm_offsets};
use crate::config as c;
use crate::js;
use crate::math::{circular_median, clamp01, mean, median, quality, smooth, wrap};
use crate::{
    Axes, Moment, PhraseResult, PitchFrame, Reason, ScoreResult, SecondSummary, Song,
    phrases_or_whole,
};

fn interval_quality(e: Option<f64>) -> f64 {
    e.map_or(0.0, |e| quality(e, c::INTERVAL_GOOD, c::INTERVAL_BAD))
}

fn abs_error(e: Option<f64>) -> f64 {
    e.map_or(1.5, f64::abs)
}

/// Детерминированная оценка исполнения относительно эталона, независимая от тональности.
pub fn score_performance(frames: &[PitchFrame], song: &Song) -> ScoreResult {
    let hop = song.hop_ms / 1000.0;
    let reference = &song.f0_midi;
    let len = reference.len();
    let sorted = prepare(frames);
    let lag = find_lag(&sorted, reference, hop);
    let user = resample(&sorted, len, hop, lag);
    let phrases = phrases_or_whole(song);
    let at = |i: usize| i as f64 * hop;

    // Локальная тональность каждые 100 мс по окну до 4 секунд, не пересекая паузы фраз.
    let mut shift_curve = vec![0.0; len];
    let half_window = js::round(c::SHIFT_WINDOW / 2.0 / hop);
    for i in (0..len).step_by(10) {
        let t = at(i);
        let phrase = phrases.iter().find(|p| t >= p.start_s && t <= p.end_s);
        let lo = js::max(
            js::max(0.0, (phrase.map_or(0.0, |p| p.start_s) / hop).ceil()),
            i as f64 - half_window,
        );
        let hi = js::min(
            js::min(len as f64, (phrase.map_or(song.duration_s, |p| p.end_s) / hop).floor() + 1.0),
            i as f64 + half_window,
        );
        let mut ds = Vec::new();
        let mut j = lo;
        while j < hi {
            let k = j as usize;
            if let (Some(r), Some(u)) = (reference[k], user[k]) {
                ds.push(u - r);
            }
            j += 2.0;
        }
        let key = circular_median(&ds);
        let octaves: Vec<f64> = ds.iter().map(|d| (d - key) / 12.0).collect();
        let full = key + 12.0 * js::round(median(&octaves));
        shift_curve[i..(i + 10).min(len)].fill(full);
    }

    let raw: Vec<Option<f64>> = (0..len)
        .map(|i| match (reference[i], user[i]) {
            (Some(r), Some(u)) => Some(u - r - shift_curve[i]),
            _ => None,
        })
        .collect();
    // Сглаживается остаточная ошибка, а не мелодия: переходы остаются, вибрато ослабляется.
    let errors = smooth(&raw, js::round(c::SMOOTHING_SECONDS / 2.0 / hop) as usize);

    let (mut voiced, mut covered) = (0usize, 0usize);
    let mut iq = Vec::new();
    for i in 0..len {
        if reference[i].is_none() {
            continue;
        }
        voiced += 1;
        if user[i].is_some() {
            covered += 1;
        }
        iq.push(interval_quality(errors[i]));
    }
    let coverage = covered as f64 / voiced.max(1) as f64;
    let note_offsets = rhythm_offsets(reference, &user, &shift_curve, hop);
    let rhythm = if coverage == 0.0 {
        0.0
    } else {
        let offsets: Vec<f64> = note_offsets.iter().map(|n| n.offset.abs()).collect();
        quality(median(&offsets), c::RHYTHM_GOOD, c::RHYTHM_BAD) * js::min(1.0, coverage / 0.8)
    };

    let indices_in = |from: f64, to: f64| -> Vec<usize> {
        (0..len).filter(|&i| at(i) >= from && at(i) < to && reference[i].is_some()).collect()
    };
    let phrase_results: Vec<PhraseResult> = phrases
        .iter()
        .map(|p| {
            let indices = indices_in(p.start_s, p.end_s);
            let quality: Vec<f64> = indices.iter().map(|&i| interval_quality(errors[i])).collect();
            let shifts: Vec<f64> =
                indices.iter().filter(|&&i| user[i].is_some()).map(|&i| shift_curve[i]).collect();
            PhraseResult {
                start_s: p.start_s,
                end_s: p.end_s,
                score: 100.0 * mean(&quality),
                shift: median(&shifts),
            }
        })
        .collect();
    let drifts: Vec<f64> =
        phrase_results.windows(2).map(|w| (w[1].shift - w[0].shift).abs()).collect();

    let mut long_residuals = Vec::new();
    let mut i = 0;
    while i < len {
        let mut j = i + 1;
        while j < len
            && match reference[i] {
                None => reference[j].is_none(),
                Some(ri) => {
                    reference[j].is_some_and(|rj| (rj - ri).abs() < c::REFERENCE_NOTE_TOLERANCE)
                }
            }
        {
            j += 1;
        }
        if reference[i].is_some() && (j - i) as f64 * hop > c::LONG_NOTE_SECONDS {
            let (from, to) = js::slice_bounds(len, i as i64 + 5, j as i64 - 5);
            let e: Vec<f64> = errors[from..to].iter().flatten().copied().collect();
            let center = median(&e);
            long_residuals.extend(e.iter().map(|v| (v - center).abs()));
        }
        i = j;
    }
    let stability = if coverage == 0.0 {
        0.0
    } else {
        quality(mean(&long_residuals), c::STABILITY_GOOD, c::STABILITY_BAD)
            * (1.0 - c::DRIFT_PENALTY * clamp01(mean(&drifts) / c::DRIFT_BAD))
    };

    let spread = |xs: &[f64]| {
        let center = mean(xs);
        let squares: Vec<f64> = xs.iter().map(|x| (x - center) * (x - center)).collect();
        mean(&squares).sqrt()
    };
    let user_voiced: Vec<f64> = user.iter().flatten().copied().collect();
    let ref_voiced: Vec<f64> = reference.iter().flatten().copied().collect();
    let constant_tone = covered > 20
        && spread(&user_voiced) < c::CONSTANT_SPREAD
        && spread(&ref_voiced) > c::REFERENCE_SPREAD;

    let axes = Axes { intervals: mean(&iq), rhythm, stability, coverage };
    let mut score = 100.0
        * (c::WEIGHT_INTERVALS * axes.intervals
            + c::WEIGHT_RHYTHM * rhythm
            + c::WEIGHT_STABILITY * stability
            + c::WEIGHT_COVERAGE * coverage);
    if coverage < c::COVERAGE_FLOOR || constant_tone {
        score = js::min(c::LOW_COVERAGE_CAP, score);
    }

    let seconds = (0..song.duration_s.ceil() as usize)
        .map(|s| {
            let indices = indices_in(s as f64, s as f64 + 1.0);
            let errs: Vec<f64> = indices.iter().map(|&i| abs_error(errors[i])).collect();
            let heard = indices.iter().filter(|&&i| user[i].is_some()).count();
            SecondSummary {
                t: s as f64,
                error: mean(&errs),
                coverage: if indices.is_empty() { 1.0 } else { heard as f64 / indices.len() as f64 },
            }
        })
        .collect();

    let mut moments = Vec::new();
    for (pi, p) in phrases.iter().enumerate() {
        let mut t = p.start_s;
        while t < p.end_s - 0.15 {
            let end = js::min(p.end_s, t + 2.0);
            let indices = indices_in(t, end);
            if !indices.is_empty() {
                let heard = indices.iter().filter(|&&i| user[i].is_some()).count();
                let cov = heard as f64 / indices.len() as f64;
                let errs: Vec<f64> = indices.iter().map(|&i| abs_error(errors[i])).collect();
                let e = mean(&errs);
                let present: Vec<f64> = indices.iter().filter_map(|&i| errors[i]).collect();
                let signed = median(&present);
                let offsets: Vec<f64> = note_offsets
                    .iter()
                    .filter(|n| n.t >= t && n.t < end)
                    .map(|n| n.offset.abs())
                    .collect();
                let timing = median(&offsets);
                let reason = if cov < 0.65 {
                    Reason::Missing
                } else if timing > 0.12 && timing / 0.3 > e / 1.5 {
                    Reason::Rhythm
                } else {
                    Reason::Pitch
                };
                let quality_window: Vec<f64> =
                    indices.iter().map(|&i| interval_quality(errors[i])).collect();
                let loss = 0.45 * (1.0 - mean(&quality_window))
                    + 0.25 * (1.0 - quality(timing, c::RHYTHM_GOOD, c::RHYTHM_BAD))
                    + 0.15 * (1.0 - cov);
                let phrase = pi + 1;
                let text = match reason {
                    Reason::Missing => format!(
                        "Во фразе {phrase} часть мелодии не слышна. Спой этот отрезок без паузы."
                    ),
                    Reason::Rhythm => format!(
                        "Во фразе {phrase} начала нот смещены примерно на {} мс после вычета общей задержки.",
                        js::round(timing * 1000.0)
                    ),
                    Reason::Pitch => format!(
                        "Во фразе {phrase} ты пел примерно на {} центов {} нужного относительно своей тональности.",
                        js::round(signed.abs() * 100.0),
                        if signed < 0.0 { "ниже" } else { "выше" }
                    ),
                };
                if loss > 0.025 {
                    moments.push(Moment { start_s: t, end_s: end, phrase, loss, reason, text });
                }
            }
            t += 2.0;
        }
    }
    moments.sort_by(|a, b| js::cmp(&b.loss, &a.loss));
    let mut selected: Vec<Moment> = Vec::new();
    for m in moments {
        if selected.len() < 3 && !selected.iter().any(|s| m.start_s < s.end_s && m.end_s > s.start_s) {
            selected.push(m);
        }
    }
    selected.sort_by(|a, b| js::cmp(&a.start_s, &b.start_s));

    let voiced_shifts: Vec<f64> = (0..len)
        .filter(|&i| reference[i].is_some() && user[i].is_some())
        .map(|i| shift_curve[i])
        .collect();
    let full_shift = median(&voiced_shifts);
    ScoreResult {
        score: js::round(score * 10.0) / 10.0,
        raw_score: score,
        axes,
        lag,
        shift: wrap(full_shift),
        register_shift: full_shift,
        shift_curve,
        errors,
        seconds,
        phrases: phrase_results,
        moments: selected,
        note_offsets,
        constant_tone,
    }
}
