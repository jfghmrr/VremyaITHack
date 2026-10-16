use crate::config as c;
use crate::js;
use crate::math::median;
use crate::{NoteOffset, PitchFrame};

/// Кадры с конечными значениями, устойчиво отсортированные по времени.
/// Прежний код фильтровал и сортировал при каждом вызове `resample`;
/// результат детерминирован, поэтому достаточно сделать это один раз.
pub fn prepare(frames: &[PitchFrame]) -> Vec<PitchFrame> {
    let mut sorted: Vec<PitchFrame> = frames
        .iter()
        .filter(|f| f.t.is_finite() && f.midi.is_none_or(f64::is_finite))
        .copied()
        .collect();
    sorted.sort_by(|a, b| js::cmp(&a.t, &b.t));
    sorted
}

/// Ближайший кадр в пределах 35 мс от каждой точки сетки `i * hop + lag`.
/// При равном расстоянии выбирается более поздний кадр.
pub fn resample(sorted: &[PitchFrame], length: usize, hop: f64, lag: f64) -> Vec<Option<f64>> {
    let mut p = 0;
    (0..length)
        .map(|i| {
            let t = i as f64 * hop + lag;
            while p + 1 < sorted.len() && (sorted[p + 1].t - t).abs() <= (sorted[p].t - t).abs() {
                p += 1;
            }
            match sorted.get(p) {
                Some(f) if (f.t - t).abs() <= 0.035 => f.midi,
                _ => None,
            }
        })
        .collect()
}

fn delta(xs: &[Option<f64>], i: usize) -> f64 {
    match (xs[i - 3], xs[i + 3]) {
        (Some(a), Some(b)) => b - a,
        _ => 0.0,
    }
}

/// Общая задержка в ±300 мс по корреляции разностей высоты и пересечению голоса.
pub fn find_lag(sorted: &[PitchFrame], reference: &[Option<f64>], hop: f64) -> f64 {
    let (mut best, mut lag) = (f64::NEG_INFINITY, 0.0);
    let range = js::round(c::MAX_LAG / hop) as i64;
    for k in -range..=range {
        let user = resample(sorted, reference.len(), hop, k as f64 * hop);
        let (mut dot, mut rr, mut uu, mut both, mut total) = (0.0, 0.0, 0.0, 0usize, 0usize);
        for i in 3..reference.len().saturating_sub(3) {
            let r = delta(reference, i);
            let u = delta(&user, i);
            dot += r * u;
            rr += r * r;
            uu += u * u;
            if reference[i].is_some() {
                total += 1;
                if user[i].is_some() {
                    both += 1;
                }
            }
        }
        let corr = if rr > 0.0 && uu > 0.0 { dot / (rr * uu).sqrt() } else { 0.0 };
        let value = corr + (0.2 * both as f64) / total.max(1) as f64 - (k as f64).abs() * 1e-7;
        if value > best {
            best = value;
            lag = k as f64 * hop;
        }
    }
    lag
}

/// Начала нот: после паузы или по скачку высоты больше 0.7 полутона.
pub fn onsets(xs: &[Option<f64>], hop: f64) -> Vec<f64> {
    let mut result = Vec::new();
    let mut last = f64::NEG_INFINITY;
    for i in 0..xs.len() {
        let Some(x) = xs[i] else { continue };
        let prev = xs[i.saturating_sub(1)];
        let t = i as f64 * hop;
        let start = match prev {
            _ if i == 0 => true,
            None => true,
            Some(p) => (x - p).abs() > c::ONSET_JUMP && t - last > c::ONSET_DEBOUNCE,
        };
        if start {
            result.push(t);
            last = t;
        }
    }
    result
}

/// Banded DTW на контурах после вычета локальной тональности; сетка 20 мс ограничивает
/// процессорное время и память. Возвращает смещение каждого начала ноты эталона.
pub fn rhythm_offsets(
    reference: &[Option<f64>],
    user: &[Option<f64>],
    shifts: &[f64],
    hop: f64,
) -> Vec<NoteOffset> {
    let stride = js::max(1.0, js::round(0.02 / hop)) as usize;
    let dt = hop * stride as f64;
    let r: Vec<_> = reference.iter().step_by(stride).copied().collect();
    let u: Vec<_> = user.iter().step_by(stride).copied().collect();
    let s: Vec<_> = shifts.iter().step_by(stride).copied().collect();
    let n = r.len();
    let band = (c::DTW_BAND / dt).ceil() as usize;
    let width = 2 * band + 1;
    let mut back = vec![0u8; n * width];
    let mut prev = vec![f64::INFINITY; n];
    let mut row = vec![f64::INFINITY; n];
    for i in 0..n {
        row.fill(f64::INFINITY);
        for j in i.saturating_sub(band)..=(i + band).min(n - 1) {
            let cost = match (r[i], u[j]) {
                (None, None) => 0.0,
                (None, _) | (_, None) => 1.5,
                (Some(rv), Some(uv)) => js::min(3.0, (uv - s[i] - rv).abs()),
            };
            let mut v = if i == 0 && j == 0 {
                0.0
            } else if i > 0 && j > 0 {
                prev[j - 1]
            } else {
                f64::INFINITY
            };
            let mut dir = 1;
            if i > 0 && prev[j] + 0.045 < v {
                v = prev[j] + 0.045;
                dir = 2;
            }
            if j > 0 && row[j - 1] + 0.045 < v {
                v = row[j - 1] + 0.045;
                dir = 3;
            }
            row[j] = cost + v;
            back[i * width + j + band - i] = dir;
        }
        std::mem::swap(&mut prev, &mut row);
    }
    let mut map: Vec<Vec<f64>> = vec![Vec::new(); n];
    let (mut i, mut j) = (n as i64 - 1, n as i64 - 1);
    while i >= 0 && j >= 0 {
        map[i as usize].push(j as f64 * dt);
        if i == 0 && j == 0 {
            break;
        }
        // Плоский индекс как в Uint8Array: вне массива значение undefined и путь обрывается.
        let index = i * width as i64 + j - i + band as i64;
        let dir = if (0..back.len() as i64).contains(&index) { back[index as usize] } else { 0 };
        match dir {
            1 => {
                i -= 1;
                j -= 1;
            }
            2 => i -= 1,
            3 => j -= 1,
            _ => break,
        }
    }
    let starts = onsets(reference, hop);
    let user_starts = onsets(user, hop);
    starts
        .into_iter()
        .map(|t| {
            let idx = js::min(n as f64 - 1.0, js::round(t / dt)) as usize;
            let mapped = if map[idx].is_empty() { t } else { median(&map[idx]) };
            let mut candidates: Vec<f64> = user_starts
                .iter()
                .copied()
                .filter(|&x| (x - t).abs() <= c::DTW_BAND && (x - mapped).abs() < 0.16)
                .collect();
            candidates.sort_by(|a, b| js::cmp(&(a - mapped).abs(), &(b - mapped).abs()));
            let offset = candidates.first().map_or(c::DTW_BAND, |x| x - t);
            NoteOffset { t, offset }
        })
        .collect()
}
