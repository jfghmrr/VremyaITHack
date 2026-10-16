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
        for IndexEntry { mut info, language, words_check } in index {
            anyhow::ensure!(valid_id(&info.id), "invalid song id {:?}", info.id);
            let bytes = std::fs::read(dir.join(&info.id).join("reference.json"))?;
            let song: scoring_core::Song = serde_json::from_slice(&bytes)?;
            // Те же ограничения, что проверяет клиент при загрузке эталона.
            anyhow::ensure!(
                song.hop_ms == 10.0 && song.duration_s > 0.0 && song.duration_s <= 60.0 && song.f0_midi.len() <= 6001,
                "unsupported reference for {}",
                info.id
            );
            info.version = crate::util::sha256_hex(&bytes)[..12].to_owned();
            info.duration_s = song.duration_s;
            songs.insert(info.id.clone(), CatalogSong { info, song, language, words_check });
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
}
