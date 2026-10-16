//! Числовая семантика JavaScript, от которой зависит прежний результат.
//!
//! Скоринг переносился из TypeScript. Обычные операции IEEE-754 binary64 совпадают
//! в Rust и JS, а эти функции отличаются и поэтому воспроизводятся явно.

/// `Math.round`: ближайшее целое, половина округляется к +∞ (`-2.5 → -2`).
/// `f64::round` округляет половину от нуля и дал бы другой результат.
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    // Для |x| < 2^52 дробная часть x - floor(x) вычисляется точно.
    let r = if x - f >= 0.5 { f + 1.0 } else { f };
    // Math.round сохраняет знак нуля для отрицательных x в [-0.5, 0).
    if r == 0.0 && x.is_sign_negative() { -0.0 } else { r }
}

/// `Math.min(a, b)`: NaN заражает результат, `-0` меньше `+0`.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else if b < a {
        b
    } else if a.is_sign_negative() {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)`: NaN заражает результат, `+0` больше `-0`.
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else if b > a {
        b
    } else if a.is_sign_positive() {
        a
    } else {
        b
    }
}

/// Компаратор `(a, b) => a - b` для устойчивой сортировки чисел без NaN.
pub fn cmp(a: &f64, b: &f64) -> std::cmp::Ordering {
    a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal)
}

/// Границы `Array.prototype.slice(start, end)` с отрицательными индексами от конца.
pub fn slice_bounds(len: usize, start: i64, end: i64) -> (usize, usize) {
    let len = len as i64;
    let norm = |i: i64| if i < 0 { (len + i).max(0) } else { i.min(len) };
    let (s, e) = (norm(start), norm(end));
    (s as usize, e.max(s) as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_matches_math_round() {
        for (x, want) in [
            (0.0_f64, 0.0_f64),
            (2.5, 3.0),
            (-2.5, -2.0),
            (0.5, 1.0),
            (-0.5, -0.0),
            (1.4999999999999998, 1.0),
            (0.49999999999999994, 0.0),
            (-1.5, -1.0),
            (29.999999999999996, 30.0),
            (7.499999999999999, 7.0),
            (4503599627370497.0, 4503599627370497.0),
        ] {
            let got = round(x);
            assert_eq!(got.to_bits(), want.to_bits(), "round({x})");
        }
    }

    #[test]
    fn min_max_follow_js() {
        assert!(min(f64::NAN, 1.0).is_nan());
        assert!(max(1.0, f64::NAN).is_nan());
        assert!(min(0.0, -0.0).is_sign_negative());
        assert!(max(-0.0, 0.0).is_sign_positive());
    }

    #[test]
    fn slice_handles_negative_and_inverted_ranges() {
        assert_eq!(slice_bounds(10, 2, -2), (2, 8));
        assert_eq!(slice_bounds(10, 8, 3), (8, 8));
        assert_eq!(slice_bounds(10, -20, 30), (0, 10));
    }
}
