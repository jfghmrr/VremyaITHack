# Что сделано в проекте

Состояние на 17 октября 2026 года. Документ описывает итог проекта, включая работу из предыдущей сессии, а не только создание ZIP.

## 2026-10-17 — backend and infrastructure fixes before the defense

Branch `wt/backfix` (from `hackathon-upgrade` at `9e475c3`; commits `595e504` words check, `5319c90` Caddy, `88205a3` nginx, `ca98f1c` worker tests, then this documentation). Nothing was deployed; the server and the GPU PC are unchanged.

**Changed and why:**
- **Words check per song.** `web/static/songs/index.json`: `"wordsCheck": false` for `yamshchik-ne-goni`, `oi-to-ne-vecher` and `dorogoi-dlinnoyu` (only these three entries changed; no `reference.json` touched, so song versions are unchanged). `crates/api/src/catalog.rs` parses the optional field (default true); `crates/api/src/perf.rs` sends their score jobs with `words: []`, so the existing «empty evidence = words not checked» path gives a melody-only score with `wordsChecked: false` and no words cap. Why: Whisper recognises no words in these recordings even on their own vocal, so a clean take was capped at 40 (production: 86.7 → 40, 72.0 → 40, 83.5 → 40). The worker still runs Whisper on these takes (unused), as the PC's worker code is unchanged.
- **Caddy caching** (`deploy/Caddyfile`, perf audit R5): `no-cache` on pages and `/_app/version.json`, so a redeploy cannot leave browsers on stale HTML pointing at deleted hashed chunks; `/art/*` cached 7 days (only 200/304) and served as an asset, so a missing image is a 404 instead of the SPA page with 200. `/_app/immutable/*` stays immutable and `/songs/*` `no-cache`.
- **nginx access log** (`deploy/nginx/perepev.lumnex.ru.conf`): `access_log off;` in the 443 server too, matching the privacy page and the data export («IP kept at most 1 hour»). Applies after the owner re-runs `sudo bash deploy/nginx/install-site.sh` (OPERATIONS.md).
- **Capacity figures** in this file and PROJECT_OVERVIEW.md: production about 3.7 s per score job and about 5 simultaneous finishes within the 20 s deadline; about 7 is only the local-tunnel bench figure.
- **Worker test isolation** (`gpu-worker/tests/test_offline_models.py`): the hub-variable fixture now restores `HF_HOME`, `TORCH_HOME`, `HF_HUB_OFFLINE` and `HF_ENDPOINT` after each test (before, `HF_HUB_OFFLINE=1` and the cache paths leaked into later tests), and the log test restores the `httpx`/`httpx2` levels. OPERATIONS.md notes that an explicit `HF_HUB_OFFLINE=1` on an empty model cache fails the first install by design.

**Validation (actual runs on the Mac):**

| Check | Result |
| --- | --- |
| `CARGO_BUILD_JOBS=4 cargo test --release --workspace` | 41 passed: api 25 (2 new: `wordsCheck` parsing with default and type error; the published catalog has exactly the three songs off), scoring-core 3 + parity 4 + precise 8 + regressions 1. |
| `cargo clippy --release --workspace --all-targets -- -D warnings` | Clean. |
| Integration `node --test --test-concurrency=1 tests/integration/*.test.mjs` | 43/43 in 8 suites (1 new: a guest perf of `yamshchik-ne-goni` leases a score job with `words: []`; with empty evidence the result is `precise-1`, `wordsChecked: false`, `cap: null`, score ≥ 90; `oi-to-ne-vecher` and `dorogoi-dlinnoyu` also get `words: []`, `gori-gori-moya-zvezda` keeps its words). With the old `index.json` the new test fails. |
| `cd web && npx vitest run` / `npm run check` | 118/118 (catalog consistency included); 0 errors, 0 warnings. |
| GPU worker `pytest -m "not models"` (torch blocked, the five torch-importing files skipped) | 102 passed (1 new: the fixture restores the environment). The old fixture left `HF_HUB_OFFLINE=1`, `HF_HOME`, `TORCH_HOME` and the `httpx` levels set after the file ran; the new one leaves them as before. |
| Caddy 2.11.7 (`caddy validate`, `caddy fmt`, `caddy adapt`, local and server mode) | Valid, formatted, no warnings. Served the built site in a throwaway container: pages 200 `no-cache` (ETag revalidation 304), `/_app/version.json` `no-cache`, immutable chunks 1 year, `/songs/*` `no-cache`, an art image 200 with `max-age=604800`, a missing art image 404 without `Cache-Control` (before: 200 `text/html`). |
| nginx 1.24.0 (self-signed certificate, throwaway container) | `nginx -t` passes; an HTTPS request writes no access-log line (old template: one line); the error log still records failed requests. |

**Remaining limitations of this pass:** the three songs are scored on melody only, which is still not measured with a real singer; the nginx change waits for the owner's `install-site.sh` re-run; the worker still transcribes takes of these songs (about the same GPU time as before).

## 2026-10-16 (night) — model health check before the defense

Branch `wt/models` (from `hackathon-upgrade` at `8944b48`). Live checks of the GPU worker models on production `https://perepev.lumnex.ru`; full report: `.superpowers/sdd/2026-10-16-hackathon-upgrade/models-report.md` in the main checkout.

**Changed (worker only, not deployed to the PC):**
- `gpu-worker/perepev_worker/runtime.py`: `models_dir()` sets `HF_HUB_OFFLINE=1` when the `htdemucs` bag is fully in the hub cache (`htdemucs_cached()`), unless `HF_HUB_OFFLINE` is already set. Why: every start asked huggingface.co for updates; with the hub blocked (dropped packets) the start took 20 s longer before the hub fell back to the cache.
- `gpu-worker/perepev_worker/main.py`: the `httpx2` logger (huggingface_hub 2.x's own httpx copy) is quiet like `httpx`, so hub requests no longer appear at INFO in `worker.log`.
- `gpu-worker/tests/test_offline_models.py`: 8 tests, including a subprocess test with the real huggingface_hub 2.2.0 that resolves both htdemucs files from a cache without opening a connection to `HF_ENDPOINT`, and a guard that the worker modules import neither the hub nor torch at import time.

**Validation.** `pytest -m "not models"` on the Mac with torch blocked (memory guard): 101 passed (the torch-importing files `test_runtime`, `test_pitch`, `test_score`, `test_catalog_import`, `test_models_smoke` were not run). The real symlinked hub cache on the Mac resolved offline in 0.09 s with huggingface.co blackholed. The test that no connection is opened fails when `HF_HUB_OFFLINE=0` is forced.

**Findings recorded under «Remaining limitations» below:** three public-domain Russian songs get the words cap for a clean take; the worker on the PC runs pre-fix-wave code (`4a9f76d`).

## 2026-10-16 — hackathon upgrade

Branch `hackathon-upgrade`, built on the imported archive version (`a52910d`) and the plan commit `fca126f`, for the defense on 2026-10-17. Goal: judges open the site on their own phones, pick a familiar song or upload their own, sing, and get a believable result within seconds. Design: `docs/superpowers/specs/2026-10-16-hackathon-upgrade-design.md` (§6a overrides the rest); plan with contracts C1-C4: `docs/superpowers/plans/2026-10-16-hackathon-upgrade.md`. The work ran as five parallel streams (A scoring and jobs, B sign-in backend, C GPU worker, D layouts, E feature UI) in separate worktrees, each reviewed, then merged and checked together, followed by one fix wave, the catalog additions and the deployment preparation. Business rules and rulings: ASSUMPTIONS.md, «Hackathon upgrade — 16.10.2026».

A kernel panic at 15:45 interrupted the streams: Demucs on Apple MPS reached 23 GB on the 16 GB Mac. The uncommitted work survived and was finished by fresh implementers; since then the worker never uses MPS, and model runs on the Mac go through a memory guard.

### What changed and why

**Scoring, GPU worker and job queue.** Why: a score that reflects the original, including whether the words were sung, without depending on a GPU in the server.
- `scoring-core`: `score_precise` (`precise-1`): «Ритм и слова» = 0.5 × rhythm + 0.5 × words; caps for humming (40) and speaker bleed (30) on top of the existing ones.
- API: a PostgreSQL job queue (`jobs.rs`), the outbound-only worker protocol (`worker.rs`, Bearer token checked against `WORKER_TOKEN_SHA256`), performance upload (`perf.rs`) and own tracks (`tracks.rs`), private files in `DATA_DIR`, `worker` in `/api/health`, and a cleanup task: voice at most 10 minutes, results and performance records 24 hours, tracks 24 hours, contact requests one year. Migrations `0005_jobs.sql` and `0006_attempt_precise.sql` (attempts store the precise tag and the words flag).
- Fix wave: `POST /api/perf` answers 503 without a live worker, so no voice is accepted that cannot be scored; `PERF_LIMIT_PER_HOUR` (default 300, raised from 30 because judges share one venue NAT address) and `PERF_DEADLINE_S` are configurable through Compose.
- `gpu-worker/` (Python 3.12, uv): Demucs `htdemucs` separation, torchcrepe melody, openai-whisper words with fuzzy matching, GCC-PHAT bleed check, profanity masking, `catalog stems` and `catalog import`. Stems (`instrumental.mp3`, `guide.mp3`) were generated for all 24 existing songs. Fix wave: lanes survive any non-auth error, retries for `complete` and file uploads, best-effort progress, cleanup of leftover job folders at start, profanity prefixes.

**Sign-in and legal.** Why: Russian sign-in rules (no Google), 152-FZ mechanics and judge-visible documents that match the real processing.
- Yandex ID and VK ID with PKCE (`oauth.rs`), buttons only when configured; neutral nicknames `Певец-NNNN`; age group and parent's name under 14; contact form (`complaints.rs`); migration `0004_identities_legal.sql`; consent version `2026-10-17`; HSTS in Caddy.
- UI: terms of use and contacts pages, provider buttons, sign-up completion, the 6+ footer label and age labels on song cards, Russian labels for former English UI words (for example «ЗАПИСЬ» instead of «REC»).
- Fix wave: provider accounts cannot set a password they could never use; the export and the privacy, cookie and terms pages now describe voice upload, retention and IP use as implemented; sign-in returns to the page where it started.

**Layouts and error page.** Why: judges use their own phones, in portrait and landscape, including while singing.
- A Russian error page (`+error.svelte`): «Такой страницы нет» for 404, «Что-то пошло не так» with a retry otherwise.
- Shared breakpoints (compact, short landscape, medium, wide, xwide), safe areas, 44 px touch targets on coarse pointers, phone layouts of the sing stage, Screen Wake Lock while singing; rotation keeps the audio running.
- Fix wave: WebKit drew the home lockers blank (fixed), the duels search lamp no longer pushes `/duels` past 768 px, the mic check fits a 360×740 phone with the new sound-mode switch, and the cookie banner no longer covers buttons on phones.

**Feature UI.** Why: make precise scoring and own tracks usable.
- Sound modes «В наушниках / Без наушников», a one-tap voice consent, 16 kHz PCM upload in 5 s chunks while singing, «предварительно» → final score with cap hints, fallback to the browser score with «слова не проверены».
- «Мои треки»: waveform with a draggable 15-60 s section, upload of only that section, processing stages, 24 h expiry, delete; header-based duration checks so long files are rejected before decoding.
- Fix wave: retries for chunk uploads and polling on venue Wi-Fi, fallback to `backing.mp3` when a stem fails to load, mode-aware headphones advice.

**Catalog 24 → 32 songs (14 RU / 18 EN).** Why: well-known, easy songs with vocals, legally free. 8 public-domain songs in free recordings: «Ой, то не вечер», «Дорогой длинною», «Ямщик, не гони лошадей», «Гори, гори, моя звезда», Amazing Grace, Twinkle, Twinkle, Little Star, My Bonnie Lies Over the Ocean (`bonnie-krystyna`), Danny Boy. Each passed the licence, public-domain, lyric and register gates (ASSUMPTIONS.md); credits, hashes and the legal page `/legal/music` are complete. Planned were 26; uncertain candidates were skipped by rule.

**Windows installer and the real install on the team's PC.** Why: the scoring PC must be set up by one admin script and run unattended.
- `deploy/gpu-worker/setup.ps1` (10 steps: Windows and driver checks, uv, locked-down `C:\Perepev`, CUDA PyTorch, model warm-up, DPAPI token, self-test, SYSTEM scheduled task), `run-worker.ps1`, `README.md` for the team, and `setup.Tests.ps1` (DryRun on the Mac).
- Installed on the owner's PC over SSH (Windows 10 19045, RTX 3070 Ti 8 GB, driver 610.74): the first run succeeded in 946 s with no installer fixes.

**nginx-fronted deployment.** Why: the target server's host nginx already serves other sites on ports 80 and 443.
- `deploy/Caddyfile` trusts `X-Forwarded-For` only from private addresses and forwards exactly the client address (before this, behind nginx every client shared one rate-limit bucket, the Docker gateway); `compose.server.yaml` trusts nobody.
- `deploy/nginx/perepev.lumnex.ru.conf` (site template) and `deploy/nginx/install-site.sh` (root installer: certificate through DNS-01 with the server's existing Cloudflare key or webroot, `nginx -t` before reload, rollback on error), `deploy/server-nginx.env.example`, OPERATIONS.md «Сервер за существующим nginx».
- Deployment to perepev.lumnex.ru in progress at the time of writing; see OPERATIONS.md.

**Documentation and legal wording (this pass).** Context documents updated to the current state; the repressed-authors rule is now cited as п. 4 ст. 1281 ГК РФ (70 years from 1 January of the year after rehabilitation) in LICENSES.md, docs/vocal-catalog.md and the two affected `CREDITS.json` (only their `composition` field changed), and the 4-year extension is worded as in the statute (worked during or took part in the Great Patriotic War); the cookie page says the sound mode leaves the device with the recording; the privacy page distinguishes a PC that is offline when singing starts from one that drops mid-song; Jamendo licence sentences name the Internet Archive mirror as the checked source; the `compose.yaml` comment says an empty `WORKER_TOKEN_SHA256` makes `POST /api/perf` answer 503; the «Дорогой длинною» line comparison in docs/vocal-catalog.md names each line by position; stale statements about playback while singing, cookies, IP retention, song counts and deployment status were corrected in README.md, PROJECT_OVERVIEW.md, ARCHITECTURE.md, OPERATIONS.md, START_HERE.md, ASSUMPTIONS.md and docs/vocal-catalog.md.

### Affected components

`crates/scoring-core/src/precise.rs`; `crates/api/src/{jobs,worker,perf,tracks,oauth,complaints,accounts,history,config,state,main}.rs`; `crates/api/migrations/0004-0006`; `contracts/`, `web/src/lib/api/types.ts`; `web/src/lib/{precise,tracks,auth,legal,ui,audio,styles}`, `web/src/routes/{+error,+layout,songs,sing,result,account,duels,legal/*}`; `gpu-worker/` (package, tests, `bench/`); `deploy/{Caddyfile,gpu-worker,nginx,server-nginx.env.example}`; `compose.yaml`, `compose.server.yaml`, `Dockerfile`, env examples; `web/static/songs/` (8 new folders, stems for all, `index.json`), `web/src/lib/legal/vocal-music.json`; tests in `tests/integration/`, `web/tests/`, `web/tests/e2e/`.

### Validation (actual runs)

| Check | Result |
| --- | --- |
| `cargo test --release --workspace` | 39 passed: api 23, scoring-core 3 + parity 4 + precise 8 + regressions 1 (after the fix wave, `26e7696`). |
| `cargo clippy --release --workspace --all-targets -- -D warnings` | Clean. |
| Integration `node --test --test-concurrency=1 tests/integration/*.test.mjs` | 42/42 in 8 suites (baseline at `fca126f`: 14/14). |
| `cd web && npm run check` / `npx vitest run` / `npm run build` | 0 errors, 0 warnings; vitest 101/101 after the fix wave and 118/118 after the catalog merge (`6128aa2`); build OK. Contract drift check: no diff. |
| GPU worker `uv run pytest -m "not models"` | 97 passed after the fix wave; 107 passed after the catalog merge. With models on the Mac CPU: 71 passed (memory peak 4021 MB). |
| Installer `pwsh deploy/gpu-worker/setup.Tests.ps1` | 85 passed, 0 failed (DryRun only). |
| Playwright, one spec file at a time | Chromium 76/76, WebKit 26/26 after the fix wave (before it: Chromium 69 passed / 2 failed, WebKit 21 / 1). Catalog worktree: `catalog-free`, `legal` and `vocal-home` 25 passed; every new song went through mic check → sing → result with a score above 60. |
| Docker | `docker compose build` of the integrated tree succeeded (`70a64ab`); smoke: health ok with db and valkey, `worker` false without a token, migrations 1-6 applied on PostgreSQL 18, `/data` writable by the API user, home page 200, stems served, an unknown route renders the client 404 (HTTP 200 through the SPA fallback). |
| Real GPU PC | SYSTEM task, folder ACL, DPAPI token (no plain token on disk or in logs), device `cuda`, `/api/health` `"worker": true`. Score latency 1.3-3.6 s from finish to final (the first job after a start 4.9 s). An own 29.4 s section: ready in 6.1 s. After 123 jobs no job folders were left on the PC or the server. |
| Benchmark `gpu-worker/bench/run_bench.py` (6 songs × 9 cases, headphones mode, RESULTS.md) | 48 of 54 expectations; the 6 misses are all the "perfect" case, a sample copy of the guide stem that gets the bleed cap by design, so 48/48 stand-in cases pass. Median latency 2.6 s, max 3.6 s. ±3 semitones 87.1-98.9 without a cap; a detuned phrase costs 5.5-13.3 points; another song's vocal hits the words cap (9.9-31.0); a sine hum 40.0; silence 0.0; the stems at −6 dB with a silent user 30.0 (bleed cap); +400 ms delay collapses the score (uncapped 19.8-65.4) because the lag search covers only ±0.3 s. Six simultaneous finishes were all final by 19.1 s; a seventh would miss the deadline. VRAM 6.1-6.8 of 8 GB. |
| Deployment preparation, local proof behind `nginx:1.24.0` | Health through nginx; per-client limits (13th registration 429, spoofed `X-Forwarded-For` / `X-Real-IP` ignored, a second client counted separately; with the old Caddyfile both shared the gateway counter); WebSocket upgrade 101 and a 90 s session kept by pings; worker long poll 204 after 24.7 s; 15 MB upload reached the API, 30 MB got nginx 413; the TLS template over HTTP/2 with the port-80 redirect. Installer in Ubuntu 24.04 with nginx 1.24.0 and certbot 2.9.0 (certbot stubbed): refusals, issuance path, idempotent rerun, rollback, Cloudflare key selection; other sites' files unchanged. |
| This documentation pass | `npx vitest run` 118/118 (one earlier run, while the Mac's load average was about 70, hit the 5 s per-test timeout in `catalog.test.ts`; the rerun passed); `npx vitest run tests/vocal-catalog.test.ts` 37/37; `npm run check` 0 errors, 0 warnings (1127 files); no citation of the wrong paragraph of Art. 1281 left (`git grep` empty); the song counts in the docs match `web/static/songs/index.json` (32 = 14 RU + 18 EN). |

Benchmark caveats: every take is an idealised stand-in (phase-vocoded copies of the separated vocal, a clean delayed bleed copy, a pure sine hum), so 87-99 is a ceiling, not a real singer's score; latencies are best case (one job at a time over a local tunnel); the "Rhythm" column is the blended «Ритм и слова»; the test API spread `X-Forwarded-For` addresses to stay under the then 30-per-hour limit. The cn-wonder +400 ms row with no words recognised is undiagnosed.

### Remaining limitations

- **Real phones.** Layouts and singing were checked only in Chromium and WebKit emulation; no physical iPhone or Android phone, Bluetooth headset or real Safari was tested.
- **Calibration.** The words cap (40) and the bleed cap (30) were tuned on synthetic and studio stand-ins only; a real person singing along in headphones mode has not been measured for a false bleed cap.
- **Latency.** The ±0.3 s lag window stays: takes later than that (typical for Bluetooth output) score very badly, so wired headphones are advised at the defense.
- **Licences.** The four Jamendo recordings were confirmed through Jamendo's License.txt in Internet Archive copies uploaded by a third party in 2026; the primary check on jamendo.com is pending. The death dates of von Ritter and Chuevsky are unknown.
- **Sign-in.** Yandex ID and VK ID were tested end to end only against a mock provider; with the real credentials only the start redirect was checked on a local stack.
- **Deployment.** Deployment to perepev.lumnex.ru in progress at the time of writing; see OPERATIONS.md.
- **Capacity.** One GPU PC, one score job at a time. On production (checked 2026-10-16 night) queued score jobs take about 3.7 s each: three simultaneous finishes were final at 4.3, 7.8 and 11.6 s, so about 5 simultaneous finishes fit the 20 s deadline and later singers keep the browser score. The local-tunnel bench measured about 3 s per job and about 7 simultaneous finishes; that figure does not hold over the internet. VRAM is tight. A single score job takes 2.1-7.5 s on the worker and 2.6-7.8 s from finish to the final score, about 1 s more than over the local tunnel (downloads of the take and stems over the internet). A worker start without huggingface.co falls back to the model cache (verified on the PC); code from `wt/models` does not contact the hub at all once the models are cached. The PC still runs the worker code of `4a9f76d`, without the fix wave (lane survival, retries of `complete`, best-effort progress). The Mac is too slow (about 25 s per score) to replace the PC at the default 20 s deadline.
- **Catalog quality.** Word timings of the new Russian songs are approximate (Whisper finds few sung Russian words without the lyrics); in «Гори, гори, моя звезда» two words light up about 2 s early. Three extra imported songs were left out unreviewed.
- **Words not checked on three public-domain Russian songs.** For «Ямщик, не гони лошадей», «Ой, то не вечер» and «Дорогой длинною» a clean take (the guide shifted +3 semitones) scored 86.7 / 72.0 / 83.5 before caps but got the words cap of 40 (wordsSung 0.00 / 0.00 / 0.04) on production. Whisper large-v3-turbo without a lyric prompt returns only non-speech hallucinations for these recordings («ПЕСНЯ», «Продолжение следует...»), the unshifted guide included. The other 29 songs pass (wordsSung 0.59-1.00, no cap). Since 2026-10-17 these three carry `"wordsCheck": false`: they get the melody-only server score with «слова не проверены» and no words cap. Not measured with a real voice; checking their words would need a better recogniser or a lyric-aware alignment.
- **Privacy detail.** In the nginx mode the template turns the host nginx's access log off for HTTPS as well since 2026-10-17, but the installed site file changes only when the owner re-runs `sudo bash deploy/nginx/install-site.sh`. nginx's error log still records the client address of failed requests, with the server's own retention.
- **Smaller gaps.** `cap` is reported even when it did not lower the score; guests are rate-limited per IP only, not per browser; «Поделиться» on an own track builds a link a friend cannot open; Caddy trusts every private and loopback peer in the local and nginx modes; xwide screens show a centred ~1920 px composition; the duel final screen's CSS still carries a pre-existing misplaced media-query block.
- **Not delivered from the design.** 50 catalog songs (32 now); RMVPE, Mel-Band RoFormer, Qwen3-ASR and SwiftF0; iOS `navigator.audioSession`; a CI version of the benchmark with recorded fixtures (only the live run exists); Python and ffmpeg through winget in the installer (uv-managed Python and libsndfile instead).

## Игровые функции

- Одиночный путь: каталог → проверка микрофона → пение → балл и разбор → прослушивание → тренировка → вызов-призрак.
- Живые дружеские комнаты, рейтинговая очередь, подтверждение готовности и единый отсчёт старта.
- Общий алгоритм оценки Rust/WASM, поддержка транспонирования и компенсации задержки; серверный пересчёт итогов матчей.
- Кабинет с профилем, сменой пароля, приватной историей, выгрузкой и удалением данных.
- Друзья по коду с подтверждаемыми заявками; рейтинг, калибровка, прогресс и достижения.

## Интерфейс

- Оформление музыкальной комнаты: графика владельца, шкафчики, кассеты, бумажные карточки, персонаж и декоративные элементы.
- Адаптация для широкого экрана и узкого окна, клавиатурное управление, учёт reduced-motion.
- История вынесена в «Мой прогресс»; настройки кабинета открываются отдельно.
- Магнитофон выбирает последнюю доступную вокальную песню из истории одиночных попыток и завершённых дуэлей. Обрабатывает сбой загрузки и прекращает звук при уходе со страницы.
- Второй полароид лидеров стал декорацией без перехода в дуэли.
- Зажим прогресса закреплён на тетради, фон заменён на изображение 2560×1440 без CSS-размытия.
- Кот убран с вводного экрана дуэлей.

## Музыка

- Добавлены 24 настоящих вокальных фрагмента: 10 RU / 14 EN, около 8 минут 51 секунды суммарно (before the hackathon upgrade; now 32, see the 2026-10-16 entry).
- В активном каталоге исключены инструментальные записи; старые файлы сохранены для совместимости с прежними ссылками и материалами.
- Подготовлены MP3, кривые высоты, фразы, строки и приближённая разметка слов.
- Для каждого фрагмента записаны источник, авторство, лицензия, параметры обрезки и контрольные суммы.
- Добавлены поиск по названию/исполнителю, языковые фильтры и страница атрибуции музыки.
- Инструменты подготовки и курируемый список источников сохранены в `tools/songs`.

## Инфраструктура и перенос

- Dockerfile собирает API, WASM и статический клиент; Compose поднимает Caddy, API, PostgreSQL и Valkey.
- Подготовлены миграции базы, пример HTTPS-размещения, резервное копирование и восстановление.
- 2026-10-16: the mode behind an existing host nginx for `perepev.lumnex.ru` was prepared; details and the local proof are in the entry «2026-10-16 — hackathon upgrade» above.
- Сохранены JSON-схемы протокола, тестовые данные и тесты.
- Подготовлен переносимый ZIP с исходниками, всеми материалами для запуска, презентацией и документацией.
- Личные аккаунты, пользовательские базы, зависимости разработчика, секретные настройки и рабочие кеши в комплект не включены.

## Фактически выполненные проверки приложения

Results of the vocal-catalog stage before the hackathon upgrade (24 songs). Current results are in the entry «2026-10-16 — hackathon upgrade» above.

| Проверка | Результат этапа вокального каталога |
| --- | --- |
| `npm run check` | 0 ошибок и предупреждений. |
| `npx vitest run` | 66 клиентских тестов пройдены. |
| Rust scoring-core | 8 тестов пройдены. |
| WASM и статический клиент | Сборки успешны. |
| Playwright | 35 различных сценариев пройдены: 2 сценария аккаунта и 33 остальных. |
| После обновления localhost | Повторно прошли 4 целевых сценария. |
| Музыкальные файлы | Все 24 декодируются, согласованы длительности и хеши; API сообщает те же версии эталонов. |
| Данные основной установки | При обновлении аккаунты и история сохранились. Они не переносятся в ZIP. |

Протокол, снимки и ограничения этого этапа: [docs/vocal-verification.md](docs/vocal-verification.md). Результаты отдельной проверки переносимого комплекта: [docs/portable-verification.md](docs/portable-verification.md).

## Что требует дальнейшей работы

- Слуховая редактура времён слов и кривых вокальных эталонов; испытания на реальных певцах и разных микрофонах.
- Проверка на физических телефонах, Bluetooth-гарнитурах, Safari и Firefox.
- Общий HTTPS-сервер для игры между разными компьютерами: deployment to perepev.lumnex.ru in progress at the time of writing; see OPERATIONS.md.
- The open items of the hackathon upgrade are listed at the end of its entry above.
- Настройка и проверка документов владельцем перед публичным использованием.
- При развитии продукта: доставляемые приглашения друзьям, общая пословная подсветка в тренировке/дуэлях и синхронизация локальных достижений между устройствами.

Эти пункты отделены от уже выполненных функций. Браузерные тесты с синтетическим микрофоном не заменяют проверку качества реального пения.
