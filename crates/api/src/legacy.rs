//! Импорт кабинетов из SQLite прежней версии в PostgreSQL.
//!
//! Переносятся пользователи с исходными scrypt-хешами (повторная регистрация не нужна),
//! действующие сессии (вход сохраняется) и история попыток. Импорт идемпотентен:
//! повторный запуск ничего не дублирует. После вставки количества сверяются, при
//! расхождении транзакция откатывается. `--dry-run` всегда откатывает транзакцию.
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{ConnectOptions, PgPool, Row};
use std::str::FromStr;
use uuid::Uuid;

pub async fn import(pg: &PgPool, path: &str, dry_run: bool) -> anyhow::Result<()> {
    let mut lite = SqliteConnectOptions::from_str(&format!("sqlite://{path}"))?.read_only(true).connect().await?;
    let users = sqlx::query("SELECT id, email, name, salt, password FROM users").fetch_all(&mut lite).await?;
    let now_ms = crate::util::now_ms();
    let sessions = sqlx::query("SELECT hash, user_id, expires FROM sessions WHERE expires > ?").bind(now_ms).fetch_all(&mut lite).await?;
    let attempts = sqlx::query("SELECT id, user_id, at, payload FROM attempts").fetch_all(&mut lite).await?;
    println!("Источник: {} пользователей, {} действующих сессий, {} попыток", users.len(), sessions.len(), attempts.len());

    let mut tx = pg.begin().await?;
    let mut user_ids = Vec::new();
    for r in &users {
        let id = Uuid::parse_str(r.get::<&str, _>("id"))?;
        let email: String = r.get("email");
        sqlx::query(
            "INSERT INTO users (id, email, name, password_salt, password_hash, imported_from_legacy)
             VALUES ($1, $2, $3, $4, $5, true) ON CONFLICT (id) DO NOTHING",
        )
        .bind(id)
        .bind(email.to_lowercase())
        .bind(r.get::<String, _>("name"))
        .bind(r.get::<String, _>("salt"))
        .bind(r.get::<String, _>("password"))
        .execute(&mut *tx)
        .await?;
        user_ids.push(id);
    }
    for r in &sessions {
        let expires_ms: i64 = r.get("expires");
        let expires = time::OffsetDateTime::from_unix_timestamp_nanos(expires_ms as i128 * 1_000_000)?;
        sqlx::query("INSERT INTO sessions (hash, user_id, expires_at) VALUES ($1, $2, $3) ON CONFLICT (hash) DO NOTHING")
            .bind(r.get::<String, _>("hash"))
            .bind(Uuid::parse_str(r.get::<&str, _>("user_id"))?)
            .bind(expires)
            .execute(&mut *tx)
            .await?;
    }
    let mut skipped = 0;
    let mut imported_attempts = 0i64;
    for r in &attempts {
        let Ok(id) = Uuid::parse_str(r.get::<&str, _>("id")) else {
            skipped += 1;
            continue;
        };
        let at = time::OffsetDateTime::parse(r.get::<&str, _>("at"), &time::format_description::well_known::Rfc3339)?;
        let payload: serde_json::Value = serde_json::from_str(r.get::<&str, _>("payload"))?;
        sqlx::query("INSERT INTO attempts (id, user_id, at, payload) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING")
            .bind(id)
            .bind(Uuid::parse_str(r.get::<&str, _>("user_id"))?)
            .bind(at)
            .bind(payload)
            .execute(&mut *tx)
            .await?;
        imported_attempts += 1;
    }
    let (pg_users,): (i64,) = sqlx::query_as("SELECT count(*) FROM users WHERE id = ANY($1)").bind(&user_ids).fetch_one(&mut *tx).await?;
    let (pg_attempts,): (i64,) = sqlx::query_as("SELECT count(*) FROM attempts WHERE user_id = ANY($1)").bind(&user_ids).fetch_one(&mut *tx).await?;
    println!("В PostgreSQL: {pg_users} пользователей, {pg_attempts} попыток (пропущено некорректных id: {skipped})");
    if pg_users != users.len() as i64 || pg_attempts < imported_attempts {
        tx.rollback().await?;
        anyhow::bail!("количества не совпадают, импорт отменён");
    }
    if dry_run {
        tx.rollback().await?;
        println!("Пробный запуск: изменения откатаны.");
    } else {
        tx.commit().await?;
        println!("Импорт завершён.");
    }
    Ok(())
}
