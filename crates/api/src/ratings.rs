//! Рейтинг: Elo с явной калибровкой, ранги и правило защиты новичков.
//! Числа — стартовые настройки из ТЗ (GameConfig), их нужно калибровать.
use crate::config::GameConfig;
use crate::error::ApiResult;
use crate::state::AppState;
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, PartialEq, sqlx::FromRow)]
pub struct Rating {
    pub mmr: f64,
    pub peak_mmr: f64,
    pub rated_matches: i32,
}

impl Rating {
    pub fn initial(cfg: &GameConfig) -> Self {
        Self { mmr: cfg.start_mmr, peak_mmr: cfg.start_mmr, rated_matches: 0 }
    }
    pub fn calibrating(&self, cfg: &GameConfig) -> bool {
        self.rated_matches < cfg.calibration_matches
    }
    /// Защищаемый новичок: калибровка пройдена, меньше 20 матчей и MMR ниже 1100.
    pub fn protected(&self, cfg: &GameConfig) -> bool {
        !self.calibrating(cfg) && self.rated_matches < cfg.protected_matches && self.mmr < cfg.protected_below_mmr
    }
    /// Сильный игрок для правила защиты: текущий или исторический подтверждённый MMR ≥ 1400.
    pub fn strong(&self, cfg: &GameConfig) -> bool {
        self.mmr.max(self.peak_mmr) >= cfg.protected_forbidden_mmr
    }
}

pub fn expected(player: f64, opponent: f64) -> f64 {
    1.0 / (1.0 + 10f64.powf((opponent - player) / 400.0))
}

pub struct Update {
    pub k: f64,
    pub expected: f64,
    pub after: Rating,
}

/// MMR_new = MMR_old + K × (S − E). K = 40 на калибровке, затем 24. Без округления.
pub fn apply(cfg: &GameConfig, player: Rating, opponent_mmr: f64, actual: f64) -> Update {
    let k = if player.calibrating(cfg) { cfg.k_calibration } else { cfg.k_regular };
    let e = expected(player.mmr, opponent_mmr);
    let mmr = player.mmr + k * (actual - e);
    Update {
        k,
        expected: e,
        after: Rating { mmr, peak_mmr: player.peak_mmr.max(mmr), rated_matches: player.rated_matches + 1 },
    }
}

/// Можно ли свести двух игроков с учётом окон обоих, пула и защиты новичков.
/// Окна передаются уже рассчитанными по времени ожидания каждого.
pub fn compatible(cfg: &GameConfig, a: &Rating, window_a: f64, b: &Rating, window_b: f64) -> bool {
    if a.calibrating(cfg) != b.calibrating(cfg) {
        return false;
    }
    let diff = (a.mmr - b.mmr).abs();
    if diff > window_a.min(window_b) {
        return false;
    }
    for (x, y) in [(a, b), (b, a)] {
        if x.protected(cfg) && (y.strong(cfg) || diff > cfg.protected_max_diff) {
            return false;
        }
    }
    true
}

/// Окно близости: ±80, каждые 15 секунд +20, максимум ±150; защищаемому — не больше ±100.
pub fn window(cfg: &GameConfig, rating: &Rating, waited_ms: i64) -> f64 {
    let steps = (waited_ms.max(0) as u64 / 1000 / cfg.window_step_seconds) as f64;
    let w = (cfg.window_start + cfg.window_step * steps).min(cfg.window_max);
    if rating.protected(cfg) { w.min(cfg.protected_max_diff) } else { w }
}

pub fn rank(mmr: f64) -> &'static str {
    match mmr {
        m if m < 1000.0 => "Новичок",
        m if m < 1200.0 => "Любитель",
        m if m < 1400.0 => "Исполнитель",
        m if m < 1600.0 => "Вокалист",
        _ => "Виртуоз",
    }
}

#[derive(Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// MMR, округлённый для отображения.
    pub mmr: i64,
    pub rated_matches: i32,
    pub calibration_total: i32,
    pub calibrating: bool,
    /// Ранг показывается только после калибровки.
    pub rank: Option<&'static str>,
    pub protected: bool,
}

impl Summary {
    pub fn of(cfg: &GameConfig, r: &Rating) -> Self {
        let calibrating = r.calibrating(cfg);
        Self {
            mmr: r.mmr.round() as i64,
            rated_matches: r.rated_matches,
            calibration_total: cfg.calibration_matches,
            calibrating,
            rank: (!calibrating).then(|| rank(r.mmr)),
            protected: r.protected(cfg),
        }
    }
}

pub async fn load<'e, E: sqlx::PgExecutor<'e>>(db: E, cfg: &GameConfig, user: Uuid) -> ApiResult<Rating> {
    Ok(sqlx::query_as::<_, Rating>("SELECT mmr, peak_mmr, rated_matches FROM ratings WHERE user_id = $1")
        .bind(user)
        .fetch_optional(db)
        .await?
        .unwrap_or(Rating::initial(cfg)))
}

pub async fn summary(state: &AppState, user: Uuid) -> ApiResult<Summary> {
    Ok(Summary::of(&state.cfg.game, &load(&state.db, &state.cfg.game, user).await?))
}

/// Строка таблицы лидеров: место среди откалиброванных игроков, имя и MMR.
#[derive(Serialize, schemars::JsonSchema, sqlx::FromRow)]
#[serde(rename_all = "camelCase")]
pub struct LeaderRow {
    pub place: i64,
    pub name: String,
    pub mmr: i64,
    #[serde(skip)]
    #[schemars(skip)]
    pub user_id: Uuid,
    /// Это строка текущего игрока.
    #[sqlx(skip)]
    pub me: bool,
}

#[derive(Serialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Leaderboard {
    /// Первые места: только игроки, прошедшие калибровку.
    pub top: Vec<LeaderRow>,
    /// Место текущего игрока, если он откалиброван и не попал в первые места.
    pub me: Option<LeaderRow>,
}

// Место — rank() среди откалиброванных игроков; запросы статические, параметры связываются.
const LEADERS_TOP: &str = "SELECT user_id, name, mmr, place FROM (
    SELECT r.user_id, u.name, round(r.mmr)::bigint AS mmr, rank() OVER (ORDER BY r.mmr DESC) AS place
    FROM ratings r JOIN users u ON u.id = r.user_id WHERE r.rated_matches >= $1) t ORDER BY place, name LIMIT $2";
const LEADERS_ME: &str = "SELECT user_id, name, mmr, place FROM (
    SELECT r.user_id, u.name, round(r.mmr)::bigint AS mmr, rank() OVER (ORDER BY r.mmr DESC) AS place
    FROM ratings r JOIN users u ON u.id = r.user_id WHERE r.rated_matches >= $1) t WHERE user_id = $2";

pub async fn leaderboard(state: &AppState, user: Uuid, limit: i64) -> ApiResult<Leaderboard> {
    let min = state.cfg.game.calibration_matches;
    let mut top: Vec<LeaderRow> = sqlx::query_as(LEADERS_TOP)
        .bind(min)
        .bind(limit)
        .fetch_all(&state.db)
        .await?;
    for row in &mut top {
        row.me = row.user_id == user;
    }
    let me = if top.iter().any(|r| r.me) {
        None
    } else {
        sqlx::query_as::<_, LeaderRow>(LEADERS_ME)
            .bind(min)
            .bind(user)
            .fetch_optional(&state.db)
            .await?
            .map(|r| LeaderRow { me: true, ..r })
    };
    Ok(Leaderboard { top, me })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(mmr: f64, peak: f64, n: i32) -> Rating {
        Rating { mmr, peak_mmr: peak, rated_matches: n }
    }

    #[test]
    fn elo_follows_formula() {
        let cfg = GameConfig::default();
        let u = apply(&cfg, r(1000.0, 1000.0, 0), 1000.0, 1.0);
        assert_eq!(u.k, 40.0);
        assert_eq!(u.after.mmr, 1020.0);
        let u = apply(&cfg, r(1200.0, 1250.0, 15), 1000.0, 0.0);
        assert_eq!(u.k, 24.0);
        let e = 1.0 / (1.0 + 10f64.powf(-200.0 / 400.0));
        assert!((u.after.mmr - (1200.0 - 24.0 * e)).abs() < 1e-12);
        assert_eq!(u.after.peak_mmr, 1250.0, "пик не стирается поражением");
        assert_eq!(apply(&cfg, r(1000.0, 1000.0, 3), 1000.0, 0.5).after.mmr, 1000.0);
    }

    #[test]
    fn window_expands_and_caps() {
        let cfg = GameConfig::default();
        let p = r(1150.0, 1150.0, 30);
        assert_eq!(window(&cfg, &p, 0), 80.0);
        assert_eq!(window(&cfg, &p, 14_999), 80.0);
        assert_eq!(window(&cfg, &p, 15_000), 100.0);
        assert_eq!(window(&cfg, &p, 600_000), 150.0);
        let newbie = r(1050.0, 1050.0, 12);
        assert!(newbie.protected(&cfg));
        assert_eq!(window(&cfg, &newbie, 600_000), 100.0);
    }

    #[test]
    fn protection_survives_long_waits() {
        let cfg = GameConfig::default();
        let newbie = r(1090.0, 1090.0, 12);
        // Сильный по истории игрок, временно опустившийся до 1180: близко, но запрещён.
        let fallen_star = r(1180.0, 1450.0, 80);
        let wa = window(&cfg, &newbie, 3_600_000);
        let wb = window(&cfg, &fallen_star, 3_600_000);
        assert!(!compatible(&cfg, &newbie, wa, &fallen_star, wb));
        // Разница больше 100 запрещена новичку даже при максимальном окне.
        let regular = r(1195.0, 1195.0, 40);
        assert!(!compatible(&cfg, &newbie, wa, &regular, window(&cfg, &regular, 3_600_000)));
        let close = r(1150.0, 1150.0, 40);
        assert!(compatible(&cfg, &newbie, wa, &close, window(&cfg, &close, 3_600_000)));
    }

    #[test]
    fn calibration_pool_is_separate() {
        let cfg = GameConfig::default();
        let a = r(1000.0, 1000.0, 3);
        let b = r(1010.0, 1010.0, 25);
        assert!(!compatible(&cfg, &a, 150.0, &b, 150.0));
        assert!(compatible(&cfg, &a, 80.0, &r(1060.0, 1060.0, 9), 80.0));
    }

    #[test]
    fn both_windows_must_fit() {
        let cfg = GameConfig::default();
        let a = r(1300.0, 1300.0, 50);
        let b = r(1400.0, 1400.0, 50);
        assert!(!compatible(&cfg, &a, 150.0, &b, 80.0), "критерий должен подходить обоим");
        assert!(compatible(&cfg, &a, 150.0, &b, 100.0));
    }

    #[test]
    fn ranks_follow_thresholds() {
        assert_eq!(rank(999.9), "Новичок");
        assert_eq!(rank(1000.0), "Любитель");
        assert_eq!(rank(1399.99), "Исполнитель");
        assert_eq!(rank(1400.0), "Вокалист");
        assert_eq!(rank(1600.0), "Виртуоз");
    }
}
