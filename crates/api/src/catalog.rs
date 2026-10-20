//! Каталог фрагментов. Читает тот же `songs/index.json` и `reference.json`, что раздаёт
//! Caddy, и вычисляет версию эталона по содержимому файла.
use crate::state::AppState;
use axum::extract::State;
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Clone, Debug, Deserialize, Serialize, schemars::JsonSchema)]
pub struct SongInfo {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration_s: f64,
    #[serde(default)]
    pub tag: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
    /// Раздел каталога: «Русские», «Праздничные», «Детские», «Классика», «Мировые».
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// Первые 12 hex-символов SHA-256 файла reference.json.
    #[serde(default)]
    pub version: String,
}

pub struct CatalogSong {
    pub info: SongInfo,
    pub song: scoring_core::Song,
    /// Язык слов («ru», «en») из index.json; нужен обработчику для распознавания.
    pub language: Option<String>,
    /// Проверять ли слова при точной оценке (`"wordsCheck"` в index.json, по умолчанию да).
    /// `false` — у песен, где распознавание не находит слов даже в исходном вокале:
    /// задача оценки уходит без слов, итог — мелодия без проверки слов и без предела 40.
    pub words_check: bool,
    /// Строки текста с началом, концом и числом слов: из них строится расписание «Вместе».
    pub lines: Vec<crate::coop::LineSpan>,
}

/// Строка `lyrics` эталона (текст нужен только для подсчёта слов).
#[derive(Deserialize)]
struct LyricLine {
    t: f64,
    #[serde(default)]
    text: String,
}

/// Поле `lyrics` читается без строгой схемы: испорченная строка пропускается, а не мешает
/// запуску API.
#[derive(Deserialize)]
struct LyricsField {
    #[serde(default)]
    lyrics: serde_json::Value,
}

/// Строки `lyrics` по порядку; испорченная (нет числового `t`) — `None` на своём месте.
fn lyric_lines(value: &serde_json::Value) -> Vec<Option<LyricLine>> {
    let Some(items) = value.as_array() else { return Vec::new() };
    items
        .iter()
        .map(|v| {
            let t = v.get("t")?.as_f64()?;
            let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("").to_owned();
            Some(LyricLine { t, text })
        })
        .collect()
}

#[derive(Deserialize)]
struct TimedWord {
    #[serde(default)]
    text: String,
    end_s: f64,
}

#[derive(Deserialize)]
struct WordLine {
    words: Vec<TimedWord>,
}

#[derive(Deserialize)]
struct WordTiming {
    lines: Vec<WordLine>,
}

fn has_letter(token: &str) -> bool {
    token.chars().any(char::is_alphanumeric)
}

/// Строки караоке: начало — `t` строки, конец — конец последнего слова по разметке слов, а без
/// неё — конец фразы с тем же номером или начало следующей строки. Те же строки показывает сцена.
/// Строка без числового начала, с началом вне эталона или раньше предыдущей пропускается (номера
/// остальных строк сохраняются); конец строки обрезается эталоном и никогда не роняет загрузку.
fn line_spans(lyrics: &[Option<LyricLine>], words: Option<&WordTiming>, song: &scoring_core::Song) -> Vec<crate::coop::LineSpan> {
    let words = words.filter(|w| w.lines.len() == lyrics.len());
    let mut out = Vec::new();
    let mut last = f64::NEG_INFINITY;
    for (i, l) in lyrics.iter().enumerate() {
        let Some(l) = l else { continue };
        if !l.t.is_finite() || l.t < 0.0 || l.t >= song.duration_s || l.t < last {
            continue;
        }
        let marked = words.and_then(|w| w.lines.get(i)).filter(|w| !w.words.is_empty());
        let next = lyrics[i + 1..].iter().flatten().map(|n| n.t).find(|t| t.is_finite() && *t >= l.t);
        let end = marked
            .and_then(|w| w.words.last().map(|x| x.end_s))
            .or_else(|| (song.phrases.len() == lyrics.len()).then(|| song.phrases[i].end_s))
            .unwrap_or_else(|| next.unwrap_or(song.duration_s));
        let count = match marked {
            Some(w) => w.words.iter().filter(|x| has_letter(&x.text)).count(),
            None => l.text.split_whitespace().filter(|x| has_letter(x)).count(),
        };
        // `max`/`min` вместо `clamp`: NaN или конец раньше начала не вызывают панику.
        out.push(crate::coop::LineSpan { line: i as u32, start_s: l.t, end_s: end.max(l.t).min(song.duration_s), words: count as u32 });
        last = l.t;
    }
    out
}

/// Строка index.json: поля карточки и служебные поля, которые не входят в `SongInfo`.
#[derive(Deserialize)]
struct IndexEntry {
    #[serde(flatten)]
    info: SongInfo,
    #[serde(default)]
    language: Option<String>,
    #[serde(default = "yes", rename = "wordsCheck")]
    words_check: bool,
    #[serde(default, rename = "wordTiming")]
    word_timing: Option<String>,
}

fn yes() -> bool {
    true
}

pub struct Catalog {
    pub songs: BTreeMap<String, CatalogSong>,
}

fn valid_id(id: &str) -> bool {
    (1..=48).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

impl Catalog {
    pub fn load(dir: &Path) -> anyhow::Result<Self> {
        let index: Vec<IndexEntry> = serde_json::from_str(&std::fs::read_to_string(dir.join("index.json"))?)?;
        let mut songs = BTreeMap::new();
        for IndexEntry { mut info, language, words_check, word_timing } in index {
            anyhow::ensure!(valid_id(&info.id), "invalid song id {:?}", info.id);
            let bytes = std::fs::read(dir.join(&info.id).join("reference.json"))?;
            let song: scoring_core::Song = serde_json::from_slice(&bytes)?;
            // Те же ограничения, что проверяет клиент при загрузке эталона.
            anyhow::ensure!(
                song.hop_ms == 10.0 && song.duration_s > 0.0 && song.duration_s <= 60.0 && song.f0_midi.len() <= 6001,
                "unsupported reference for {}",
                info.id
            );
            let lyrics: LyricsField = serde_json::from_slice(&bytes)?;
            // Разметка слов необязательна: без неё (или с ошибкой) концы строк берутся из фраз.
            let words: Option<WordTiming> = word_timing
                .filter(|f| valid_id(f.trim_end_matches(".json").replace('.', "-").as_str()))
                .and_then(|f| std::fs::read(dir.join(&info.id).join(f)).ok())
                .and_then(|b| serde_json::from_slice(&b).ok());
            let parsed = lyric_lines(&lyrics.lyrics);
            let lines = line_spans(&parsed, words.as_ref(), &song);
            if lines.len() < parsed.len() || (!lyrics.lyrics.is_null() && !lyrics.lyrics.is_array()) {
                tracing::warn!(song = %info.id, kept = lines.len(), total = parsed.len(), "lyric lines skipped: bad start time or format");
            }
            info.version = crate::util::sha256_hex(&bytes)[..12].to_owned();
            info.duration_s = song.duration_s;
            songs.insert(info.id.clone(), CatalogSong { info, song, language, words_check, lines });
        }
        anyhow::ensure!(!songs.is_empty(), "empty catalog");
        Ok(Self { songs })
    }

    pub fn get(&self, id: &str) -> Option<&CatalogSong> {
        self.songs.get(id)
    }
}

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/catalog", get(list))
}

async fn list(State(state): State<AppState>) -> Json<Vec<SongInfo>> {
    Json(state.catalog.songs.values().map(|s| s.info.clone()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(json: &str) -> IndexEntry {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn words_check_defaults_to_true_and_can_be_turned_off() {
        let base = r#""id":"a","title":"T","artist":"A","duration_s":20,"language":"ru""#;
        assert!(entry(&format!("{{{base}}}")).words_check);
        assert!(entry(&format!(r#"{{{base},"wordsCheck":true}}"#)).words_check);
        let off = entry(&format!(r#"{{{base},"wordsCheck":false}}"#));
        assert!(!off.words_check);
        assert_eq!(off.language.as_deref(), Some("ru"));
        assert_eq!(off.info.id, "a");
        // Не логическое значение — ошибка разбора, а не молчаливое «да»: API не запустится.
        assert!(serde_json::from_str::<IndexEntry>(&format!(r#"{{{base},"wordsCheck":"no"}}"#)).is_err());
    }

    /// Опубликованный каталог: слова не проверяются ровно у трёх песен, где Whisper не находит
    /// слов даже в исходном вокале (production, 16.10.2026).
    #[test]
    fn published_catalog_skips_words_only_for_three_songs() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/static/songs");
        let catalog = Catalog::load(&dir).unwrap();
        let off: Vec<&str> = catalog.songs.values().filter(|s| !s.words_check).map(|s| s.info.id.as_str()).collect();
        assert_eq!(off, ["dorogoi-dlinnoyu", "oi-to-ne-vecher", "yamshchik-ne-goni"]);
    }

    /// Каждая песня каталога годится для «Вместе»: строки упорядочены, у обоих есть ходы,
    /// в ходе одна или две строки, окна ходов не перекрываются.
    #[test]
    fn every_published_song_has_a_coop_schedule() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/static/songs");
        let catalog = Catalog::load(&dir).unwrap();
        for s in catalog.songs.values() {
            let id = &s.info.id;
            assert!(!s.lines.is_empty(), "{id}: нет строк");
            for l in &s.lines {
                assert!(l.start_s <= l.end_s && l.end_s <= s.song.duration_s && l.words > 0, "{id}: {l:?}");
            }
            let turns = crate::coop::schedule(&s.lines, s.song.duration_s);
            assert!(turns.len() >= crate::coop::MIN_TURNS, "{id}: ходов {}", turns.len());
            assert!(turns.iter().any(|t| t.slot == 1), "{id}: второму нечего петь");
            let covered: Vec<u32> = turns.iter().flat_map(|t| t.lines.clone()).collect();
            assert_eq!(covered, (0..s.lines.len() as u32).collect::<Vec<_>>(), "{id}: строки по порядку и без пропусков");
            for w in turns.windows(2) {
                assert!(w[0].end_s <= w[1].start_s && w[0].slot != w[1].slot, "{id}: {w:?}");
            }
            assert!(turns.iter().all(|t| (1..=2).contains(&t.lines.len()) && t.start_s < t.end_s), "{id}");
        }
        // Пример: в «Little Tomcat» четыре длинные строки — четыре хода по очереди.
        let tomcat = catalog.get("jw-little-tomcat").unwrap();
        let turns = crate::coop::schedule(&tomcat.lines, tomcat.song.duration_s);
        assert_eq!(turns.iter().map(|t| t.slot).collect::<Vec<_>>(), [0, 1, 0, 1]);
    }

    /// Каталог из одной песни с заданными строками `lyrics` (как в reference.json).
    fn one_song(lyrics: &str) -> anyhow::Result<Catalog> {
        let dir = std::env::temp_dir().join(format!("perepev-catalog-{}", crate::util::random_hex(6)));
        std::fs::create_dir_all(dir.join("s"))?;
        std::fs::write(dir.join("index.json"), r#"[{"id":"s","title":"T","artist":"A","duration_s":10}]"#)?;
        let f0 = vec!["null"; 1000].join(",");
        std::fs::write(dir.join("s/reference.json"), format!(r#"{{"hop_ms":10,"duration_s":10,"f0_midi":[{f0}],"lyrics":{lyrics}}}"#))?;
        let catalog = Catalog::load(&dir);
        std::fs::remove_dir_all(&dir).ok();
        catalog
    }

    /// Строка, начавшаяся после конца эталона, не роняет загрузку API: она пропускается.
    #[test]
    fn a_line_after_the_end_of_the_reference_is_skipped_not_a_panic() {
        let catalog = one_song(r#"[{"t":1,"text":"раз два"},{"t":4,"text":"три"},{"t":12,"text":"поздно"}]"#).unwrap();
        let lines = &catalog.get("s").unwrap().lines;
        assert_eq!(lines.len(), 2);
        assert!(lines.iter().all(|l| l.end_s <= 10.0));
    }

    /// Испорченная строка текста не мешает запуску API: остальные строки на месте.
    #[test]
    fn a_malformed_lyric_line_does_not_abort_startup() {
        let catalog = one_song(r#"[{"t":1,"text":"раз"},{"t":"два"},{"text":"три"},{"t":6,"text":"четыре"}]"#).unwrap();
        let lines = &catalog.get("s").unwrap().lines;
        assert_eq!(lines.iter().map(|l| l.start_s).collect::<Vec<_>>(), [1.0, 6.0]);
        // А если поле `lyrics` вовсе не список, песня остаётся в каталоге без строк («Вместе» недоступно).
        let none = one_song(r#""не список""#).unwrap();
        assert!(none.get("s").unwrap().lines.is_empty());
    }

    #[test]
    fn line_ends_come_from_words_then_phrases_then_the_next_line() {
        let song = scoring_core::Song { hop_ms: 10.0, duration_s: 10.0, f0_midi: vec![], phrases: vec![] };
        let lyrics = [Some(LyricLine { t: 1.0, text: "раз два · три".into() }), Some(LyricLine { t: 5.0, text: "четыре".into() })];
        let spans = line_spans(&lyrics, None, &song);
        assert_eq!((spans[0].end_s, spans[0].words, spans[1].end_s), (5.0, 3, 10.0));
        let words = WordTiming {
            lines: vec![
                WordLine { words: vec![TimedWord { text: "раз".into(), end_s: 1.5 }, TimedWord { text: "два".into(), end_s: 2.4 }] },
                WordLine { words: vec![TimedWord { text: "четыре".into(), end_s: 6.0 }] },
            ],
        };
        let spans = line_spans(&lyrics, Some(&words), &song);
        assert_eq!((spans[0].end_s, spans[0].words, spans[1].end_s), (2.4, 2, 6.0));
        let phrased = scoring_core::Song { phrases: vec![scoring_core::Phrase { start_s: 1.0, end_s: 3.0 }, scoring_core::Phrase { start_s: 5.0, end_s: 7.0 }], ..song };
        assert_eq!(line_spans(&lyrics, None, &phrased)[0].end_s, 3.0);
    }
}
