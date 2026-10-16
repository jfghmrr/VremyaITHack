//! Время оценки native: cargo run --release -p scoring-core --example bench
use scoring_core::{PitchFrame, Song, score_performance};
use std::time::Instant;

fn main() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../fixtures/scoring/");
    let songs: std::collections::HashMap<String, Song> = serde_json::from_str(&std::fs::read_to_string(format!("{path}songs.json")).unwrap()).unwrap();
    let song = &songs["ode"];
    // 20 секунд пения на сетке 10 мс (как одиночная попытка) и 50 мс (как дуэль).
    for (label, hop) in [("10 мс, 2000 кадров", 0.01), ("50 мс, 400 точек", 0.05)] {
        let frames: Vec<PitchFrame> = (0..(song.duration_s / hop) as usize)
            .map(|i| {
                let t = i as f64 * hop;
                let m = song.f0_midi[((t * 100.0) as usize).min(song.f0_midi.len() - 1)];
                PitchFrame { t, midi: m.map(|m| m - 5.0 + 0.3 * (t * 7.0).sin()) }
            })
            .collect();
        let runs = 30;
        let start = Instant::now();
        for _ in 0..runs {
            std::hint::black_box(score_performance(&frames, song));
        }
        println!("native {label}: {:.1} мс на оценку", start.elapsed().as_secs_f64() * 1000.0 / runs as f64);
    }
}
