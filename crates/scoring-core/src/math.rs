use crate::js;

pub fn median(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let mut a = xs.to_vec();
    a.sort_by(js::cmp);
    let m = a.len() / 2;
    if a.len() % 2 == 1 { a[m] } else { (a[m - 1] + a[m]) / 2.0 }
}

/// Сумма слева направо от нуля, как `reduce((a, b) => a + b, 0)`.
pub fn mean(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    xs.iter().fold(0.0, |a, &b| a + b) / xs.len() as f64
}

pub fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    js::max(lo, js::min(hi, x))
}

pub fn clamp01(x: f64) -> f64 {
    clamp(x, 0.0, 1.0)
}

/// Сворачивает разность высот в диапазон [-6, 6) полутонов.
pub fn wrap(x: f64) -> f64 {
    (((x + 6.0) % 12.0) + 12.0) % 12.0 - 6.0
}

/// 1 до порога `good`, 0 после `bad`, линейно между ними.
pub fn quality(e: f64, good: f64, bad: f64) -> f64 {
    clamp01(1.0 - (e.abs() - good) / (bad - good))
}

pub fn circular_median(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let (mut best, mut cost) = (0.0, f64::INFINITY);
    // Сетка 0.1 полутона, затем уточнение медианой развёрнутых наблюдений.
    for q in -60..60 {
        let s = q as f64 / 10.0;
        let c = xs.iter().fold(0.0, |sum, &x| sum + wrap(x - s).abs());
        if c < cost {
            cost = c;
            best = s;
        }
    }
    let unwrapped: Vec<f64> = xs.iter().map(|&x| wrap(x - best)).collect();
    wrap(best + median(&unwrapped))
}

/// Скользящее среднее по озвученным кадрам; пропуски остаются пропусками.
pub fn smooth(values: &[Option<f64>], radius: usize) -> Vec<Option<f64>> {
    let mut xs = Vec::with_capacity(2 * radius + 1);
    (0..values.len())
        .map(|i| {
            values[i]?;
            xs.clear();
            let hi = (i + radius).min(values.len() - 1);
            xs.extend(values[i.saturating_sub(radius)..=hi].iter().flatten());
            Some(mean(&xs))
        })
        .collect()
}
