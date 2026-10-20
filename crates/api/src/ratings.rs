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

/// Почему двоих из очереди пока нельзя свести. Поиск показывает это игроку, а не крутится молча.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Block {
    /// Защита новичков: один защищён, другой сильный по текущему или историческому MMR.
    Protected,
    /// Один проходит калибровку, другой нет: пулы откроются друг для друга через `opens_in_ms`
    /// (к этому моменту окна обоих уже вмещают разницу).
    Pool { opens_in_ms: i64 },
    /// Разница уровня больше окна одного из двоих; `fits_in_ms` — когда окна обоих её вместят,
    /// `None` — никогда (больше предела окна).
    Window { diff: f64, fits_in_ms: Option<i64> },
}

/// Пулы калибровки и основной открываются друг для друга, когда оба ждут не меньше
/// `cross_pool_seconds`: двое в очереди не ждут вечно только потому, что один уже откалиброван.
pub fn pools_open(cfg: &GameConfig, waited_a_ms: i64, waited_b_ms: i64) -> bool {
    let need = (cfg.cross_pool_seconds * 1000) as i64;
    waited_a_ms.min(waited_b_ms) >= need
}

/// Можно ли свести двух игроков с учётом окон обоих, пула и защиты новичков. Время ожидания
/// каждого определяет его окно и открытие пулов друг для друга.
pub fn check(cfg: &GameConfig, a: &Rating, waited_a_ms: i64, b: &Rating, waited_b_ms: i64) -> Result<(), Block> {
    let diff = (a.mmr - b.mmr).abs();
    for (x, y) in [(a, b), (b, a)] {
        if x.protected(cfg) && y.strong(cfg) {
            return Err(Block::Protected);
        }
    }
    let fits_in = |r: &Rating, waited: i64| -> Option<i64> {
        if window(cfg, r, waited) >= diff {
            return Some(0);
        }
        let cap = if r.protected(cfg) { cfg.window_max.min(cfg.protected_max_diff) } else { cfg.window_max };
        if cap < diff {
            return None;
        }
        let steps = ((diff - cfg.window_start) / cfg.window_step).ceil().max(0.0) as i64;
        Some((steps * cfg.window_step_seconds as i64 * 1000 - waited).max(0))
    };
    let fits = match (fits_in(a, waited_a_ms), fits_in(b, waited_b_ms)) {
        (Some(x), Some(y)) => Some(x.max(y)),
        _ => None,
    };
    if a.calibrating(cfg) != b.calibrating(cfg) && !pools_open(cfg, waited_a_ms, waited_b_ms) {
        let need = (cfg.cross_pool_seconds * 1000) as i64;
        let opens = (need - waited_a_ms).max(need - waited_b_ms).max(0);
        return match fits {
            Some(f) => Err(Block::Pool { opens_in_ms: opens.max(f) }),
            None => Err(Block::Window { diff, fits_in_ms: None }),
        };
    }
    match fits {
        Some(0) => Ok(()),
        fits_in_ms => Err(Block::Window { diff, fits_in_ms }),
    }
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

    const HOUR: i64 = 3_600_000;

    #[test]
    fn protection_survives_long_waits() {
        let cfg = GameConfig::default();
        let newbie = r(1090.0, 1090.0, 12);
        // Сильный по истории игрок, временно опустившийся до 1180: близко, но запрещён.
        let fallen_star = r(1180.0, 1450.0, 80);
        assert_eq!(check(&cfg, &newbie, HOUR, &fallen_star, HOUR), Err(Block::Protected));
        // Разница больше 100 запрещена новичку даже при максимальном окне.
        let regular = r(1195.0, 1195.0, 40);
        assert!(matches!(check(&cfg, &newbie, HOUR, &regular, HOUR), Err(Block::Window { fits_in_ms: None, .. })));
        let close = r(1150.0, 1150.0, 40);
        assert_eq!(check(&cfg, &newbie, HOUR, &close, HOUR), Ok(()));
        // Защита действует и тогда, когда сильный игрок ещё проходит калибровку (пулы уже открыты).
        let calibrating_star = r(1060.0, 1450.0, 4);
        assert_eq!(check(&cfg, &newbie, HOUR, &calibrating_star, HOUR), Err(Block::Protected));
    }

    #[test]
    fn calibration_pool_opens_after_wait() {
        let cfg = GameConfig::default();
        let a = r(1000.0, 1000.0, 3);
        let b = r(1010.0, 1010.0, 25);
        // Сначала пулы раздельны: подбор ищет среди таких же.
        assert_eq!(check(&cfg, &a, 0, &b, 0), Err(Block::Pool { opens_in_ms: 30_000 }));
        assert_eq!(check(&cfg, &a, 40_000, &b, 12_000), Err(Block::Pool { opens_in_ms: 18_000 }));
        // Оба ждут 30 секунд: калибровка больше не разделяет, окна по-прежнему должны подходить.
        assert_eq!(check(&cfg, &a, 30_000, &b, 30_000), Ok(()));
        assert_eq!(check(&cfg, &a, 0, &r(1060.0, 1060.0, 9), 0), Ok(()));
        // Пул открывается не раньше, чем окна вместят разницу.
        let far = r(1110.0, 1110.0, 25);
        assert_eq!(check(&cfg, &a, 0, &far, 0), Err(Block::Pool { opens_in_ms: 30_000 }));
        let farther = r(1130.0, 1130.0, 25);
        assert_eq!(check(&cfg, &a, 0, &farther, 0), Err(Block::Pool { opens_in_ms: 45_000 }));
        // Разница больше предела окна — пары не будет ни в каком пуле.
        assert!(matches!(check(&cfg, &a, HOUR, &r(1200.0, 1200.0, 25), HOUR), Err(Block::Window { fits_in_ms: None, .. })));
    }

    /// Решение владельца (2026-10-17): защищаемый новичок после 30 с ожидания может встретить
    /// игрока на калибровке — только в пределах ±100 MMR и не сильного по истории.
    #[test]
    fn protected_newbie_meets_calibrating_player_within_100() {
        let cfg = GameConfig::default();
        let newbie = r(1080.0, 1080.0, 12);
        assert!(newbie.protected(&cfg));
        let calibrating = r(1000.0, 1000.0, 3);
        assert!(matches!(check(&cfg, &newbie, 0, &calibrating, 0), Err(Block::Pool { .. })));
        assert_eq!(check(&cfg, &newbie, 30_000, &calibrating, 30_000), Ok(()));
        let far = r(970.0, 970.0, 3);
        assert!(matches!(check(&cfg, &newbie, HOUR, &far, HOUR), Err(Block::Window { fits_in_ms: None, .. })));
    }

    #[test]
    fn both_windows_must_fit() {
        let cfg = GameConfig::default();
        let a = r(1300.0, 1300.0, 50);
        let b = r(1400.0, 1400.0, 50);
        // Окно Б ещё ±80 (только вошёл), окно А уже ±150: критерий должен подходить обоим.
        assert_eq!(check(&cfg, &a, 60_000, &b, 0), Err(Block::Window { diff: 100.0, fits_in_ms: Some(15_000) }));
        assert_eq!(check(&cfg, &a, 60_000, &b, 15_000), Ok(()));
        // Разница 107 у двоих, вошедших одновременно: окна ±120 через 30 секунд.
        let c = r(1000.0, 1000.0, 30);
        let d = r(1107.0, 1107.0, 30);
        assert_eq!(check(&cfg, &c, 0, &d, 0), Err(Block::Window { diff: 107.0, fits_in_ms: Some(30_000) }));
        assert_eq!(check(&cfg, &c, 31_000, &d, 31_000), Ok(()));
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
