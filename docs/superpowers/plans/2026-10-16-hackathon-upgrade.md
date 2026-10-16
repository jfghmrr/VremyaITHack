# Perepev Hackathon Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship by the 2026-10-17 defense:
- a Russian error page;
- phone-first responsive layouts;
- demo-grade Russian legal mechanics with Yandex ID and VK ID sign-in;
- GPU-worker scoring that checks sung words, with speaker-bleed protection;
- "sing your own track";
- free catalog additions;
- a Windows worker installer.

**Architecture:**
- The Rust API (Axum, SQLx, PostgreSQL) gains a pull-based job queue for an outbound-only Python GPU worker.
- `scoring-core` gains `score_precise` with a words component and caps.
- The SvelteKit client streams 16 kHz PCM while singing, then shows provisional → final scores. It plays instrumental plus guide-vocal stems, and uploads a chosen section of a user's track for private processing.

**Tech Stack:** Rust 1.99 (axum 0.8, sqlx 0.9, tokio), SvelteKit 3 / Svelte 5 / TypeScript 6 / Vite 8 / Playwright 1.64, Python 3.12 (uv, torch, demucs, torchcrepe, faster-whisper, soundfile), PowerShell 5.1+.

**Spec:** `docs/superpowers/specs/2026-10-16-hackathon-upgrade-design.md`. §6a overrides the rest of the spec.

## Global Constraints

- **Branch and commits:**
  - Branch `hackathon-upgrade`; each stream works in its own worktree and merges back.
  - Commit titles are short and in Russian, with no body and no co-author trailer.
- **Copyright:**
  - Never download or commit copyrighted hit recordings.
  - Catalog additions must be public-domain compositions with PD/CC0/CC BY/CC BY-SA recordings (CC BY-NC only as a fallback; never ND).
- **Model and code licences:** no MMS aligner weights, viperx/UVR karaoke weights, TEN VAD, Essentia.js or GPL code.
- **UI and accessibility:**
  - All user-facing text is in Russian.
  - Touch targets ≥ 44 px.
  - No third-party scripts, fonts or CDNs in the web app.
- **Secrets:** never in the repo. These are environment-only: OAuth secrets, `WORKER_TOKEN_SHA256` and the DB password.
- **Personal data:**
  - Voice recordings are deleted after the score job, or after 10 min at most.
  - Uploaded tracks are deleted after 24 h.
  - Only the chosen section is ever uploaded.
- **Sign-in:** Yandex ID and VK ID plus the existing email/password. No Google.
- **Precise scoring:**
  - Weights stay at 0.45 / 0.25 / 0.15 / 0.15.
  - "Ритм и слова" = 0.5 × rhythm + 0.5 × words when words are checked.
  - Words cap: 40 if sung fraction < 0.30. Bleed cap: 30. Existing caps stay.
  - Duel `ALGORITHM_VERSION` stays 1; the precise tag is `"precise-1"`.
- **Deadlines:** the worker heartbeat goes stale at 30 s; the score-job deadline is 20 s after finish; long-poll lease is 25 s.
- **Existing tests must stay green:** `cargo test --release --workspace`, `cd web && npm run check && npx vitest run`, the Playwright e2e suite.
- **Docs:** update `PROJECT_OVERVIEW.md`, `ARCHITECTURE.md`, `OPERATIONS.md`, `WORK_DONE.md` (dated entry with real test results) and `README.md` where affected. English is fine for new text.

## Parallel environments (every stream uses only its own)

Local services: PostgreSQL 16 at `postgres://$USER@localhost` and Valkey at `127.0.0.1:6379` are already running on the Mac.

| Stream | Worktree | Integration DB (`TEST_DATABASE_URL`) | `TEST_VALKEY_URL` | `TEST_PORT_OFFSET` | e2e API port / DB | e2e preview port |
|---|---|---|---|---|---|---|
| A | `../Perepev-wt-api-jobs` | `…/perepev_test_a` | `redis://127.0.0.1:6379/2` | 100 | — | — |
| B | `../Perepev-wt-api-auth` | `…/perepev_test_b` | `redis://127.0.0.1:6379/3` | 200 | — | — |
| C | `../Perepev-wt-worker` | — | — | — | — | — |
| D | `../Perepev-wt-layout` | — | — | — | 3401 / `perepev_e2e_d`, Valkey db 4 | 4401 |
| E | `../Perepev-wt-ui` | — | — | — | 3501 / `perepev_e2e_e`, Valkey db 5 | 4501 |

- e2e runs: build the API (`cargo build --release -p api`) and start it with `BIND=127.0.0.1:<port> DATABASE_URL=… VALKEY_URL=… SONGS_DIR=web/static/songs APP_ORIGINS=http://127.0.0.1:<preview>`.
- Then `cd web && npm ci && npm run build && API_URL=http://127.0.0.1:<port> npx vite preview --host 127.0.0.1 --port <preview>`.
- Then `BASE_URL=http://127.0.0.1:<preview> npx playwright test …`.
- The API registration limit is 12 per IP per 15 min. Between e2e files, clear `kv:rl:*` keys in the stream's own Valkey db only.

## Shared contracts (every stream reads this)

### C1. Song stems

- Catalog song dirs may contain `instrumental.mp3` and `guide.mp3` (the separated vocal), both time-aligned with `backing.mp3`.
- `web/static/songs/index.json` entries gain `"stems": true` when both exist.
- `reference.json` is NOT changed, so reference versions stay stable.

### C2. Worker protocol

Auth: header `Authorization: Bearer <token>`. The server compares `sha256(token)` with env `WORKER_TOKEN_SHA256`. These routes are exempt from the browser CSRF guard and have their own body limits.

| Route | Request | Response |
|---|---|---|
| `POST /api/worker/lease` | `{"worker":"pc-1","kinds":["score","track","catalog"]}` | `200 {"job":Job}`, or `204` after ≤25 s. Also counts as a heartbeat. |
| `POST /api/worker/heartbeat` | `{"worker":"pc-1"}` | `204` |
| `GET /api/worker/jobs/{id}/input` | | Input audio bytes (`audio/wav`) |
| `GET /api/worker/jobs/{id}/asset/{name}` | | For `score` jobs: the stems the singer heard (`instrumental.mp3`, `guide.mp3`) for catalog songs or private tracks |
| `POST /api/worker/jobs/{id}/progress` | `{"stage":"separating"\|"melody"\|"words"}` | `204` |
| `PUT /api/worker/jobs/{id}/files/{name}` | Binary file, ≤ 20 MB | `204`. Names: `instrumental.mp3`, `guide.mp3`, `backing.mp3`, `reference.json`, `lyrics.words.json` |
| `POST /api/worker/jobs/{id}/complete` | `ScoreOutput` or `TrackOutput` JSON | `204`. Idempotent. |
| `POST /api/worker/jobs/{id}/fail` | `{"error":"..."}` | `204` |

`Job` object:

```json
{ "id": "uuid", "kind": "score|track", "lease_ttl_s": 120, "params": { } }
```

`params` per kind:

- **score:**

```json
{ "sample_rate": 16000, "language": "ru|en", "duration_s": 13.87,
  "words": [{"index":0,"line":0,"text":"Пусть","start_s":1.2,"end_s":1.5}],
  "assets": ["instrumental.mp3","guide.mp3"], "mode": "headphones|speaker" }
```

- **track:** `{"language":"ru|en","title":"...","margin_s":2.0,"track_id":"uuid"}`. The worker names the generated reference `my-<track_id>` (amended 2026-10-16: the client rejects a reference whose id differs from the requested song id).

Input formats:

- **score:** WAV, 16 kHz mono PCM16; t = 0 is song time 0.
- **track:** WAV, 44.1 kHz mono PCM16; the chosen section plus 2 s margins.

`ScoreOutput`:

```json
{ "frames": [{"t":0.0,"midi":null}],
  "words": [{"index":0,"sung":0.0,"onset_s":null}],
  "asr_text": "...",
  "bleed": {"instrumental":0.0,"guide":0.0},
  "models": {"pitch":"torchcrepe-full","asr":"faster-whisper-large-v3-turbo"} }
```

- `frames` use a 10 ms hop and song time.
- `bleed.*` is the max normalised cross-correlation in 0..1.

`TrackOutput`:

```json
{ "duration_s": 31.2, "lines": 6, "words": 41, "masked_words": 0, "models": { } }
```

The generated `reference.json` follows the existing format: `hop_ms` 10, `f0_midi`, `phrases`, `lyrics`, `backing: "backing.mp3"`.

### C3. Client API (browser; same CSRF guard as today)

**Performance scoring:**

- `POST /api/perf`, JSON:

```json
{ "songId":"cn-earth" | "my-<uuid>", "mode":"headphones|speaker", "voiceConsent": true, "consentVersion":"2026-10-17" }
```

  Returns `201 {"id":"uuid"}`.
  - Guests are allowed; they get a cookie `perepev_guest` (random 32 hex, HttpOnly, SameSite=Strict).
  - Rate limit: 30 per hour per IP.
- `PUT /api/perf/{id}/chunk?seq={n}`: body `application/octet-stream`, raw PCM16 LE, 16 kHz mono, ≤ 400 KB. Returns `204`. Total limit is 70 s of audio.
- `POST /api/perf/{id}/finish`, JSON `{"chunks":n}`: enqueues the score job. Returns `202`.
- `GET /api/perf/{id}`: returns `{"status":"queued|running|done|failed|offline", "result": PreciseResult | null}`.
  - The status becomes `offline` immediately if the worker is stale, or when the 20 s deadline passes.

**Own tracks** (sign-in required, 5 per user per 24 h):

- `POST /api/tracks`, JSON `{"title":"...","language":"ru|en"}` → `201 {"id":"uuid"}`.
- `PUT /api/tracks/{id}/audio`: `audio/wav`, ≤ 12 MB. Returns `202` and enqueues the track job.
- `GET /api/tracks` → `{"tracks":[{"id","title","language","status":"queued|running|ready|failed|offline","stage":null|"separating"|"melody"|"words","error":null,"expiresAt":"RFC3339"}]}`.
- `GET /api/tracks/{id}/files/{name}`: owner only; the same names as C2.
- `DELETE /api/tracks/{id}` → `204`.

**Health:** `GET /api/health` gains `"worker": true|false`.

**Song ids:** client song ids `my-<uuid>` load files from `/api/tracks/<uuid>/files/`. All other ids load from `/songs/<id>/`.

**OAuth:**

- `GET /api/auth/providers` → `{"providers":["yandex","vk"]}`. A provider is listed only when its env vars are set.
- `GET /api/auth/{provider}/start?return=/path` → `302` to the provider, with PKCE S256 and a state of 43 or more chars.
  - The state is kept in Valkey for 10 min, keyed by state.
  - The temp cookie `perepev_oauth` is `SameSite=Lax`.
- `GET /api/auth/{provider}/callback?code&state[&device_id]` → three outcomes:
  - a known identity → session, then `302 {return}`;
  - a new identity → a Valkey pending-signup token (10 min), then `302 /account?signup={token}`;
  - an error → `302 /account?authError={code}`.
- `POST /api/auth/complete`, JSON:

```json
{ "token":"...", "consent":true, "ageGroup":"14plus|under14", "parentName":"..."|null }
```

  It creates the user with a generated nickname (`Певец-NNNN`), the identity row and the session. Returns `201 {"profile":...}`.

**Registration:** `POST /api/register` additionally requires `ageGroup`, plus `parentName` (2-64 chars) when `under14`.

**Accounts without a password:** `POST /api/password` and `POST /api/me/delete` accept `{"confirm":"УДАЛИТЬ"}` instead of a password when the user has no password.

**Complaints:** `POST /api/complaints`, JSON `{"name","email","url","text"}`.
- Each field ≤ 2000 chars; the email must be valid.
- Rate limit: 5 per hour per IP.
- Returns `201`.

**Precise result:** `PreciseResult` = the existing `ScoreResult` camelCase fields plus:

```json
{ "algorithm":"precise-1", "wordsChecked":true, "wordsSung":0.82, "wordsScore":0.77, "cap":null|"coverage"|"constant"|"words"|"bleed" }
```

`axes.rhythm` already includes the words half when `wordsChecked` is true.

### C4. scoring-core

New module `crates/scoring-core/src/precise.rs`, re-exported from `lib.rs`.

```rust
pub struct LyricWord { pub index: usize, pub start_s: f64, pub end_s: f64 }
pub struct WordEvidence { pub index: usize, pub sung: f64, pub onset_s: Option<f64> }
pub struct WordInput { pub words: Vec<LyricWord>, pub evidence: Vec<WordEvidence> }
pub struct Bleed { pub instrumental: f64, pub guide: f64 }
pub const PRECISE_ALGORITHM: &str = "precise-1";
pub fn score_precise(frames: &[PitchFrame], song: &Song, words: Option<&WordInput>, bleed: Option<&Bleed>) -> PreciseResult;
// PreciseResult: #[serde(flatten)] base: ScoreResult + algorithm, words_checked, words_sung, words_score, cap (camelCase)
```

---

## Stream A: core scoring and server jobs (worktree `wt-api-jobs`)

### Task A1: `score_precise` in scoring-core

**Files:**
- Create `crates/scoring-core/src/precise.rs`.
- Modify `crates/scoring-core/src/lib.rs` (mod and re-export) and `crates/scoring-core/src/config.rs` (constants).
- Test: `crates/scoring-core/tests/precise.rs`.

**Interfaces:**
- Consumes `score_performance(frames, song) -> ScoreResult` (`score.rs:19`).
- Produces C4.

Constants in `config.rs`:

```rust
WORD_TIMING_TOL_S = 0.20
WORD_TIMING_ZERO_S = 0.60
WORDS_CAP_FRACTION = 0.30
WORDS_CAP = 40.0
BLEED_GUIDE_THRESHOLD = 0.45
BLEED_CAP = 30.0
```

- [ ] **Step 1: Write failing tests**
  - `perfect_words_keep_score`: frames equal to the reference, all words sung = 1.0 with exact onsets. Expect `words_checked && words_score > 0.95 && cap.is_none()`, and the score within 2 points of `score_performance`.
  - `humming_capped_by_words`: frames equal to the reference, all `sung = 0.0` → `cap == Some("words")` and `score <= 40.0`.
  - `late_words_lower_rhythm`: onsets +0.5 s → `axes.rhythm` lower than the perfect case by > 0.15.
  - `guide_bleed_caps`: `Bleed { guide: 0.6, instrumental: 0.7 }` → `cap == Some("bleed")`, `score <= 30.0`.
  - `no_words_equals_base`: `words: None` → `!words_checked`, and score and axes equal `score_performance`.
  - Use the existing fixture loader from `tests/parity.rs` for the song (`fixtures/scoring`).
- [ ] **Step 2:** `cargo test --release -p scoring-core --test precise` → FAIL (unresolved import).
- [ ] **Step 3: Implement `score_precise`.**
  - Start from `score_performance`.
  - Per-word timing: 1.0 within TOL after removing `base.lag`, decaying linearly to 0 at ZERO.
  - `words_score` = mean over words of sung × timing (missing evidence counts as 0).
  - `words_sung` = fraction with sung ≥ 0.5.
  - `axes.rhythm` = 0.5 × rhythm + 0.5 × words_score.
  - Recompute the raw score with the existing weights.
  - Apply caps in this order: existing (coverage/constant) → bleed (`guide ≥ BLEED_GUIDE_THRESHOLD`) → words (`words_sung < WORDS_CAP_FRACTION`).
  - Round the score to 0.1.
- [ ] **Step 4:** `cargo test --release -p scoring-core` → all PASS, including parity and regressions.
- [ ] **Step 5:** Commit `Точная оценка: слова и ограничения`.

### Task A2: Job queue, worker API, perf and tracks endpoints

**Files:**
- Create:
  - `crates/api/migrations/0005_jobs.sql`
  - `crates/api/src/jobs.rs` (queue storage and leasing)
  - `crates/api/src/worker.rs` (C2 routes)
  - `crates/api/src/perf.rs` (C3 perf routes)
  - `crates/api/src/tracks.rs` (C3 track routes, file storage, cleanup task)
- Modify:
  - `crates/api/src/main.rs`: routes; exempt `/api/worker/` from `guard`; per-route body limits; `/api/health` worker flag.
  - `crates/api/src/config.rs`: `WORKER_TOKEN_SHA256`, `DATA_DIR` (default `/data`), `PERF_DEADLINE_S` (default 20).
  - `crates/api/src/state.rs`: worker last-seen.
  - `compose.yaml`: volume `data:/data` on api; pass `WORKER_TOKEN_SHA256`.
  - `Dockerfile`: create `/data` owned by uid 10001.
  - `deploy/Caddyfile`: add `Strict-Transport-Security "max-age=31536000"` to the header block.
- Test: `tests/integration/jobs.test.mjs` (node test runner, like the existing integration tests: spawns the API against `perepev_test`).

**Interfaces:**
- Consumes `score_precise` (A1); `Authed`/`MaybeSession` (`accounts.rs`); the rate limiter `check_limit`/`hit_limit` (`state.rs`).
- Produces C2 and C3 (perf, tracks, health) exactly.

`0005_jobs.sql`:
- `jobs(id uuid pk, kind text check in ('score','track'), status text check in ('queued','running','done','failed'), priority int, owner_user uuid null references users on delete cascade, guest_key text null, params jsonb, result jsonb, error text, stage text, lease_until timestamptz, created_at, finished_at)`
- `tracks(id uuid pk, user_id uuid references users on delete cascade, title text, language text, job_id uuid, created_at, expires_at)`
- `perfs(id uuid pk, song_id text, owner_user uuid null, guest_key text null, mode text, consent_version text, chunks int default 0, job_id uuid null, created_at)`

Files are stored under `DATA_DIR/jobs/<id>/input.wav` and `DATA_DIR/tracks/<id>/<name>`.

Leasing: `UPDATE … WHERE id = (SELECT id FROM jobs WHERE status='queued' OR (status='running' AND lease_until<now()) ORDER BY priority, created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING …`, polled every 500 ms up to 25 s. Score priority is 0; track priority is 1.

Score completion:
1. Load the song: catalog via `state.catalog`, or `DATA_DIR/tracks/<uuid>/reference.json` for `my-` ids.
2. Map `ScoreOutput` to `PitchFrame` / `WordInput` / `Bleed`.
3. Run `score_precise` and store the result JSON.
4. Delete the input WAV.

Cleanup task (every 60 s):
- Delete job inputs older than 10 min.
- Delete tracks and their files past `expires_at` (24 h).
- Mark score jobs past the deadline `failed` with error `"deadline"`.

- [ ] **Step 1: Write failing integration tests** in `tests/integration/jobs.test.mjs`:
  - `worker auth required`: lease without a token → 401.
  - `guest perf → score job → fake worker complete → done result with precise-1`: chunks of 16 kHz PCM; the fake worker posts frames copied from `reference.json` and all words sung.
  - `perf goes offline when no worker heartbeat`: no lease for 30 s, simulated by starting with a stale state → `GET /api/perf/{id}` status `offline` right after finish.
  - `chunk too large → 413`; `more than 70 s of audio → 413`.
  - `track upload requires login (401)`; `owner-only files (other user → 404)`; `6th upload in 24h → 429`.
  - `track job complete writes files and GET /api/tracks shows ready with expiresAt ≈ +24h`.
  - `health reports worker true after lease`.
- [ ] **Step 2:** `cd tests/integration && node --test jobs.test.mjs` → FAIL.
- [ ] **Step 3:** Implement the migration, `jobs.rs`, `worker.rs`, `perf.rs` and `tracks.rs` per the contracts; wire them in `main.rs`; add the config fields.
- [ ] **Step 4:** `cargo test --release --workspace && node --test --test-concurrency=1 tests/integration/` → all PASS.
- [ ] **Step 5:** Commit `Очередь задач, воркер, отправка исполнения и своих треков`.

## Stream B: sign-in and legal backend (worktree `wt-api-auth`)

### Task B1: Identities, OAuth providers, age group, complaints

**Files:**
- Create:
  - `crates/api/migrations/0004_identities_legal.sql`
  - `crates/api/src/oauth.rs`
  - `crates/api/src/complaints.rs`
- Modify:
  - `crates/api/src/accounts.rs`: register `ageGroup`/`parentName`; password-less confirm phrase; `Profile` gains `hasPassword: bool` and `providers: [..]`.
  - `crates/api/src/config.rs`: `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`, `VK_CLIENT_ID`, `VK_CLIENT_SECRET`, `PUBLIC_ORIGIN` (e.g. `https://perepev.lumnex.ru`, used for `redirect_uri`), `OAUTH_YANDEX_BASE` (default `https://oauth.yandex.ru`), `OAUTH_YANDEX_INFO` (default `https://login.yandex.ru/info`), `OAUTH_VK_BASE` (default `https://id.vk.ru`). The base URLs exist so tests can point at a mock.
  - `crates/api/src/main.rs`: routes.
  - `crates/api/Cargo.toml`: reqwest with rustls; it may already be present.
- Test: `tests/integration/oauth.test.mjs`. It starts a tiny mock provider HTTP server in Node and points the API's base URLs at it.

**Interfaces:**
- Produces the C3 OAuth, registration, password/delete and complaints routes.

`0004_identities_legal.sql`:
- `users.email` drop NOT NULL (keep UNIQUE); `password_salt`/`password_hash` drop NOT NULL.
- Add `users.age_group text check in ('14plus','under14')` and `users.parent_name text`.
- `identities(provider text, subject text, user_id uuid references users on delete cascade, created_at, primary key(provider, subject))`
- `complaints(id uuid pk, name text, email text, url text, body text, created_at)`

Provider endpoints:
- **Yandex:** authorize `{base}/authorize?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256&scope=login:info`; token `POST {base}/token` (form: grant_type=authorization_code, code, client_id, client_secret, code_verifier); profile `GET {info}?format=json` with `Authorization: OAuth <token>`. The subject is the `id` field.
- **VK:** authorize `{base}/authorize?response_type=code&client_id&redirect_uri&state&code_challenge&code_challenge_method=S256&scope=vkid.personal_info`; token `POST {base}/oauth2/auth` (form: grant_type=authorization_code, code, code_verifier, client_id, device_id, redirect_uri, state); the subject is `user_id` from the token response.

- [ ] **Step 1: Write failing integration tests:**
  - `providers hidden without env` → `{"providers":[]}`.
  - `start redirects with S256 challenge and 43+ char state`.
  - `callback with unknown state → 302 /account?authError=state`.
  - `new yandex identity → pending signup → complete without consent → 400 → with consent → 201 and session cookie; nickname matches /^Певец-\d{4}$/`.
  - `second login with same identity → 302 to return path with session`.
  - `vk token exchange sends device_id and code_verifier` (asserted in the mock).
  - `register under14 without parentName → 400`.
  - `password-less delete with "УДАЛИТЬ" → 200`.
  - `complaint validation 400 / ok 201 / 6th in hour 429`.
- [ ] **Step 2:** Run `node --test tests/integration/oauth.test.mjs` → FAIL.
- [ ] **Step 3:** Implement per the contracts. Copy `CONSENT_VERSION` → `"2026-10-17"`.
- [ ] **Step 4:** `cargo test --release --workspace` and all integration tests → PASS.
- [ ] **Step 5:** Commit `Вход через Яндекс ID и VK ID, возраст, жалобы правообладателей`.

## Stream C: Python GPU worker and Windows installer (worktree `wt-worker`)

### Task C1: Worker package with pipelines

**Files** (create everything under `gpu-worker/`):

| File | Contents |
|---|---|
| `pyproject.toml` | uv project; Python ≥3.12; deps pinned to exact versions resolved at implementation time: torch, torchaudio, demucs, torchcrepe, faster-whisper, soundfile, numpy, scipy, rapidfuzz, httpx. Extra `cpu` for Mac testing. |
| `perepev_worker/client.py` | C2 HTTP client |
| `perepev_worker/audio.py` | `load_audio(path, sr) -> np.ndarray`, `write_mp3(path, y, sr)` via soundfile (no ffmpeg) |
| `perepev_worker/separate.py` | `separate(y, sr) -> (vocals, instrumental)` via demucs `htdemucs` |
| `perepev_worker/pitch.py` | `f0_frames(y, sr) -> list[tuple[float, float\|None]]` via torchcrepe (10 ms hop, periodicity ≥ 0.5, 5-frame median, 65-1100 Hz) |
| `perepev_worker/words.py` | `transcribe(y, sr, language) -> list[AsrWord]` and `match_words(lyric: list[LyricWord], asr: list[AsrWord]) -> list[WordEvidence]`. Matching is fuzzy and monotonic: normalised Russian/English tokens, rapidfuzz ratio ≥ 70 counts as sung, sung = ratio/100, onset from ASR. |
| `perepev_worker/bleed.py` | `bleed(rec_16k, stem, sr) -> float`: max normalised cross-correlation of 50 ms RMS envelopes within ±0.5 s |
| `perepev_worker/profanity.py` | `mask(text) -> (masked, count)` using a built-in RU/EN obscene-root list |
| `perepev_worker/track.py` | `process_track(wav_path, language, title) -> dict[name, bytes]` |
| `perepev_worker/score.py` | `process_score(wav_path, params, assets) -> ScoreOutput` |
| `perepev_worker/catalog.py` | CLI, see below |
| `perepev_worker/main.py` | Lease loop: warm up models once, then score jobs first and heartbeats every 10 s |
| `tests/` | pytest with tiny synthetic fixtures; tests that need models are marked `@pytest.mark.models` |

`track.py` pipeline:
1. Separate; pitch on the vocals.
2. Transcribe the vocals.
3. Group words into lines by pauses > 0.6 s or > 8 words.
4. Mask profanity.
5. Build `reference.json` and `lyrics.words.json` in the existing formats.
6. Return `instrumental.mp3`, `guide.mp3` and `backing.mp3` (the section mix).

`catalog.py` CLI: `python -m perepev_worker.catalog stems <songs_dir> [--ids …]` writes `instrumental.mp3` and `guide.mp3` next to `backing.mp3` and sets `"stems": true` in `index.json`.

**Interfaces:** consumes C2 and produces C2 outputs.

- [ ] **Step 1: Write failing tests:**
  - `test_match_words_exact`: identical lyric and ASR words → all sung ≈ 1, onsets copied.
  - `test_match_words_humming`: empty ASR → all sung 0.
  - `test_match_words_reordered_tolerant`: one substituted word → others still matched.
  - `test_bleed_detects_copy`: the recording is the stem plus noise → > 0.8; unrelated noise → < 0.2.
  - `test_profanity_masks_root`.
  - `test_f0_sine` (models): a 220 Hz sine → median midi ≈ 57 ± 0.3.
  - `test_reference_json_shape`: the build function's output has hop_ms 10 and `len(f0_midi) == ceil(duration/0.01)`.
- [ ] **Step 2:** `cd gpu-worker && uv run pytest -m "not models"` → FAIL.
- [ ] **Step 3:** Implement the modules.
- [ ] **Step 4:** `uv run pytest` (including models, on the Mac CPU) → PASS. Smoke-test `process_track` on `web/static/songs/cn-earth/backing.mp3`: the output words overlap the known lyrics by ≥ 50%.
- [ ] **Step 5:** Run `catalog stems web/static/songs` for the 24 active songs, then commit `GPU-воркер: разделение, мелодия, слова, просачивание; стемы каталога`.

### Task C2: Windows installer

**Files:**
- Create `deploy/gpu-worker/setup.ps1` and `deploy/gpu-worker/README.md` (Russian, for the team).
- Test: `deploy/gpu-worker/setup.Tests.ps1` (Pester-free: plain PowerShell asserts runnable under `pwsh` on the Mac with `-DryRun`).

**`setup.ps1` parameters:** `-ServerUrl`, `-Token`, `-DryRun`, `-Uninstall`.

**Behaviour:**
1. Admin check.
2. `nvidia-smi` check: warn and continue on CPU if it's missing.
3. `winget install astral-sh.uv` if absent.
4. Copy `gpu-worker/` to `C:\Perepev\gpu-worker`.
5. `uv sync --extra cuda`, using the torch CUDA index pinned in `pyproject.toml`.
6. Pre-download models: `uv run python -m perepev_worker.main --warmup`.
7. Store the token with DPAPI: `ConvertFrom-SecureString` → `C:\Perepev\token.dat`.
8. Self-test: `--selftest`.
9. Register a scheduled task named `PerepevWorker`: at startup, run as SYSTEM, restart every 1 min up to 999 times.
10. Print the status.

`-Uninstall` removes the task and the folder.

- [ ] **Step 1:** Write `setup.Tests.ps1` asserting that `-DryRun` prints every planned step and makes no changes.
- [ ] **Step 2:** `pwsh deploy/gpu-worker/setup.Tests.ps1` → FAIL. If `pwsh` is missing, install it via brew for the test.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests → PASS.
- [ ] **Step 5:** Commit `Установщик GPU-воркера для Windows`.

## Stream D: layout and error page (worktree `wt-layout`)

### Task D1: Russian error page

**Files:**
- Create `web/src/routes/+error.svelte`.
- Test: `web/tests/e2e/error-page.spec.ts`.

- [ ] **Step 1: Failing tests:**
  - `/no-such-page` shows the heading «Такой страницы нет», plus links «На главную» and «К песням».
  - The document `<title>` contains «Страница не найдена».
  - No "Not Found" text.
- [ ] **Step 2:** `BASE_URL=… npx playwright test error-page` → FAIL.
- [ ] **Step 3:** Implement in the room style (paper card, `Cat` mood `shy`). For a non-404 status, show «Что-то пошло не так» and a «Попробовать ещё раз» button (`location.reload()`).
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `Русская страница ошибки`.

### Task D2: Responsive layout system and phone-first screens

**Files:**
- Modify:
  - `web/src/lib/styles/tokens.css`: layout custom media comments and size tokens.
  - `web/src/lib/styles/base.css`: `.scene` fallback rules.
  - `web/src/routes/+layout.svelte`: compact nav on phones; safe-area padding.
  - Page `<style>` blocks of `+page.svelte` (home), `songs`, `sing/[id]`, `result`, `practice`, `account`, `progress`, `leaders`, `friends`, `duels`, `duels/match/[id]`, `legal/*` via `LegalPage.svelte`.
- Create `web/tests/e2e/responsive.spec.ts`.

**Layout rules** (exact queries):

| Name | Query | Behaviour |
|---|---|---|
| compact | `(max-width: 599px)` | |
| short | `(max-height: 520px) and (orientation: landscape)` | Phone landscape. Scene pages switch to flow or two-column layouts. Decorative `.deco` and cat elements are hidden on the sing stage. |
| medium | `(min-width: 600px) and (max-width: 1099px) and (min-height: 521px)` | |
| wide | `(min-width: 1100px) and (min-height: 521px)` | Absolute "scene" layouts allowed |
| xwide | `(min-width: 2200px), (min-aspect-ratio: 21/9)` | Container max 1680px; scale the type with `clamp()` |

Further rules:
- Replace the scene collapse `max-width: 900px` with "not wide".
- Sing stage, portrait: lyrics, then the pitch canvas, then controls pinned at the bottom with `padding-bottom: env(safe-area-inset-bottom)`.
- Sing stage, short landscape: a grid with lyrics on the left (55%) and the pitch canvas plus controls on the right.
- Request `navigator.wakeLock.request("screen")` while singing and release it on stop/leave, guarded by feature detection.

**Device matrix:** spec §5.2, trimmed to these 14 for the test:

| Phones | Tablets | Desktops |
|---|---|---|
| 360×740, 390×844, 430×932, 844×390, 932×430 | 768×1024, 1024×768, 820×1180, 1180×820 | 1280×720, 1366×768, 1920×1080, 2560×1440, 3440×1440 |

- [ ] **Step 1: Write failing `responsive.spec.ts`.** For each size × routes `/`, `/songs`, `/sing/cn-earth` (mic check, then stage via the fake mic), `/result` (after a short fake-mic run), `/account`, `/progress`, `/leaders`, `/friends`, `/duels`, `/legal/privacy`, `/no-such-page`, assert:
  - `scrollWidth <= innerWidth`;
  - no two visible interactive elements' bounding boxes intersect by more than 4 px²;
  - on `/sing` stage, the stop button's bounding box is fully inside the viewport;
  - the nav links don't overflow their container.

  Also add `rotation keeps singing`: start the stage at 390×844, switch to 844×390 mid-song, and assert the AudioContext state is `running`, the stage is visible, and a result arrives. Save screenshots to `test-results/matrix/`.
- [ ] **Step 2:** Run it in Chromium (`--project=chromium`) → FAIL on the current layout.
- [ ] **Step 3:** Implement the rules page by page, starting with sing, result, songs and home.
- [ ] **Step 4:** Run in Chromium and in WebKit (`--project=webkit`; add a webkit project to `playwright.config.ts` with WebKit device emulation for the phone sizes) → PASS. Review the screenshots by eye.
- [ ] **Step 5:** Commit `Адаптивная вёрстка: телефоны, планшеты, широкие экраны`.

## Stream E: feature UI (worktree `wt-ui`)

Put new UI in new files where possible; make minimal markup insertions into pages; leave page `<style>` restructuring to Stream D.

### Task E1: Legal UI and sign-in UI

**Files:**
- Create:
  - `web/src/routes/legal/terms/+page.svelte`
  - `web/src/routes/legal/contacts/+page.svelte` (operator stub and complaint form)
  - `web/src/lib/legal/AgeBadge.svelte`
  - `web/src/lib/auth/ProviderButtons.svelte`
  - `web/src/lib/auth/SignupComplete.svelte`
- Modify:
  - `web/src/routes/+layout.svelte`: footer links and the «6+» badge.
  - `web/src/routes/songs/+page.svelte`: age badge per card, 0+ default from index `age` field.
  - `web/src/routes/account/+page.svelte`: provider buttons; age group radio; parent name field; nickname label «Имя в игре (видно другим игрокам)»; `?signup=` and `?authError=` handling; password-less confirm.
  - `web/src/lib/legal/operator.ts`: name «Команда mugsize»; documents bumped to 17 октября 2026.
  - `web/src/routes/legal/privacy/+page.svelte` and `consent/+page.svelte`: voice processing on the team's PC in Russia, Yandex/VK sign-in, uploads, children.
  - `web/src/lib/api/account.svelte.ts`.
  - `web/vite.config.ts`: CSP unchanged (server redirects only).
  - English UI words found by grep (`VS`, `REC`): add Russian.
- Test: extend `web/tests/e2e/legal.spec.ts`.

**Interfaces:** consumes C3 OAuth, registration, complaints and the profile `hasPassword`.

- [ ] **Step 1: Failing tests:**
  - The footer links «Пользовательское соглашение» and «Контакты», and shows «6+».
  - The complaint form submits and shows «Заявка отправлена».
  - Registering under 14 without a parent name shows an error.
  - With `/api/auth/providers` mocked to `["yandex","vk"]`, the buttons «Войти через Яндекс ID» and «Войти через VK ID» link to `/api/auth/yandex/start?return=…`.
  - `/account?signup=tok` shows consent plus age and posts to `/api/auth/complete` (mocked).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS, and the existing `legal.spec.ts` / `account.spec.ts` still pass.
- [ ] **Step 5:** Commit `Документы, возраст, вход через Яндекс и VK в интерфейсе`.

### Task E2: Playback modes, PCM streaming, provisional → final score

**Files:**
- Create:
  - `web/src/lib/precise/uploader.ts`: `startPerf(songId, mode) -> PerfSession` with `push(pcm: Float32Array, sampleRate)` (resample to 16 kHz with linear interpolation, convert to PCM16, flush every 5 s via `PUT chunk`), `finish(): Promise<void>`, `poll(id, signal): Promise<PerfStatus>` (every 700 ms, stop at done/failed/offline or after 25 s).
  - `web/src/lib/precise/consent.svelte.ts`: guest voice consent in localStorage `perepev.voiceConsent` = consent version.
- Modify:
  - `web/src/lib/audio/capture.ts`: expose raw PCM chunks to a subscriber; with `mode=speaker`, echoCancellation true.
  - `web/src/routes/sing/[id]/+page.svelte`: mode switch «В наушниках / Без наушников» on mic check, remembered in `perepev.playMode`; one-tap voice consent before the mic starts (guest or user, once per version); playback of `instrumental.mp3` + `guide.mp3` at gain 0.18 (headphones) or `instrumental.mp3` only (speaker) when `stems`, else `backing.mp3` (existing behaviour); start the perf session; push PCM; finish.
  - `web/src/lib/audio/playback.ts` (multi-track start).
  - `web/src/routes/result/+page.svelte`: badge «предварительно» while pending → final score and a «Ритм и слова» axis label; «слова не проверены» when offline/failed; cap explanations («Похоже, звук шёл из динамика — надень наушники», «Почти не слышно слов»).
  - `web/src/lib/history.svelte.ts`: save the final score with `wordsChecked`.
  - `web/src/lib/catalog.ts`: `stems` field; `my-` ids → `/api/tracks/<uuid>/files/`.
- Test:
  - `web/tests/precise-uploader.test.ts` (vitest; `vite.config.ts` only includes `web/tests/*.test.ts`): resampler 44100 → 16000 length; PCM16 clamp; 5 s chunking.
  - `web/tests/e2e/precise.spec.ts`:
    - with `/api/perf*` mocked: the result shows «предварительно», then the final value;
    - offline → «слова не проверены»;
    - speaker mode plays only the instrumental;
    - the consent tap is required once.
- Steps follow the same TDD cycle: tests → FAIL → implement → PASS (plus the existing `solo.spec.ts`, `polish.spec.ts`) → commit `Точная оценка в интерфейсе, режимы звука, согласие на запись`.

### Task E3: Own-track upload UI

**Files:**
- Create:
  - `web/src/lib/tracks/UploadTrack.svelte`: file input (accept audio/*, ≤ 30 MB); language select; `decodeAudioData`; a waveform canvas with a draggable 15-60 s window (default: the first 30 s window whose RMS exceeds the 60th percentile); encode the window plus 2 s margins to 44.1 kHz mono WAV in the browser; `POST /api/tracks` then `PUT audio`.
  - `web/src/lib/tracks/tracks.svelte.ts`: poll `GET /api/tracks` every 3 s while any is queued or running.
- Modify `web/src/routes/songs/+page.svelte`: a «Мои треки» section for signed-in users, with statuses «В очереди», «Отделяем голос», «Мелодия», «Слова», «Готово — петь», «Не получилось», «ПК обработки выключен — ждём»; expiry hint «удалится через N ч»; a delete button.
- Test:
  - `web/tests/track-wav.test.ts` (vitest): the WAV header is correct; length = (window + 4 s) × 44100 × 2 + 44.
  - `web/tests/e2e/tracks.spec.ts`: with API mocks, upload a generated 40 s sine WAV → the list shows the stages → «Готово — петь» opens `/sing/my-<uuid>`.
- Commit `Свой трек: загрузка отрывка и статусы`.

## Stream F: integration (main session)

### Task F1: Merge streams, full regression, docs

- [ ] Merge D → E → A → B → C into `hackathon-upgrade`, resolving conflicts in `main.rs`, `config.rs` and the Svelte pages.
- [ ] Run in the main repo:
  - `cargo test --release --workspace`
  - `cargo clippy --release --workspace --all-targets`
  - `cd web && npm run check && npx vitest run`
  - `node --test --test-concurrency=1 tests/integration/`
- [ ] Run end to end with a local stack (Docker project `perepev-dev`, port 8091) and the worker on the Mac:
  - the full e2e suite plus the new specs;
  - the device matrix in Chromium and WebKit;
  - the earlier QA crawl and API checks.
- [ ] **Scoring benchmark** (`gpu-worker/bench/run_bench.py`) on 6 catalog songs, using the separated guide vocals as the singer. Cases:
  - perfect, ±3 semitones → ≥ 85
  - +400 ms delay → rhythm drops
  - a detuned phrase → intervals drop
  - another song's vocal → words cap
  - sine hum → words cap
  - silence → < 20
  - guide played through a "speaker" (the stem mixed into the recording at −6 dB with the user silent) → bleed cap

  Record the results in `WORK_DONE.md`.
- [ ] Update the docs listed in Global Constraints. Commit `Документация и протокол проверок`.

### Task F2: Catalog additions

- [ ] Using the free-recording research, for each accepted song: download from the verified source, record the licence text, URL and SHA-256, and run `python -m perepev_worker.catalog import <audio> --id … --clip a,b --lyrics lyrics.txt --language … --credits credits.json`.
  - This is a `catalog.py` subcommand added in this task. It reuses `track.py`, but with known lyrics for matching and timings.
- [ ] Check every artist and author against the foreign-agent register, and screen the lyrics. Record both in `CREDITS.json` under `review`.
- [ ] Each song must play, sing and score in the e2e smoke (`all catalog songs` from the QA crawl).
- [ ] Commit `Новые свободные песни в каталоге`.

### Task F3: Local install update and deployment

- [ ] Back up the owner's `kvinta` DB with `bash deploy/backup.sh` via `COMPOSE_PROJECT_NAME=kvinta`, then rebuild and start `kvinta` from this repo. Verify the migrations, health and a user count equal to the pre-update count.
- [ ] When the server is reachable:
  1. Install Docker if it's missing.
  2. Copy the repo.
  3. Write `.env`: domain, DB password, worker token hash, and the OAuth keys from `~/perepev-secrets.env`.
  4. Run `docker compose -f compose.yaml -f compose.server.yaml up -d --build --wait`.
  5. Verify HTTPS, health and a solo run from a phone-sized emulator.
- [ ] Give the owner the worker token and the `setup.ps1` command.

---

## Review Focus

1. **Phone speaker plays the guide while the user stays silent** → the final score is capped at 30 with the «наушники» hint. Owned by A1 (`guide_bleed_caps`) and C1 (`test_bleed_detects_copy`); add an e2e case in E2 where the mocked result has `cap:"bleed"` and shows the hint.
2. **GPU PC off or slow during the demo** → the result never hangs past 25 s and shows the provisional score as final with «слова не проверены». Owned by A2 (`perf goes offline…`) and E2 (offline test); add an E2 test where the poll times out with status still `running` and the result is finalised.
3. **Rotating the phone mid-song** → the audio continues and the layout reflows. Owned by D2 (`rotation keeps singing`).
4. **Uploading a non-audio file, a too-short (< 15 s) file, or a 3-hour file** → a clear Russian error before any upload. Add to E3 `tracks.spec.ts`: a text file renamed .mp3 → «Не удалось прочитать аудио»; a 10 s file → «Нужен отрывок от 15 секунд».
5. **OAuth callback replayed, or with a mismatched state, or a user cancelling at the provider** (`error=access_denied`) → no session and a friendly message on `/account`. Add to B1: `callback with error=access_denied → 302 /account?authError=denied`, and replaying a used state → `authError=state`.
