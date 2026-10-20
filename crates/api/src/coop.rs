//! Режим «Вместе»: двое поют одну песню по очереди — по строке текста, короткие строки по две.
//!
//! Расписание ходов строит сервер из тех же строк, что показывает караоке (`lyrics` эталона,
//! концы строк — по разметке слов), и отправляет его в состоянии матча; клиенты его не
//! пересчитывают. Каждую партию оценивает то же ядро `scoring-core`, но эталон вне ходов певца
//! считается паузой: покрытие, пределы и поиск задержки работают по его партии. Точки
//! участника вне его ходов не учитываются. Общий балл — среднее двух партий, взвешенное по
//! длительности мелодии эталона в каждой партии.
use crate::protocol::{HardMoment, Turn};
use scoring_core::config::CANONICAL_HOP;
use scoring_core::{Phrase, ScoreResult, Song};

/// Строка текста песни: начало и конец пения (секунды от начала песни) и число слов.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LineSpan {
    /// Номер строки в `lyrics` эталона (строки с испорченным временем пропускаются, номера остаются).
    pub line: u32,
    pub start_s: f64,
    pub end_s: f64,
    pub words: u32,
}

/// Строка короче этого считается короткой и поётся вместе со следующей.
pub const SHORT_LINE_S: f64 = 3.0;
/// Строка из стольких слов или меньше тоже короткая, если она не длинная по времени.
pub const FEW_WORDS: u32 = 4;
/// Строка не короче этого никогда не считается короткой, сколько бы в ней ни было слов:
/// в медленных песнях четыре слова тянутся 7-9 секунд, и два таких хода подряд были бы
/// слишком длинными.
pub const LONG_LINE_S: f64 = 5.0;
/// Короткая строка присоединяет следующую, только если та начинается не позже этого после
/// её конца: ход не растягивается через проигрыш.
pub const MAX_JOIN_GAP_S: f64 = 2.0;
/// Запас окна хода до начала и после конца строк (задержка записи и поиск сдвига ±0,3 с).
/// Окна соседних ходов не перекрываются: запас обрезается серединой паузы между ними.
pub const MARGIN_S: f64 = 0.4;
/// «Вместе» требует хотя бы двух ходов: иначе второму участнику нечего петь.
pub const MIN_TURNS: usize = 2;

pub fn is_short(line: &LineSpan) -> bool {
    let d = line.end_s - line.start_s;
    d < SHORT_LINE_S || (line.words <= FEW_WORDS && d < LONG_LINE_S)
}

fn ms(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

/// Расписание ходов: строки по одной, короткая строка вместе со следующей (не больше двух
/// строк в ходе); ходы чередуются A, B, A, B…, первым поёт создатель комнаты (слот 0).
pub fn schedule(lines: &[LineSpan], duration_s: f64) -> Vec<Turn> {
    let mut groups: Vec<(usize, usize)> = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let joins = lines.get(i + 1).is_some_and(|next| is_short(&lines[i]) && next.start_s - lines[i].end_s <= MAX_JOIN_GAP_S);
        let last = if joins { i + 1 } else { i };
        groups.push((i, last));
        i = last + 1;
    }
    // Спетая часть хода: от начала первой строки до конца последней.
    let cores: Vec<(f64, f64)> = groups.iter().map(|&(a, b)| (lines[a].start_s, lines[b].end_s.max(lines[a].start_s))).collect();
    groups
        .iter()
        .enumerate()
        .map(|(k, &(a, b))| {
            let (start, end) = cores[k];
            let lo = if k == 0 { 0.0 } else { (cores[k - 1].1 + start) / 2.0 };
            let hi = if k + 1 == cores.len() { duration_s } else { (end + cores[k + 1].0) / 2.0 };
            Turn {
                slot: (k % 2) as u8,
                start_s: ms((start - MARGIN_S).max(lo).max(0.0)),
                end_s: ms((end + MARGIN_S).min(hi).min(duration_s)),
                lines: (a..=b).map(|k| lines[k].line).collect(),
            }
        })
        .collect()
}

/// Попадает ли момент `t` (секунды) в ходы участника `slot`.
pub fn in_turns(turns: &[Turn], slot: u8, t: f64) -> bool {
    turns.iter().any(|w| w.slot == slot && t >= w.start_s && t < w.end_s)
}

/// Эталон партии участника: высота вне его ходов — пауза, фразы обрезаны его ходами.
pub fn part_song(song: &Song, turns: &[Turn], slot: u8) -> Song {
    let hop = song.hop_ms / 1000.0;
    let f0_midi = song.f0_midi.iter().enumerate().map(|(i, m)| m.filter(|_| in_turns(turns, slot, i as f64 * hop))).collect();
    // Фразы ядра — только внутри ходов: иначе чужие фразы без голоса давали бы «дрейф тональности».
    let whole = [Phrase { start_s: 0.0, end_s: song.duration_s }];
    let source = if song.phrases.is_empty() { &whole[..] } else { &song.phrases[..] };
    let own: Vec<&Turn> = turns.iter().filter(|w| w.slot == slot).collect();
    let mut phrases: Vec<Phrase> = Vec::new();
    for p in source {
        for w in &own {
            let (a, b) = (p.start_s.max(w.start_s), p.end_s.min(w.end_s));
            if b - a > hop {
                phrases.push(Phrase { start_s: a, end_s: b });
            }
        }
    }
    if phrases.is_empty() {
        phrases = own.iter().map(|w| Phrase { start_s: w.start_s, end_s: w.end_s }).collect();
    }
    phrases.sort_by(|x, y| x.start_s.total_cmp(&y.start_s));
    Song { hop_ms: song.hop_ms, duration_s: song.duration_s, f0_midi, phrases }
}

/// Длительность мелодии эталона в партии, секунды (вес партии в общем балле).
pub fn part_seconds(song: &Song, turns: &[Turn], slot: u8) -> f64 {
    let hop = song.hop_ms / 1000.0;
    let voiced = song.f0_midi.iter().enumerate().filter(|(i, m)| m.is_some() && in_turns(turns, slot, *i as f64 * hop)).count();
    voiced as f64 * hop
}

/// Кривая участника для оценки партии: точки вне его ходов отбрасываются.
pub fn mask_curve(curve: &[Option<i16>], turns: &[Turn], slot: u8) -> Vec<Option<i16>> {
    curve.iter().enumerate().map(|(i, v)| v.filter(|_| in_turns(turns, slot, i as f64 * CANONICAL_HOP))).collect()
}

/// Оценка партии: каноническая кривая участника против эталона его ходов.
pub fn score_part(curve: &[Option<i16>], song: &Song, turns: &[Turn], slot: u8) -> ScoreResult {
    let frames = scoring_core::dequantize(&mask_curve(curve, turns, slot));
    scoring_core::score_performance(&frames, &part_song(song, turns, slot))
}

/// Общий балл: среднее партий, взвешенное по длительности; без оценки любой партии — нет.
pub fn team_score(parts: &[(f64, Option<f64>)]) -> Option<f64> {
    let mut total = 0.0;
    let mut sum = 0.0;
    for &(seconds, score) in parts {
        let score = score?;
        total += seconds;
        sum += seconds * score;
    }
    (total > 0.0).then(|| (sum / total * 10.0).round() / 10.0)
}

/// Самое трудное место партии: окно разбора ядра с наибольшей потерей.
pub fn hardest(result: &ScoreResult) -> Option<HardMoment> {
    result
        .moments
        .iter()
        .max_by(|a, b| a.loss.total_cmp(&b.loss))
        .map(|m| HardMoment { start_s: m.start_s, end_s: m.end_s, reason: m.reason })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(start_s: f64, end_s: f64, words: u32) -> LineSpan {
        LineSpan { line: 0, start_s, end_s, words }
    }

    /// Расписание для строк по порядку (номер строки — её место в списке).
    fn sched(lines: &[LineSpan], duration_s: f64) -> Vec<Turn> {
        let numbered: Vec<LineSpan> = lines.iter().enumerate().map(|(i, l)| LineSpan { line: i as u32, ..*l }).collect();
        schedule(&numbered, duration_s)
    }

    fn lines_of(turns: &[Turn]) -> Vec<Vec<u32>> {
        turns.iter().map(|t| t.lines.clone()).collect()
    }

    fn slots(turns: &[Turn]) -> Vec<u8> {
        turns.iter().map(|t| t.slot).collect()
    }

    #[test]
    fn long_lines_alternate_one_per_turn_starting_with_the_host() {
        let lines = [line(1.4, 4.8, 6), line(4.9, 10.4, 13), line(12.7, 17.0, 7), line(17.1, 22.2, 13)];
        let turns = sched(&lines, 22.55);
        assert_eq!(lines_of(&turns), vec![vec![0], vec![1], vec![2], vec![3]]);
        assert_eq!(slots(&turns), vec![0, 1, 0, 1]);
    }

    #[test]
    fn short_lines_join_the_next_one_and_never_more_than_two() {
        // Три коротких строки подряд: первая берёт вторую, третья — четвёртую.
        let lines = [line(1.0, 2.5, 4), line(2.6, 4.0, 3), line(4.2, 5.4, 2), line(5.5, 9.5, 9), line(9.8, 14.0, 8)];
        let turns = sched(&lines, 15.0);
        assert_eq!(lines_of(&turns), vec![vec![0, 1], vec![2, 3], vec![4]]);
        assert_eq!(slots(&turns), vec![0, 1, 0]);
        assert!(turns.iter().all(|t| t.lines.len() <= 2));
    }

    #[test]
    fn few_words_count_as_short_only_when_the_line_is_not_long() {
        // 4 слова за 3,5 с — коротко; 4 слова за 9 с (медленная песня) — отдельный ход.
        assert!(is_short(&line(0.0, 3.5, 4)));
        assert!(!is_short(&line(0.0, 9.1, 4)));
        assert!(is_short(&line(0.0, 2.9, 12)));
        assert!(!is_short(&line(0.0, 3.2, 5)));
        let lines = [line(3.0, 12.1, 4), line(12.7, 19.5, 4), line(20.4, 27.9, 4), line(27.9, 31.1, 4)];
        assert_eq!(lines_of(&sched(&lines, 31.4)), vec![vec![0], vec![1], vec![2], vec![3]]);
    }

    #[test]
    fn a_short_line_before_a_long_instrumental_stays_alone() {
        let lines = [line(1.0, 2.5, 3), line(8.0, 12.0, 9), line(12.5, 16.0, 8)];
        assert_eq!(lines_of(&sched(&lines, 17.0)), vec![vec![0], vec![1], vec![2]]);
    }

    #[test]
    fn song_starting_with_a_long_instrumental_starts_the_first_turn_at_its_line() {
        let lines = [line(10.48, 18.4, 6), line(20.88, 30.7, 8), line(30.74, 38.0, 6)];
        let turns = sched(&lines, 40.0);
        assert_eq!(slots(&turns), vec![0, 1, 0]);
        // Окно — строка с запасом 0,4 с; вступление никому не принадлежит.
        assert_eq!(turns[0].start_s, 10.08);
        assert!(!in_turns(&turns, 0, 5.0) && !in_turns(&turns, 1, 5.0));
        assert!(in_turns(&turns, 0, 10.2));
    }

    #[test]
    fn odd_number_of_turns_gives_the_host_one_more() {
        let lines = [line(1.0, 4.5, 6), line(5.0, 9.0, 6), line(9.5, 13.0, 6)];
        let turns = sched(&lines, 14.0);
        assert_eq!(slots(&turns), vec![0, 1, 0]);
    }

    #[test]
    fn a_single_very_long_line_is_one_turn_and_too_few_for_coop() {
        let turns = sched(&[line(0.5, 29.0, 40)], 30.0);
        assert_eq!(lines_of(&turns), vec![vec![0]]);
        assert_eq!(slots(&turns), vec![0]);
        assert!(turns.len() < MIN_TURNS);
        assert!(sched(&[], 30.0).is_empty());
    }

    #[test]
    fn turns_keep_the_original_line_numbers_when_a_line_was_skipped() {
        // Строка 1 испорчена и пропущена каталогом: ходы называют строки 0, 2, 3.
        let lines = [
            LineSpan { line: 0, start_s: 1.0, end_s: 4.5, words: 6 },
            LineSpan { line: 2, start_s: 5.0, end_s: 9.0, words: 6 },
            LineSpan { line: 3, start_s: 9.5, end_s: 13.0, words: 6 },
        ];
        assert_eq!(lines_of(&schedule(&lines, 14.0)), vec![vec![0], vec![2], vec![3]]);
    }

    #[test]
    fn windows_add_a_margin_but_never_overlap_and_stay_inside_the_song() {
        // Строки почти вплотную (пауза 0,08 с): граница — середина паузы.
        let lines = [line(0.2, 4.82, 6), line(4.9, 10.36, 13), line(12.7, 17.0, 7), line(17.1, 22.5, 13)];
        let turns = sched(&lines, 22.55);
        assert_eq!(turns[0].start_s, 0.0);
        assert_eq!(turns[0].end_s, 4.86);
        assert_eq!(turns[1].start_s, 4.86);
        assert_eq!(turns[1].end_s, 10.76);
        assert_eq!(turns[2].start_s, 12.3);
        assert_eq!(turns[3].end_s, 22.55);
        for w in turns.windows(2) {
            assert!(w[0].end_s <= w[1].start_s);
        }
        assert!(in_turns(&turns, 0, 4.85) && !in_turns(&turns, 0, 4.86));
        assert!(in_turns(&turns, 1, 4.86) && !in_turns(&turns, 1, 11.0));
    }

    /// Песня из двух нот по 3 с с паузой: первая — ход A, вторая — ход B.
    fn two_part_song() -> (Song, Vec<Turn>) {
        let mut f0 = vec![None; 800];
        for (i, v) in f0.iter_mut().enumerate() {
            if (50..350).contains(&i) {
                *v = Some(60.0 + ((i / 50) % 3) as f64 * 2.0);
            } else if (450..750).contains(&i) {
                *v = Some(64.0 + ((i / 50) % 3) as f64 * 2.0);
            }
        }
        let song = Song {
            hop_ms: 10.0,
            duration_s: 8.0,
            f0_midi: f0,
            phrases: vec![Phrase { start_s: 0.5, end_s: 3.5 }, Phrase { start_s: 4.5, end_s: 7.5 }],
        };
        let turns = sched(&[line(0.5, 3.5, 6), line(4.5, 7.5, 6)], 8.0);
        (song, turns)
    }

    /// Каноническая кривая (50 мс), поющая эталон со сдвигом там, где `sing(t)`.
    fn sung(song: &Song, shift: f64, sing: impl Fn(f64) -> bool) -> Vec<Option<i16>> {
        let n = crate::matches::curve_len(song.duration_s);
        (0..n)
            .map(|i| {
                let t = i as f64 * CANONICAL_HOP;
                let r = song.f0_midi.get((t * 100.0).round() as usize).copied().flatten();
                r.filter(|_| sing(t)).map(|m| ((m + shift) * 10.0).round() as i16)
            })
            .collect()
    }

    #[test]
    fn part_reference_is_silent_outside_own_turns_and_phrases_are_clipped() {
        let (song, turns) = two_part_song();
        let a = part_song(&song, &turns, 0);
        assert!(a.f0_midi[100].is_some() && a.f0_midi[500].is_none());
        let b = part_song(&song, &turns, 1);
        assert!(b.f0_midi[100].is_none() && b.f0_midi[500].is_some());
        assert_eq!(a.phrases, vec![Phrase { start_s: 0.5, end_s: 3.5 }]);
        assert_eq!(b.phrases, vec![Phrase { start_s: 4.5, end_s: 7.5 }]);
        assert!((part_seconds(&song, &turns, 0) - 3.0).abs() < 1e-9);
        assert!((part_seconds(&song, &turns, 1) - 3.0).abs() < 1e-9);
    }

    #[test]
    fn singing_own_turns_scores_high_and_silence_on_own_turns_scores_low() {
        let (song, turns) = two_part_song();
        // A поёт только свои ходы (в своей тональности): партия почти идеальна.
        let a = score_part(&sung(&song, -3.0, |t| in_turns(&turns, 0, t)), &song, &turns, 0);
        assert!(a.score > 90.0, "партия A {}", a.score);
        assert!(a.axes.coverage > 0.95);
        // B молчит в свои ходы и поёт ходы A: его партия не спета.
        let b = score_part(&sung(&song, 0.0, |t| in_turns(&turns, 0, t)), &song, &turns, 1);
        assert!(b.score <= 30.0, "партия B {}", b.score);
        assert_eq!(b.axes.coverage, 0.0);
    }

    #[test]
    fn partner_points_never_count_for_you() {
        let (song, turns) = two_part_song();
        let own = sung(&song, 2.0, |t| in_turns(&turns, 1, t));
        // Те же точки в своих ходах плюс «пение» чужих ходов фальшиво: оценка партии не меняется.
        let mut noisy = own.clone();
        for (i, v) in noisy.iter_mut().enumerate() {
            if in_turns(&turns, 0, i as f64 * CANONICAL_HOP) {
                *v = Some(400 + (i % 7) as i16 * 13);
            }
        }
        assert_eq!(mask_curve(&noisy, &turns, 1), own);
        assert_eq!(score_part(&noisy, &song, &turns, 1).score, score_part(&own, &song, &turns, 1).score);
    }

    #[test]
    fn team_score_is_the_duration_weighted_mean_of_the_parts() {
        assert_eq!(team_score(&[(10.0, Some(80.0)), (5.0, Some(50.0))]), Some(70.0));
        assert_eq!(team_score(&[(3.0, Some(91.3)), (3.0, Some(64.1))]), Some(77.7));
        // Неоценённая партия — общего балла нет; партия без мелодии не весит ничего.
        assert_eq!(team_score(&[(10.0, Some(80.0)), (5.0, None)]), None);
        assert_eq!(team_score(&[(10.0, Some(80.0)), (0.0, Some(0.0))]), Some(80.0));
        assert_eq!(team_score(&[(0.0, Some(80.0)), (0.0, Some(60.0))]), None);
    }

    #[test]
    fn hardest_moment_is_the_window_with_the_largest_loss() {
        let (song, turns) = two_part_song();
        let curve = sung(&song, 0.0, |t| in_turns(&turns, 1, t) && !(5.0..6.5).contains(&t));
        let r = score_part(&curve, &song, &turns, 1);
        let h = hardest(&r).expect("есть трудное место");
        assert!(h.start_s >= 4.5 && h.start_s < 6.5, "{h:?}");
        assert_eq!(h.reason, scoring_core::Reason::Missing);
        let clean = score_part(&sung(&song, 0.0, |t| in_turns(&turns, 1, t)), &song, &turns, 1);
        assert!(hardest(&clean).is_none() || clean.moments.iter().all(|m| m.loss < 0.2));
    }
}
