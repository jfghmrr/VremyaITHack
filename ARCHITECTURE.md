# Архитектура Перепева

## Общая схема

Приложение состоит из статического браузерного клиента, Rust API и двух хранилищ. API организован как модульный монолит. Единое ядро оценки компилируется в WebAssembly для браузера и в машинный код для сервера.

```text
Браузер: SvelteKit / Svelte
  ├── микрофон → AudioWorklet → Web Worker / pitchy → кривая высоты
  ├── Web Worker → scoring-core в WASM → локальная оценка и разбор
  └── HTTP + WebSocket /api
                 │
               Caddy :80          наружу: localhost:8080
                 ├── статический сайт, музыка, шрифты, графика
                 └── Rust API :3001 (Axum / Tokio)
                       ├── scoring-core native → итог матча, точная оценка (score_precise)
                       ├── PostgreSQL → аккаунты, история, матчи, рейтинг, друзья,
                       │                 identities, complaints, jobs, perfs, tracks
                       ├── Valkey → очередь, присутствие, события и аренды матчей,
                       │            счётчики лимитов, OAuth state, сигнал GPU-воркера
                       └── DATA_DIR (volume data) → куски записи голоса, свои треки

GPU worker (team's Windows PC, Python) ── outbound HTTPS only ──► /api/worker/*
  lease → input / stems → Demucs, torchcrepe, Whisper → complete
```

The browser uploads voice (`/api/perf`) only after the voice consent; the worker never accepts inbound connections.

В локальном Compose наружу открыт только `127.0.0.1:8080`. Базы доступны сервисам внутри Docker-сети. Caddy проксирует HTTP и WebSocket на API, включая несколько экземпляров сервиса.

**Server modes.**
- *Behind the host nginx* (prepared for `perepev.lumnex.ru`): `Browser → host nginx :443` (TLS, certbot certificate `perepev`) `→ 127.0.0.1:8097 → Caddy :80 → API`. The site file is `deploy/nginx/perepev.lumnex.ru.conf`; `deploy/nginx/install-site.sh` installs it as root.
- *Caddy on 80/443*: `compose.server.yaml`, and Caddy obtains the certificate itself.

Steps for both are in OPERATIONS.md. Deployment to perepev.lumnex.ru in progress at the time of writing; see OPERATIONS.md. In both modes HSTS and the other security headers come from Caddy; nginx adds none. The nginx site template writes no access log for either server (port 80 and 443), so the host does not keep client addresses of normal requests; nginx's error log still records the client address of failed requests (for example when the containers are down).

**HTTP caching (Caddy, `deploy/Caddyfile`).**
- Pages (the final `handle`: prerendered HTML and the `/200.html` SPA fallback): `Cache-Control: no-cache`, so after a redeploy a browser revalidates (ETag → 304) instead of reusing a stale page that points at deleted hashed chunks.
- `/_app/immutable/*`: one year, `immutable` (content-hashed names). `/_app/version.json`: `no-cache`.
- `/songs/*`: `no-cache` (file names carry no hash). `/fonts/*`: 7 days. `/art/*`: 7 days, only on 200/304 responses, so a missing image is not cached (art URLs are versioned with `?v=`).
- `@assets` (`/songs/*`, `/_app/*`, `/art/*`, `/fonts/*` and the root icons, manifest and notices) is served by `file_server` alone: a missing file is a 404, not the SPA page with 200.

**Client address chain.**
- The API keys its per-address limits (registration, login failures, friend requests, OAuth starts, complaints, precise scoring) on the last `X-Forwarded-For` element (`TRUST_PROXY=true`, `state.rs::client_ip`).
- Caddy is the only hop the API trusts. Its global `servers` options trust `X-Forwarded-For` from `CADDY_TRUSTED_PROXIES`: `private_ranges` by default, which covers the Docker gateway that published ports arrive from. It parses the header right to left (`trusted_proxies_strict`) and sends exactly `{client_ip}` upstream.
- The host nginx overwrites `X-Forwarded-For` with `$remote_addr`, so the address a client sends is never used.
- `compose.server.yaml` sets `CADDY_TRUSTED_PROXIES` empty: clients reach Caddy directly, and the connection address is used.

Without the `header_up` override, Caddy would append the nginx hop and every client would share one limit.

- Counters are Valkey keys `kv:rl:<bucket>:<address>` that expire with their window, so a client IP is kept at most one hour: 15 min for registrations (including `POST /api/auth/complete`), failed logins and password checks, friend requests and OAuth starts; 1 h for complaints and precise-scoring performances. Own-track uploads are counted per user, not per address.
- Known limit: in local and nginx modes Caddy trusts every private and loopback peer. A process on the same host can choose its own bucket, and a client whose address nginx sees as private (the server's own LAN) is counted as the Docker gateway.

## Технологии и каталоги

| Компонент | Реализация | Путь |
| --- | --- | --- |
| Интерфейс | SvelteKit 3, Svelte 5, TypeScript, Vite; статическая сборка | `web/src/routes`, `web/src/lib` |
| Layouts | CSS media queries compact / short / medium / wide / xwide, safe areas, 44 px touch targets ([docs/brand.md](docs/brand.md)); Screen Wake Lock while singing | `web/src/lib/styles/tokens.css`, `base.css`, `web/src/lib/ui/wakelock.ts` |
| Аудио | Web Audio, AudioWorklet, Worker, pitchy, Tone.js | `web/src/lib/audio` |
| Ядро оценки | Rust, детерминированные функции | `crates/scoring-core` |
| Привязки WASM | wasm-bindgen | `crates/scoring-wasm` |
| HTTP и WebSocket API | Rust, Axum, Tokio | `crates/api/src` |
| Основная база | PostgreSQL 18, SQLx, SQL-миграции | `crates/api/migrations` |
| Временное состояние | Valkey 9; клиент redis-rs | `queue.rs`, `realtime.rs`, `lease.rs` |
| Веб-сервер | Caddy 2 | `deploy/Caddyfile` |
| Host nginx (server mode) | nginx site template and root installer with certbot | `deploy/nginx` |
| GPU worker | Python 3.12 (uv), PyTorch, Demucs `htdemucs`, torchcrepe, openai-whisper, rapidfuzz; Windows installer in PowerShell 5.1 | `gpu-worker`, `deploy/gpu-worker` |
| Контракты | JSON Schema и сгенерированные TypeScript-типы | `contracts`, `web/src/lib/api/types.ts` |
| Музыкальные материалы | MP3, JSON-эталоны, слова, атрибуция | `web/static/songs` |
| Проверки | Rust tests, Vitest, Playwright, интеграционные сценарии | `crates/*/tests`, `web/tests`, `tests/integration` |

Точные зависимости фиксируют `Cargo.lock`, `rust-toolchain.toml` и `web/package-lock.json`; версии контейнеров указаны в `Dockerfile` и Compose. Переустановка с произвольными новыми версиями для запуска не требуется.

## Обработка голоса и оценка

1. Браузер получает доступ к выбранному микрофону. AudioWorklet передаёт звуковые блоки рабочему потоку.
2. Worker выделяет высоту и формирует последовательность нот/пауз. Тяжёлая обработка отделена от основного потока интерфейса.
3. Для одиночной попытки WASM сравнивает кривую с эталоном. Итог включает балл, показатели по осям, оценки фраз и проблемные моменты.
4. Для живого матча клиент отправляет каноническую кривую с шагом 50 мс и точностью 0,1 полутона. Сервер принимает точки и сам считает итог общим Rust-ядром.

Без согласия на запись голоса исходный звук микрофона на сервер не отправляется. В текущей вкладке он может использоваться для прослушивания и экспериментальной коррекции. Сохранённая история не является архивом аудиозаписей.

**Precise scoring, client side (`web/src/lib/precise`).**
- *Consent.* Before the first microphone start, a one-tap voice consent is shown to guests and signed-in users alike. It is stored in `localStorage` `perepev.voiceConsent` as the consent version (`documents.consent`, now `2026-10-17`) and asked again when the version changes. Declining keeps the in-browser score only.
- *Sound modes.* The mic check offers «В наушниках / Без наушников», remembered in `perepev.playMode`. For songs with `stems: true` (all 32 catalog songs and every own track), headphones mode plays `instrumental.mp3` plus `guide.mp3` at gain 0.18 and opens the mic with `echoCancellation: false`; speaker mode plays `instrumental.mp3` only and opens the mic with `echoCancellation: true`. Songs without stems, or songs whose stem fails to load (`playback.ts` `loadLayers`), play `backing.mp3`, and the hints then describe what actually plays. The checklist tip and the bleed hint depend on the mode.
- *Upload while singing.* The perf session starts at the countdown, only with consent. `Capture.onPcm` delivers raw audio from song time 0. `uploader.ts` resamples it to 16 kHz with linear interpolation and sends PCM16 in 5 s chunks: `POST /api/perf` (with `songId`, `mode` and the consent version), then `PUT /api/perf/{id}/chunk?seq=n`, then `POST /api/perf/{id}/finish`. A chunk that fails with a network error or 5xx is retried once after 500 ms; a second failure, or a refused `POST /api/perf` (for example 503 without a worker), ends precise scoring for that attempt and keeps the browser score.
- *Result.* The result page shows the browser score marked «предварительно». It polls `GET /api/perf/{id}` every 700 ms and switches to the server's score and axes («Ритм и слова» when words were checked) with cap hints. Network errors, 5xx and malformed answers are retried until the 25 s deadline; a 4xx ends polling at once. If the server says offline or failed, or there is no final answer within 25 s, the provisional score becomes final with «слова не проверены». Only the server's score and axes replace the browser's; the pitch line, moments and lag stay from the browser analysis of the same recording.
- *History and records.* History stores the final score; for a server score it also sends `algorithm: "precise-1"` and `wordsChecked` (browser scores send `algorithm: null`, `wordsChecked: false`), and the per-song record uses the same final score.
- *Own tracks.* Song ids `my-<uuid>` load their files from `/api/tracks/<uuid>/files/`. They always have stems and word timings.

**Own-track upload, client side (`web/src/lib/tracks`).**
- *Where.* Signed-in users get a «Мои треки» section below the songs scene.
- *File checks.* Files go through these checks before anything is uploaded: ≤ 30 MB. The duration must be 15 s to 10 min; otherwise the error is «Нужен отрывок от 15 секунд» or «Файл длиннее 10 минут». It is checked three times:
  1. From the file header (`header.ts`: WAV, MP3 including Xing/VBRI, FLAC, M4A `mvhd`), so a long file is rejected without decoding it.
  2. Through a metadata-only `<audio>` probe (3 s timeout), for formats without a parsed header.
  3. Again after decoding with `OfflineAudioContext` at 44.1 kHz, so the cap holds even when neither the header nor the browser reports a duration.

  A file that can't be decoded gets «Не удалось прочитать аудио».
- *Choosing the section.* A waveform canvas has a draggable 15-60 s window, with range inputs as the keyboard alternative. The default is the first 30 s window at or above the 60th percentile of 1 s block loudness.
- *Upload.* `wav.ts` encodes only that window plus 2 s margins, padded with silence outside the file, as 44.1 kHz mono PCM16 WAV. `POST /api/tracks` is followed by `PUT /api/tracks/{id}/audio`. If the PUT fails, the created id is kept, so a retry resends only the audio and does not spend another of the daily uploads. A track left without audio, because the user picks another file or leaves the page, is deleted best-effort. A track whose audio is still uploading is never deleted: the upload continues after leaving the page, and the track is deleted only if that upload fails. A header duration of 0 or all ones (fragmented MP4, an empty Xing/VBRI count) counts as unknown.
- *Status.* `tracks.svelte.ts` polls `GET /api/tracks` every 3 s while a track is queued, running or offline. It shows «В очереди», «Отделяем голос», «Мелодия», «Слова», «Готово — петь» (links to `/sing/my-<uuid>`), «Не получилось» or «ПК обработки выключен — ждём», with «удалится через N ч» and a confirmed delete.

Весовые коэффициенты: интервалы — 45%, ритм — 25%, устойчивость — 15%, покрытие — 15%. Алгоритм компенсирует общую задержку в пределах ±300 мс и учитывает сдвиг тональности. При слишком низком покрытии или постоянной ноте применяется ограничение балла. Параметры и формулы находятся в `crates/scoring-core/src/config.rs` и `score.rs`.

**Precise scoring, server side (`crates/scoring-core/src/precise.rs`, tag `precise-1`).** The worker returns pitch frames of the recording (torchcrepe), word evidence (Whisper without a lyrics prompt, fuzzy-matched to the known lyric words) and guide/instrumental bleed (GCC-PHAT, 0..1). The API maps them and runs `score_precise` on its compute pool:
- It starts from the same `score_performance` as the browser: same weights, ±0.3 s lag search, key shift.
- *Words sent.* The score job carries the song's lyric words from `lyrics.words.json`, except for catalog songs with `"wordsCheck": false` in `index.json` (`catalog.rs` `CatalogSong::words_check`, default true; `perf.rs` `words_checked`): those jobs carry `words: []`, and the result is the melody-only score with `wordsChecked: false` and no words cap. Own tracks always carry their words.
- *Words.* Each lyric word scores `sung × timing`. `sung` is 0..1 from the match. `timing` is 1 when the word onset, after removing the found lag, is within 0.20 s of the reference, and falls linearly to 0 at 0.60 s. A word without evidence counts as 0. `wordsScore` is the mean; `wordsSung` is the share of words with `sung ≥ 0.5`.
- *Axis.* When words are checked, «Ритм и слова» = 0.5 × rhythm + 0.5 × `wordsScore`. The weights stay 0.45 / 0.25 / 0.15 / 0.15.
- *Caps.* Low coverage or a constant tone → 30 (as before); guide bleed ≥ 0.45 → 30 (`cap: "bleed"`); words checked and `wordsSung` < 0.30 → 40 (`cap: "words"`). The strictest cap that fired is reported, on a tie the later one (bleed over coverage). `cap` is reported even when the raw score was already below the limit.
- The score is rounded to 0.1. Without words and bleed evidence it equals `score_performance`. Duels keep `ALGORITHM_VERSION = 1` and their own server-side curve scoring.

Серверный пересчёт защищает итог матча от передачи произвольного готового балла клиентом. Сам по себе он не доказывает, что присланная кривая получена от живого человека. Одиночные результаты остаются личной статистикой, а не доверенным соревновательным результатом.

## Каталог

`web/static/songs/index.json` — активный индекс, используемый клиентом и API. В каждом каталоге песни:

| Файл | Назначение |
| --- | --- |
| `backing.mp3` | Запись с вокалом автора: прослушивание, магнитофон на главной и запасной вариант, когда стемов нет или они не загрузились. While singing, songs with stems play `instrumental.mp3` (+ `guide.mp3` in headphones mode). |
| `reference.json` | Длительность, кривая F0/MIDI, фразы, строки текста и параметры эталона. |
| `lyrics.words.json` | Дополнительные времена отдельных слов. |
| `CREDITS.json` | Авторство, источник, лицензия, изменения и хеши файлов. |
| `instrumental.mp3`, `guide.mp3` | Минус и отделённый вокал-подсказка из `backing.mp3` (Demucs `htdemucs`), той же длины и выровнены по времени. Когда оба есть, у песни в `index.json` стоит `"stems": true`. |

Optional `index.json` fields read by the API besides the card fields: `language` (Whisper language for precise scoring, default `en`) and `wordsCheck` (boolean, default `true`; `false` sends the precise-scoring job without lyric words, see «Precise scoring, server side»). `wordsCheck` is `false` for «Ямщик, не гони лошадей», «Ой, то не вечер» and «Дорогой длинною», where Whisper finds no words even in the song's own vocal (docs/vocal-catalog.md). The client ignores the field.

Версия эталона в протоколе — первые 12 символов SHA-256 `reference.json`. Это позволяет обнаружить несовпадение материалов перед началом матча. Новые фрагменты уже подготовлены: Python, модели разделения дорожек и кеши исходных записей для запуска не нужны. Инструменты повторной подготовки находятся в `tools/songs`; необходимые им исходные кеши в ZIP не входят. The 8 public-domain songs were built by `python -m perepev_worker.catalog import` (known lyrics, Whisper only for word times, torchcrepe reference on the separated voice); song ids may not start with `my-`, which is reserved for own tracks.

## GPU-воркер

`gpu-worker/` — Python-пакет `perepev_worker` (Python 3.12, uv). Работает на ПК с NVIDIA (CUDA) или на Mac (только CPU) и сам обращается к API по протоколу `/api/worker/*` с токеном в заголовке `Authorization: Bearer`; входящих портов не открывает.

| Модуль | Назначение |
| --- | --- |
| `separate.py` | Вокал и минус: Demucs 4 `htdemucs`, обработка отрезками (`split=True`). |
| `pitch.py` | Мелодия: torchcrepe `full`, шаг 10 мс, 65–1100 Гц, periodicity ≥ 0,5, медиана по 5 кадрам. |
| `words.py` | Слова: openai-whisper (`large-v3-turbo` на CUDA, `small` на CPU) без подсказки текста; нечёткое монотонное сопоставление с известными словами (rapidfuzz ≥ 70). |
| `bleed.py` | Просачивание из динамика: GCC-PHAT между записью и проигранной дорожкой в полосе 200–4000 Гц, задержки ±0,5 с, результат 0..1. Огибающие громкости не подходят: у поющего вместе с подсказкой они совпадают с ней. |
| `score.py`, `track.py` | Задание `score` (кадры высоты, слова, просачивание) и задание `track` (стемы, `reference.json`, `lyrics.words.json`, маскирование мата). |
| `catalog.py` | `stems`: стемы для песен из `index.json`; `import`: a public-domain song from a free recording and known lyrics (`--age` required). |
| `profanity.py` | Masks obscene RU/EN roots in recognised lyrics of own tracks (anchored at word start, so words such as «тихую» stay clean). |
| `client.py` | HTTP client for `/api/worker/*`; `complete` and `put_file` are retried twice on transport errors and 5xx, never on 4xx. |
| `main.py` | Прогрев моделей, отдельные потоки аренды для `score` и `track`, пульс каждые 10 с; режимы `--warmup` и `--selftest`. A lane survives any non-auth error (logged with the HTTP status, back-off from 1 s to 30 s); only a rejected token stops the worker. Progress reports are best-effort. At start it deletes leftover `job-*` folders, so audio from a killed run does not stay on the PC. |

Outputs (stems, track files) are MP3, 160 kbps CBR, 44.1 kHz, written by libsndfile. Apple MPS не используется: Demucs на MPS занял 23 ГБ памяти на Mac с 16 ГБ и вызвал kernel panic. On the Mac CPU a score job takes about 25 s, longer than the 20 s deadline, so the Mac is not a usable backup scorer with the default `PERF_DEADLINE_S`. Models live in `PEREPEV_MODELS_DIR`: Whisper and torchcrepe load from local files, and once the `htdemucs` bag (yaml and weights) is in the HuggingFace cache, `runtime.models_dir()` sets `HF_HUB_OFFLINE=1` before the hub is imported, so a worker start needs no network; the first start downloads as before.

На Windows-ПК воркер ставит `deploy/gpu-worker/setup.ps1`: всё в `C:\Perepev`, токен зашифрован DPAPI, задача планировщика `PerepevWorker` запускает `run-worker.ps1` от имени SYSTEM при старте Windows. Details: `C:\Perepev` is owned by Administrators with access for SYSTEM and Administrators only (inheritance removed, junctions refused); the token is trimmed, stored with DPAPI machine scope in `token.dat` and never printed (only an 8-hex fingerprint of its SHA-256); CUDA PyTorch (`uv sync --extra cuda`, cu128 wheels) and the models live under `C:\Perepev`; the task restarts every minute up to 999 times. Team instructions: [deploy/gpu-worker/README.md](deploy/gpu-worker/README.md).

## Матчи и сетевой протокол

Состояния матча: `created → waiting → ready_check → countdown → singing → collecting → finished`; отмена и сбой имеют отдельные состояния. Подбор учитывает рейтинг и стартовые ограничения для новичков. До пения оба клиента подтверждают готовность аудио, микрофона, эталона и версии алгоритма.

Команды WebSocket имеют идентификатор и подтверждение; повтор неподтверждённой команды не должен создавать повторное действие. Важные события нумеруются, при переподключении выдаётся состояние матча. Valkey хранит потоки и аренду владельца, поэтому участники могут быть подключены к разным экземплярам API. Итог и изменение рейтинга фиксируются в PostgreSQL.

Полная спецификация сообщений и сроков хранения: [docs/protocol.md](docs/protocol.md). Маршруты объявлены в `crates/api/src/main.rs` и модулях предметных областей.

## GPU worker job queue

Precise scoring and own tracks run on an outbound-only GPU worker that pulls jobs from the API (contract C2 in `docs/superpowers/plans/2026-10-16-hackathon-upgrade.md`).

| Module | Role |
| --- | --- |
| `jobs.rs` | PostgreSQL queue: enqueue, lease (`FOR UPDATE SKIP LOCKED`, score priority 0, track priority 1, lease TTL 120 s renewed by heartbeat and progress), completion, deadlines, files under `DATA_DIR/jobs/<id>/`. |
| `worker.rs` | `/api/worker/*`: Bearer token checked against `WORKER_TOKEN_SHA256` (only the hash is stored); 25 s long-poll lease, heartbeat, input, stems, progress, files, complete (idempotent), fail. Outside the browser CSRF guard. |
| `perf.rs` | `/api/perf`: voice consent, guest cookie `perepev_guest`, 16 kHz PCM chunks (≤ 400 KB each, ≤ 70 s total), score job on finish; the server computes `scoring_core::score_precise` from the worker's `ScoreOutput`. |
| `tracks.rs` | `/api/tracks`: sign-in only, 5 per user per 24 h, 44.1 kHz WAV upload (≤ 12 MB), a track job whose params carry `track_id` so the worker writes `my-<track_id>` into `reference.json`, owner-only files under `DATA_DIR/tracks/<id>/`, and the cleanup task. |

Routes:
- Browser (CSRF guard as for every other mutating route; uploads accept `application/octet-stream` and `audio/wav`): `POST /api/perf`, `PUT /api/perf/{id}/chunk?seq=n`, `POST /api/perf/{id}/finish`, `GET /api/perf/{id}`; `GET|POST /api/tracks`, `PUT /api/tracks/{id}/audio`, `GET /api/tracks/{id}/files/{name}`, `DELETE /api/tracks/{id}`.
- Worker (Bearer token, outside the CSRF guard): `POST /api/worker/lease`, `POST /api/worker/heartbeat`, `GET /api/worker/jobs/{id}/input`, `GET /api/worker/jobs/{id}/asset/{name}`, `POST /api/worker/jobs/{id}/progress`, `PUT /api/worker/jobs/{id}/files/{name}`, `POST /api/worker/jobs/{id}/complete`, `POST /api/worker/jobs/{id}/fail`.

- **Liveness:** each lease or heartbeat refreshes the Valkey key `kv:worker:seen` with a 30 s TTL; `/api/health` reports it as `worker`.
- **No worker:** `POST /api/perf` answers 503 («Точная оценка сейчас недоступна…») when `WORKER_TOKEN_SHA256` is unset or the last heartbeat is older than 30 s. No row, no guest cookie and no voice are stored. The check runs after validation and after the per-IP counter, so a refused attempt uses one rate-limit slot.
- **Fallback:** `GET /api/perf/{id}` answers `offline` at once when the worker is stale or 20 s (`PERF_DEADLINE_S`) have passed since finish. The browser then keeps its provisional score. Overdue score jobs are never leased.
- **Rate limits** (Valkey counters `kv:rl:<bucket>:<who>`, shared by all instances): performances `PERF_LIMIT_PER_HOUR` per IP per hour (default 300); own tracks 5 per user per 24 h. Guests are limited per IP only, not per browser.
- **Body limits:** JSON routes keep 16 KB; chunk 400 KB, track audio 12 MB, worker result 2 MB, worker files 20 MB. Browser uploads keep the Origin and marker-header checks with their own content types.
- **Cleanup** (every 60 s on each instance, idempotent): a performance's folder (chunks and score input) is deleted once the performance is 7 min old, counted from `perfs.created_at`, not from the last chunk, so voice never outlives 10 min (a compile-time assertion in `jobs.rs` checks the margin); the score input is also deleted right after scoring. Folders with no performance and no waiting track job go 30 s after their last write. Score jobs past the deadline become `failed`/`deadline` and lose their input; track jobs not finished 30 min after they were created (queued or running) become `failed`/`timeout`. Expired tracks (24 h) and orphaned track folders are deleted. Score job rows and `perfs` rows are deleted after 24 h, complaints after one year.
- **Worker side:** the worker keeps separate lease lanes for `score` and `track`, so a score never waits behind a track job; it processes one job per lane at a time.

## Данные

| Хранилище | Содержимое |
| --- | --- |
| PostgreSQL `users`, `sessions` | Профили, хеши паролей, согласия, сессии. |
| PostgreSQL `attempts` | Приватная история одиночных попыток. Since migration 0006 also `algorithm` (`precise-1` for a server score, else NULL) and `words_checked`. |
| PostgreSQL `matches`, `match_participants` | Состояния, участники, результаты и кривые матчей. |
| PostgreSQL `ratings`, `rating_events` | Рейтинг и журнал его изменений. |
| PostgreSQL `friendships` | Подтверждённые связи и заявки. |
| PostgreSQL `identities` | Yandex ID / VK ID accounts linked to a user: `(provider, subject) → user_id`. |
| PostgreSQL `complaints` | Requests from the contacts form (data questions, consent withdrawal, rights-holder complaints): name, email, optional link, text; deleted after one year. |
| PostgreSQL `jobs`, `perfs`, `tracks` | GPU worker queue and results, performances with the song, sound mode and voice-consent version (score jobs and `perfs` rows kept 24 h), own tracks with a 24 h expiry. |
| `DATA_DIR` (volume `data`, default `/data`) | Private files: voice chunks and inputs (deleted after the job, at most 10 min), own-track stems, reference and words (24 h). |
| Valkey | Очередь, присутствие, потоки событий, аренды, счётчики ограничений, сигнал GPU-обработчика. |
| Браузер | Гостевая история, настройки, локальные достижения и рекорды. |

Миграции встроены в API и применяются при запуске. Пользовательские данные хранятся в Docker volumes; исходный ZIP не включает эти тома.

Migrations (`crates/api/migrations`):

| File | Change |
| --- | --- |
| `0001_init.sql`, `0002_consent.sql`, `0003_friends.sql` | Baseline schema, consent fields, friendships (before the hackathon upgrade). |
| `0004_identities_legal.sql` | `users.email`, `password_salt` and `password_hash` become nullable (salt and hash both set or both NULL); `users.age_group` (`14plus`/`under14`) and `parent_name` (required for `under14`); tables `identities` and `complaints`. |
| `0005_jobs.sql` | Tables `jobs` (with `worker` for heartbeat lease renewal), `tracks` and `perfs`, with checks, foreign keys and the partial `jobs_pending` index. |
| `0006_attempt_precise.sql` | `attempts.algorithm` (nullable, 1-32 characters; the API accepts only `precise-1`) and `attempts.words_checked` (nullable; `true` only with the precise tag). Older rows stay NULL. |

All six were applied on PostgreSQL 18 in the Docker smoke run of 2026-10-16.

## Sign-in providers, age group and complaints

Added on 2026-10-16 for the hackathon upgrade (`crates/api/src/oauth.rs`, `complaints.rs`, migration `0004_identities_legal.sql`).

- **Yandex ID and VK ID** use the authorization-code flow with PKCE S256. A provider is listed by `GET /api/auth/providers` only when both its client ID and secret are set (see OPERATIONS.md).
- `GET /api/auth/{provider}/start?return=/path` stores `{provider, code_verifier, return}` in Valkey for 10 minutes under `kv:oauth:state:<sha256(state)>` and sets the temporary cookie `perepev_oauth` (the state itself; `Path=/api/auth/`, `HttpOnly`, `SameSite=Lax`, 10 min). `return` is kept only if it is a same-site relative path (no `//`, backslashes, control characters, non-ASCII or `/api/`); otherwise `/account`.
- `GET /api/auth/{provider}/callback` accepts the state only when it equals the cookie, and takes it from Valkey with `GETDEL`, so a replayed or foreign callback fails before any provider call. Outcomes: a known identity gets a session and `302 {return}`; a new identity gets a one-time signup token (Valkey, 10 min; it replaces the state in the `perepev_oauth` cookie, so only the same browser can finish) and `302 /account?signup={token}`; any failure gives `302 /account?authError={code}` with codes `state`, `denied` (`error=access_denied`), `provider` (not configured, exchange or profile failure, missing VK `device_id`), `limit` (more than 60 starts per IP in 15 min), `server`.
- Yandex: `POST {OAUTH_YANDEX_BASE}/token` (form with `client_secret` and `code_verifier`), then `GET {OAUTH_YANDEX_INFO}?format=json` with `Authorization: OAuth <token>`; the subject is `id`. VK ID: `POST {OAUTH_VK_BASE}/oauth2/auth` with `code_verifier`, `device_id`, `redirect_uri`, `state`; the subject is `user_id`. The VK secret is not sent (public PKCE exchange). HTTP goes through `reqwest` with rustls, a 10 s timeout and no redirects. Tokens, codes and secrets are never logged; failures log only the provider, the error kind and the HTTP status.
- `POST /api/auth/complete` (`{token, consent, ageGroup, parentName}`; counted against the registration limit of 12 per IP per 15 min) validates consent and age first (an invalid form does not burn the token), requires the token to match the `perepev_oauth` cookie, then consumes the token and creates a user without email or password, with the neutral nickname `Певец-NNNN`, the identity row and a session.
- Registration requires `ageGroup` (`14plus` or `under14`); `under14` requires `parentName` (2-64 characters), stored with the consent. Consent version is `CONSENT_VERSION = "2026-10-17"`.
- `Profile` is `{id, email|null, name, hasPassword, providers}`. Users without a password confirm `POST /api/me/delete` with `{"confirm":"УДАЛИТЬ"}`. `POST /api/password` answers 400 for an account without an email (every provider account): such an account could never sign in with a password, and the account page shows a note instead of the password form. The «УДАЛИТЬ» path of `POST /api/password` remains only for the theoretical email-without-password case.
- `POST /api/complaints` (`{name, email, url, text}`, each ≤ 2000 characters, valid email, `url` optional) stores a request from the contacts form «Обращение к оператору» (data questions, consent withdrawal, rights-holder complaints); at most 5 accepted requests per IP per hour; rows are deleted after one year.
- Sign-in links on songs, friends, leaders, duels and match pages carry `?return=` so a provider sign-in comes back to the page where it started (`web/src/lib/auth/return.ts` mirrors the server's `safe_return`). A brand-new provider user still finishes on `/account?signup=…`.

## Сборка

1. Стадия Rust устанавливает фиксированный wasm-bindgen, проверяет ядро, собирает API и WASM.
2. Стадия Node устанавливает зависимости по lock-файлу, добавляет WASM, запускает Vitest, собирает статический сайт.
3. Финальный образ API содержит Debian, сертификаты, бинарник и каталог песен; используется непривилегированный пользователь.
4. Финальный образ сайта содержит Caddy и готовую статику.

Compose запускает сайт, API, PostgreSQL и Valkey в одной сети. Локальные каталоги node_modules, target и прежние образы для воспроизведения сборки не требуются. The API image creates `/data` for uid 10001 and sets `DATA_DIR=/data`; `compose.yaml` mounts the `data` volume there. The OAuth client uses `reqwest` with rustls (`aws-lc-sys` compiles C code); the full image build succeeded on 2026-10-16 in `rust:1.99.0-slim-trixie`. The GPU worker is not part of the images: it runs on the team's PC.
