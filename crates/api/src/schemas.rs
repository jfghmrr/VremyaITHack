//! Генерация JSON-схем контрактов. Клиентские типы создаются из них
//! (web/scripts/gen-types.mjs), CI проверяет, что файлы не устарели.
use crate::protocol::{ClientEnvelope, MatchView, ServerEnvelope};
use std::path::Path;

pub fn write(dir: &str) -> anyhow::Result<()> {
    let dir = Path::new(dir);
    std::fs::create_dir_all(dir)?;
    let files = [
        ("client-message.schema.json", schemars::schema_for!(ClientEnvelope)),
        ("server-message.schema.json", schemars::schema_for!(ServerEnvelope)),
        ("match-view.schema.json", schemars::schema_for!(MatchView)),
        ("profile.schema.json", schemars::schema_for!(crate::accounts::Profile)),
        ("friends.schema.json", schemars::schema_for!(crate::friends::Friends)),
        ("rating.schema.json", schemars::schema_for!(crate::ratings::Summary)),
        ("leaderboard.schema.json", schemars::schema_for!(crate::ratings::Leaderboard)),
        ("song-info.schema.json", schemars::schema_for!(crate::catalog::SongInfo)),
        ("attempt.schema.json", schemars::schema_for!(crate::history::AttemptIn)),
    ];
    for (name, schema) in files {
        std::fs::write(dir.join(name), serde_json::to_string_pretty(&schema)? + "\n")?;
    }
    println!("Схемы записаны в {}", dir.display());
    Ok(())
}
