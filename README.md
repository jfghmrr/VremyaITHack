# Перепев

> Запуск из этого архива: [START_HERE.md](START_HERE.md). Достаточно Docker; локальные аккаунты и данные в архив не включены.

Документация комплекта: [суть проекта](PROJECT_OVERVIEW.md), [архитектура](ARCHITECTURE.md), [проделанная работа](WORK_DONE.md), [обслуживание](OPERATIONS.md), [проверка переносимой сборки](docs/portable-verification.md).

Караоке-дуэли, где побеждает точность мелодии, а не высота голоса. Пользователь поёт в удобной тональности. Перепев сравнивает интервалы, ритм, устойчивость и покрытие, поэтому бас и сопрано соревнуются на равных.

Текущая версия — сайт на SvelteKit и Rust. Эта рабочая папка получена из предоставленного архива; исторический React-проект и его git-теги в неё не входят.

- **Петь**: выбрать один из 32 фрагментов с настоящим вокалом и словами — 14 на русском и 18 на английском, среди них известные народные и старинные песни; проверить микрофон, спеть, получить разбор. Затем переслушать момент, потренировать его, сравнить с ориентиром в своей тональности и отправить вызов-призрак.
- **Дуэли**: рейтинговый поиск соперника близкого уровня, живая дуэль с другом по ссылке и асинхронный вызов-призрак.
- **Кабинет**: почта и пароль или вход через Яндекс ID и VK ID, приватная история, рейтинг, калибровка, смена имени и пароля.
- **Друзья**: личный код, заявки с подтверждением, приватный список, отмена/удаление. Открывается из красного шкафчика, значка двух людей вверху или раздела «Дуэли».

Основной браузер — Chrome на ноутбуке (1366×768 и 1920×1080), Edge — целевой. Firefox и Safari поддерживаются по возможности и физически не проверялись. Since the hackathon upgrade, phones (iPhone Safari, Android Chrome) in portrait and landscape are a primary target too; they are checked in Chromium and WebKit emulation, not on physical devices.

## Hackathon upgrade — 2026-10-16

- **Precise scoring.** With a one-tap voice consent (guests too), the browser streams 16 kHz audio while singing; the team's GPU PC extracts the melody and the sung words, and the server computes the final score (`precise-1`). «Ритм и слова» is half rhythm, half words; humming is capped at 40 and the original vocal played through a speaker at 30. Without the PC the browser score stays, marked «слова не проверены».
- **Sound modes.** «В наушниках» plays the instrumental plus a quiet guide vocal, «Без наушников» only the instrumental with echo cancellation. Every catalog song has machine-separated stems.
- **Own tracks.** Signed-in users upload a 15-60 s section of their own song (only that section leaves the device); it becomes a private, singable song for 24 hours.
- **Sign-in and legal pages.** Yandex ID and VK ID (PKCE), age question with parental consent under 14, terms of use, contacts with the operator stub and a request form, cookie and privacy texts that describe the actual processing, a 6+ site label and 0+/6+ song labels.
- **Layouts.** Phone portrait and landscape, tablets and wide monitors; 44 px touch targets; a Russian error page.
- **Catalog.** 8 well-known public-domain songs in free recordings: 32 songs in total.
- **GPU worker and deployment.** `gpu-worker/` (Python) with a Windows installer (`deploy/gpu-worker/setup.ps1`), and a mode behind an existing host nginx (`deploy/nginx`).

Details: [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md), [ARCHITECTURE.md](ARCHITECTURE.md); results and limits: [WORK_DONE.md](WORK_DONE.md).

## Новый дизайн

Использованы материалы владельца из `perepev-design-kit 2`: ночная комната, бумажные карточки, чёрный кот в красных наушниках, открывающиеся шкафчики и курсор-звезда. Функции игры и ядро оценки сохранены. Разбор, история и настройки переключаются внутри текущего экрана; прокрутка длинных списков остаётся внутри панелей.

Описание: [docs/brand.md](docs/brand.md). Фактические проверки и скриншоты: [docs/redesign-verification.md](docs/redesign-verification.md), [проверка вокального каталога](docs/vocal-verification.md). Ограничения ассетов и аудио: [ASSUMPTIONS.md](ASSUMPTIONS.md).

## Друзья и шкафчики

На главной красный шкафчик показывает число друзей, первые два имени и входящие заявки. Зелёный — разные спетые песни, сохранённые исполнения и лучший балл (с учётом завершённых дуэлей). Открытие по наведению или фокусу, переход по нажатию.

Чтобы добавить друга, оба входят в кабинет и открывают `/friends`. Один копирует свой код, второй вставляет его и отправляет заявку. Получатель принимает её во вкладке «Заявки». Список обновляется каждые 15 секунд, при возвращении в окно и кнопкой «Обновить». Почта и история исполнения другу не показываются. Для совместного пения создайте комнату в «Дуэлях» и передайте её ссылку: отдельного чата или отправки приглашений внутри адресной книги пока нет.

Миграция `0003_friends.sql` применяется API при старте, не меняет аккаунты, историю и MMR. Связи попадают в выгрузку данных и удаляются каскадно при удалении кабинета. Лимит — 200 связей с заявками на аккаунт и 12 отправок за 15 минут с адреса в рамках аккаунта.

## Архитектура

```text
Браузер (SvelteKit, статическая сборка)
  ├─ AudioWorklet → Web Worker (pitchy)       кадры высоты; звук уходит на сервер только с согласия (точная оценка)
  ├─ Web Worker → WASM scoring-core           оценка одиночной попытки и дуэли-призрака
  └─ HTTP + WebSocket /api ──► Caddy ──► Rust API (Axum, Tokio), 1…N экземпляров
                                           ├─ PostgreSQL (SQLx): аккаунты, история, матчи, рейтинг, задания, треки
                                           ├─ Valkey: очередь, присутствие, потоки матчей, аренды, лимиты
                                           ├─ DATA_DIR: записи голоса (≤ 10 мин) и свои треки (24 ч)
                                           └─ scoring-core (native): пересчёт матча и точная оценка
GPU worker (team PC) ── outbound HTTPS ──► /api/worker/*   разделение, мелодия, слова, просачивание
```

| Каталог | Что внутри |
| --- | --- |
| `crates/scoring-core` | одно ядро оценки: чистые детерминированные функции без DOM, HTTP и БД |
| `crates/scoring-wasm` | привязки wasm-bindgen для браузера |
| `crates/api` | модульный монолит: `accounts`, `catalog`, `history`, `matches`, `queue`, `ratings`, `realtime`, `ws`; since 2026-10-16 also `oauth`, `complaints`, `jobs`, `worker`, `perf`, `tracks` |
| `gpu-worker` | Python GPU worker `perepev_worker` (separation, melody, words, bleed, catalog import) and its benchmark (`bench/`) |
| `web` | SvelteKit 3: экраны, дизайн-система, аудио, клиент протокола |
| `contracts` | JSON-схемы HTTP/WebSocket, из них генерируются типы клиента |
| `fixtures` | эталоны прежней реализации: оценка (`scoring`) и настоящая SQLite-база кабинетов (`legacy`) |
| `tests/integration` | два экземпляра API, отказы, миграция |
| `deploy` | Caddyfile, резервное копирование, примеры окружения сервера, сайт для nginx хоста и его установщик (`deploy/nginx`), установщик GPU-воркера для Windows (`deploy/gpu-worker`) |
| `docs` | протокол, бренд, протокол проверок, скриншоты |

Зафиксированные версии: Rust 1.99.0 (`rust-toolchain.toml`), Axum 0.8.9, Tokio 1.53, SQLx 0.9.0, redis-rs 1.7.1, wasm-bindgen 0.2.129; Svelte 5.57.2, SvelteKit 3.0.1, Vite 8.3.4, TypeScript 6.0.3, Vitest 5.0.4, Playwright 1.64.0; PostgreSQL 18.6, Valkey 9.1.2, Caddy 2.11.7. SvelteKit 3 требует TypeScript 6, поэтому TypeScript 7 не используется. Точные версии всех зависимостей записаны в `Cargo.lock` и `web/package-lock.json`.

## Запуск через Docker

Нужен Docker Desktop (macOS/Windows) или Docker Engine с Compose v2. Node.js и Rust не нужны, первая сборка требует интернета и занимает несколько минут.

```sh
docker compose up --build -d
```

Открой **http://localhost:8080**, разреши микрофон, надень наушники.

```sh
docker compose ps
docker compose logs -f api
docker compose down            # остановка, данные сохраняются
```

`docker compose down -v` удаляет тома с аккаунтами и историей — не используй для обычной остановки. Если порт 8080 занят, создай `.env` со строками `PEREPEV_PORT=8081` и `APP_ORIGINS=http://localhost:8081`.

Два экземпляра API за одним Caddy: `docker compose up --build -d --scale api=2`. Матчи, очередь и доставка событий работают через Valkey и PostgreSQL, поэтому игроки могут быть подключены к разным экземплярам.

PostgreSQL и Valkey не публикуют порты наружу, сайт и API доступны только через Caddy на 127.0.0.1.

### Важно про игру через интернет

**Две локальные установки Docker на разных компьютерах не образуют общую игру.** У каждой своя база, своя очередь и свои матчи. Чтобы два человека встретились в живой дуэли, оба должны открыть **один и тот же сервер** по HTTPS. Микрофон в браузере доступен только на HTTPS-сайтах и на `localhost` — для localhost браузеры делают специальное исключение. Поэтому сайт по адресу вида `http://192.168.1.5:8080` микрофон не получит.

## Общий сервер

Deployment to perepev.lumnex.ru in progress at the time of writing; see OPERATIONS.md.

If the server's own nginx already serves other sites on ports 80 and 443, use the nginx mode instead: containers on `127.0.0.1:8097`, a certbot certificate and the site file installed by `sudo bash deploy/nginx/install-site.sh`. The steps are in [OPERATIONS.md](OPERATIONS.md), section «Сервер за существующим nginx» (prepared for `https://perepev.lumnex.ru`). The steps below are for a server where Caddy holds ports 80 and 443 itself.

1. Сервер с Docker, домен с A/AAAA-записью на него, открытые порты 80 и 443.
2. `cp deploy/server.env.example .env` и заполнить `SITE_DOMAIN` и длинный `POSTGRES_PASSWORD`.
3. `docker compose -f compose.yaml -f compose.server.yaml up --build -d`.

Caddy сам получит сертификат и включит HTTPS. API принимает изменяющие запросы и WebSocket только с `https://SITE_DOMAIN`, cookie получают флаг `Secure`. Лимит попыток входа считается по адресу клиента, который передаёт Caddy (`TRUST_PROXY=true`), и общий для всех экземпляров (в Valkey). Which address Caddy passes depends on the mode:
- *This mode* (`compose.server.yaml`, Caddy on 80/443): `CADDY_TRUSTED_PROXIES` is empty, so Caddy accepts `X-Forwarded-For` from nobody and passes the connection address.
- *nginx mode* (OPERATIONS.md): Caddy accepts `X-Forwarded-For` only from private addresses, i.e. the host nginx arriving through the Docker gateway; nginx overwrites the header with the real client address. Caddy then passes exactly one address to the API.

Перед публичным запуском выполни раздел «Требования закона РФ перед публикацией» ниже и посмотри «Что осталось» в `ASSUMPTIONS.md`.

## Требования закона РФ перед публикацией

Сайт обрабатывает персональные данные (почта, имя, результаты), поэтому владелец становится оператором по 152-ФЗ. В коде уже есть:

- документы `/legal/privacy` (политика), `/legal/consent` (согласие отдельным документом, как требует ч. 1 ст. 9 с 01.09.2025), `/legal/cookies`, `/legal/music` и ссылки на них в подвале;
- `/legal/terms` (пользовательское соглашение: возраст, запись голоса, свой трек, жалобы) и `/legal/contacts` (оператор «Команда mugsize» без выдуманных реквизитов, форма жалобы правообладателя → `POST /api/complaints`);
- вход через Яндекс ID и VK ID (кнопки берутся из `GET /api/auth/providers`; первый вход завершается на `/account?signup=…` согласием и возрастом), ошибки возврата `?authError=…` показываются по-русски;
- вопрос о возрасте при любой регистрации; младше 14 лет — флажок и имя родителя или законного представителя; знак 6+ в подвале и метка `age` (по умолчанию 0+) на карточках песен;
- отдельный флажок согласия при регистрации; сервер сохраняет время и редакцию согласия (`users.consent_at`, `consent_version`);
- уведомление о cookie (используются только необходимые: сессия `perepev_session`, защита входа через сервис `perepev_oauth` на 10 минут и `perepev_guest` на 24 часа для точной оценки у гостя; настройки — в localStorage; аналитики и рекламы нет);
- выгрузка своих данных и удаление кабинета с подтверждением паролем (без пароля — словом «УДАЛИТЬ») — отзыв согласия с немедленным удалением данных;
- хранение кривых дуэлей 30 дней. The application uses the client IP only as the key of rate-limit counters and keeps it at most one hour (in nginx mode the site template turns the host nginx's access log off; only the error log, which records the client address on failed requests, stays under the server's own log settings, see ASSUMPTIONS.md, «Hackathon upgrade — 16.10.2026», «Deployment»): 15 minutes for registrations, failed logins, friend requests and Yandex/VK sign-in starts, one hour for contact-form requests and precise-scoring performances;
- separate voice consent before precise scoring; voice deleted after scoring, at most 10 minutes; precise results and performance records 24 hours; own tracks 24 hours; contact-form requests one year.

Что должен сделать владелец (код этого не заменяет):

1. Оформить документы под фактического владельца и размещение: указать подтверждённые реквизиты и контакт для обращений. В локальной демоверсии указана команда mugsize; вымышленных адресов и красных заглушек нет. Название команды не заменяет реквизиты владельца публичного сервера.
2. Подать уведомление об обработке персональных данных в Роскомнадзор (ст. 22 152-ФЗ, pd.rkn.gov.ru) и вписать номер в реестре.
3. Разместить сервер с базами в России (ч. 5 ст. 18 152-ФЗ: локализация данных граждан РФ) и отразить фактическое размещение в политике.
4. Хранить резервные копии не дольше 30 дней (так написано в политике) и удалять их по графику.
5. Показать документы юристу: тексты составлены по фактической обработке на сайте, но юридической экспертизой не являются.

При изменении текста согласия увеличь `documents.consent` в `operator.ts` и `CONSENT_VERSION` в `crates/api/src/accounts.rs` (сейчас обе — `2026-10-17`; `legal.spec.ts` сверяет их через выгрузку данных).

## Резервные копии и восстановление

Окончательные данные — в PostgreSQL. Valkey хранит только временное состояние и в копию не входит.

```sh
deploy/backup.sh                         # backups/perepev-ГГГГММДД-ЧЧММСС.dump
deploy/restore.sh backups/perepev-….dump  # ПЕРЕЗАПИСЫВАЕТ базу, печатает количество записей
```

С переменной `DATABASE_URL` скрипты работают с базой напрямую, без Docker. Процедура проверена: копия тестовой базы восстановлена в пустую базу, количество пользователей и матчей совпало (`docs/verification.md`). Копии стоит хранить вне сервера и регулярно пробовать восстанавливать.

## Перенос данных из прежней версии (SQLite → PostgreSQL)

Импорт переносит пользователей с исходными scrypt-хешами (повторная регистрация не нужна), действующие сессии (вход сохраняется) и историю попыток. Аудио в прежней версии не хранилось. Старые баллы помечаются как посчитанные прежней версией (`algorithmVersion: null`).

1. В каталоге прежней версии остановить её API, чтобы копия была согласованной, и снять копию базы:
   ```sh
   docker compose stop api
   docker run --rm -v perepev_accounts:/data -v "$PWD":/out alpine cp /data/perepev.sqlite /out/perepev.sqlite
   ```
   Исходный том `perepev_accounts` при этом не меняется — это и есть путь отката.
2. Пробный импорт (транзакция откатывается, печатаются количества):
   ```sh
   docker compose run --rm -v /путь/к/perepev.sqlite:/import/perepev.sqlite:ro api import-legacy /import/perepev.sqlite --dry-run
   ```
3. Настоящий импорт — та же команда без `--dry-run`. Количества проверяются после вставки, при расхождении транзакция откатывается. Повторный запуск ничего не дублирует.
4. Сделать `deploy/backup.sh`.

Откат к SQLite выполняется в отдельно сохранённой прежней папке проекта: этого кода и тега нет в данном архиве. Останови новую версию через `docker compose down` **без `-v`**, затем запусти прежнюю из её каталога. Обе версии по умолчанию занимают порт 8080.

Без Docker: `DATABASE_URL=postgres://… target/release/perepev-api import-legacy путь/к/perepev.sqlite --dry-run`.

## Разработка без Docker

Нужны Rust (rustup подхватит 1.99.0 и цель wasm32 из `rust-toolchain.toml`), `wasm-bindgen-cli 0.2.129` (`cargo install wasm-bindgen-cli --version 0.2.129 --locked`), Node.js 22.17+, PostgreSQL и Valkey (или Redis-совместимый сервер).

```sh
createdb perepev
cargo build --release -p api
DATABASE_URL=postgres://$USER@localhost/perepev SONGS_DIR=web/static/songs ./target/release/perepev-api
```

Во втором терминале:

```sh
cd web && npm ci && npm run dev     # собирает WASM и открывает http://127.0.0.1:5173
```

Vite проксирует `/api` (HTTP и WebSocket) на 127.0.0.1:3001. Без API одиночное пение работает, а кабинет и дуэли сообщают об отсутствии связи.

Основные переменные API: `DATABASE_URL`, `VALKEY_URL`, `BIND`, `APP_ORIGINS` (через запятую), `COOKIE_SECURE`, `TRUST_PROXY`, `SONGS_DIR`, `INSTANCE_ID`, `DB_POOL`, `COMPUTE_THREADS`, `COMPUTE_QUEUE`, `GAME_CONFIG` (JSON с игровыми настройками, см. `crates/api/src/config.rs`), `WORKER_TOKEN_SHA256` (GPU worker token hash; empty: `/api/worker/*` answers 401 and `POST /api/perf` 503), `DATA_DIR` (private voice and own-track files; default `/data`, so set e.g. `DATA_DIR=./data` outside Docker), `PERF_DEADLINE_S` (precise-score deadline after the song ends, default 20), `PERF_LIMIT_PER_HOUR` (precise-scoring performances per hour from one IP, default 300). Sign-in through Yandex ID and VK ID: `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET`, `VK_CLIENT_ID`, `VK_CLIENT_SECRET`, optional `PUBLIC_ORIGIN`; app registration is described in [docs/oauth-setup.md](docs/oauth-setup.md).

## Проверки

```sh
cargo test --release --workspace                  # паритет ядра с прежним TS, регрессии, модульные тесты API
cargo clippy --release --workspace --all-targets
cd web && npm run check && npm test               # типы и паритет WASM на тех же эталонах
npx playwright test                               # сквозные сценарии в изолированном Chromium (нужен API на :3001 и BASE_URL или vite preview)
                                                  # проект webkit: матрица устройств и страница ошибки (npx playwright install chromium webkit)
cd .. && node --test --test-concurrency=1 tests/integration/*.test.mjs   # два экземпляра, отказы, миграция, очередь GPU (Node 26 needs the glob)
node tools/load/duels.mjs 100                     # нагрузочный прогон 100 дуэлей
(cd gpu-worker && uv run --extra cpu pytest -m "not models")   # GPU worker without models
pwsh deploy/gpu-worker/setup.Tests.ps1            # Windows installer, -DryRun only
```

Интеграционные проверки сами поднимают два экземпляра API на тестовой базе `perepev_test` и в базе Valkey №1. Браузерные проверки используют синтетический микрофон (генератор поёт эталон в выбранной тональности через настоящий AudioWorklet, Worker и WASM). Это не доказывает качество на реальных голосах и оборудовании: нужен живой прогон с людьми, проводными и Bluetooth-наушниками.

Результаты с указанием оборудования — в `docs/verification.md` (protocol of 2026-10-14). Current results after the hackathon upgrade: [WORK_DONE.md](WORK_DONE.md).

## Песни с вокалом

В открытом каталоге **только записи с голосом исполнителя**: 32 коротких фрагмента, 14 на русском и 18 на английском.

- 24 фрагмента из песен Josh Woodward, Complex Numbers и проекта Виктора Аргонова. Это песни с авторским правом, законно предоставленные авторами под Creative Commons; они не объявляются общественным достоянием.
- 8 известных песен, чьи музыка и слова в России в общественном достоянии: «Ой, то не вечер», «Дорогой длинною», «Ямщик, не гони лошадей», «Гори, гори, моя звезда», Amazing Grace, Twinkle, Twinkle, Little Star, My Bonnie Lies Over the Ocean, Danny Boy. Записи взяты только свободные: работа оркестра ВВС США (общественное достояние), CC0, CC BY 3.0 и CC BY-SA 3.0. У каждой песни есть возрастная метка 0+ или 6+.

25 прежних инструментальных мелодий исключены из выбора песни и подбора дуэлей. Их исходные файлы сохранены для старых данных и регрессионных проверок.

Фильтры «Русские» и «English», поиск по названию/исполнителю, прослушивание и слова доступны на странице «Песни». Это фрагменты до минуты, а не полные альбомные записи. «Послушать» играет исходный микс с вокалом. During singing, «В наушниках» plays the instrumental with the original vocal as a quiet guide (sing along in any key), and «Без наушников» plays only the instrumental. **Нужны наушники** в первом режиме: from a speaker the guide reaches the microphone, and precise scoring then caps the score at 30.

У каждой песни есть авторство, ссылка на источник, лицензия и файл `web/static/songs/<id>/CREDITS.json`. Те же сведения доступны в `/legal/music` и по ссылке из карточки песни. Подробный список, отбор текстов и границы проверки: [docs/vocal-catalog.md](docs/vocal-catalog.md).

Пословная подсветка в одиночном караоке синхронизирована с аудио; Пробел ставит звук и текст на паузу. В тренировке и живой дуэли пока используется подсветка строк. Времена слов и мелодия подготовлены автоматически с ручной сверкой текста: возможны небольшие ошибки на распевах, бэк-вокале и дыхании. Синтетические тесты скоринга не заменяют проверку живого пения.

## Подготовка нового вокального трека

1. Найди разрешение на **запись, исполнение, композицию, текст и их переработку**. Бесплатное скачивание, указание автора или некоммерческий показ сами по себе разрешением не являются. Для текущего каталога использованы CC BY 4.0, CC BY 3.0 US, CC BY 3.0, CC BY-SA 4.0, CC BY-SA 3.0, CC0 1.0 и записи федерального правительства США в общественном достоянии. Не добавляй кавер, если не подтверждены права на исходную песню.
2. Сохрани страницу источника, имя автора и исполнителей, точную версию лицензии, хеш исходной записи и сведения об изменениях. Проверь текст и конкретную выбранную версию записи; отбор альбома целиком без проверки каждого трека не подходит.
3. Возьми полную запись **с вокалом**. Отдельная вокальная дорожка нужна только для точного извлечения мелодии: у Complex Numbers использованы официальные дорожки, у Josh Woodward — локальное разделение Demucs. Не загружай голоса пользователей в инструменты подготовки.
4. Выбери законченные строки длительностью до 60 секунд, оставь небольшой вход перед голосом. Подготовь эталон pYIN с шагом 10 мс, распознай/разметь слова локально и сверь их с записью и опубликованным текстом. Удали распознанные слова, которых в записи нет; проверь октавные ошибки и паузы.
5. Добавь запись в `tools/songs/vocal_catalog.json`. Повторная упаковка подготовленных локальных материалов:

   ```sh
   python3.12 -m venv tools/songs/.venv
   tools/songs/.venv/bin/pip install -r tools/songs/requirements-vocals.txt
   tools/songs/.venv/bin/python tools/songs/import_vocals.py --jobs 2
   ```

   Эта команда требует `cache/vocals/<id>.mp3` (исходный микс, SHA-256 совпадает с манифестом), `cache/analysis/<id>/vocal.wav` (вокал, выровненный по времени оригинала) и `cache/analysis/<id>/transcript.json` (`segments[].words[]` с `word`, `start`, `end`; времена в секундах оригинала). Все пути — внутри `tools/songs/`. В манифесте `lines` содержит отредактированные строки с временами оригинала, а `clip` — границы и длину добавляемой паузы. Кеши, модели и полные исходные альбомы не входят в репозиторий. **Для запуска сайта и Docker ничего из этого не нужно**: готовые короткие записи и разметка уже включены в `web/static/songs`.
6. Проверь полученные `reference.json`, `backing.mp3`, `lyrics.words.json` и `CREDITS.json`, прослушай фрагмент, затем выполни `npm test`, `npm run check` и `npm run build` из `web`. Индекс рабочего каталога должен содержать только записи с `hasVocals: true`.

### Песня в общественном достоянии с известным текстом

Для народной или старинной песни (музыка и слова в общественном достоянии в России) в свободной записи текст не распознаётся, а берётся из источника. Команда воркера строит все файлы песни из одной записи:

```sh
cd gpu-worker
PEREPEV_DEVICE=cpu uv run --extra cpu python -m perepev_worker.catalog import <запись.mp3|ogg> \
  --id <id> --clip <начало>,<конец> --lyrics lyrics.txt --language ru|en --credits credits.json \
  --age 0+|6+ [--lead 1.0] [--title … --artist …] [--force]
```

- `--clip` — секунды записи с законченными строками; вместе с `--lead` (тишина перед фрагментом) это 15–60 секунд.
- `lyrics.txt` — только строки внутри фрагмента, по одной спетой строке на строку файла, как они звучат в этой записи.
- `credits.json` — обязательные `title`, `artist`, `credits` (авторы и исполнители), `source`, `download`, `license`, `licenseUrl`, `lyricsSource` и `review`: проверка реестра иностранных агентов и списка экстремистских материалов (дата, источник, результат) и проверка текста. Образец — `web/static/songs/amazing-grace-usaf/CREDITS.json`.

Команда разделяет фрагмент Demucs на голос и минус, строит эталон высоты torchcrepe по голосу (только около строк текста) и получает время известных слов из Whisper. Распознанные слова служат опорами, остальные слова интерполируются между ними. Результат: `backing.mp3`, `instrumental.mp3`, `guide.mp3`, `reference.json`, `lyrics.words.json`, `CREDITS.json` с SHA-256 всех файлов и числами качества, а также запись в `index.json` с `stems`, `age` и языком. На Mac с 16 ГБ памяти запускай по одной песне в процессе. Затем добавь песню в `web/src/lib/legal/vocal-music.json`: тест каталога проверяет, что `/legal/music` перечисляет каждую песню индекса с изменениями.

**Words check per song (`"wordsCheck"` in `index.json`).** Optional boolean, default `true`. With `"wordsCheck": false` the API sends the precise-scoring job without lyric words (`words: []`), so the server scores the melody only: `wordsChecked: false` («слова не проверены»), the «Ритм» axis without words, and no words cap of 40 (the bleed and coverage caps still apply). Set it only when the GPU worker's Whisper finds no words even in the song's own vocal; otherwise a clean take gets the words cap. Currently set for «Ямщик, не гони лошадей», «Ой, то не вечер» and «Дорогой длинною»: on production (2026-10-16) their own guide vocal, shifted +3 semitones, scored 86.7 / 72.0 / 83.5 before caps but got the cap of 40 (wordsSung 0.00 / 0.00 / 0.04), because Whisper large-v3-turbo returned only non-speech text («ПЕСНЯ», «Продолжение следует...») for these recordings. The flag does not touch `reference.json`, so song versions stay the same. Details: [docs/vocal-catalog.md](docs/vocal-catalog.md).

Поле `backing` в формате `reference.json` сохранено ради совместимости; у новых песен оно указывает на **микс с вокалом**, а не на минусовку. Пословная разметка имеет вид `{ "v": 1, "lines": [{ "line": 0, "words": [{ "text": "Привет!", "start_s": 2, "end_s": 3 }] }] }`. Текст должен точно совпадать со строками `lyrics`, времена — относиться к тому же фрагменту.

Версия эталона — первые 12 символов SHA-256 файла `reference.json`. Оба участника матча обязаны иметь одинаковую версию. При изменении опубликованного эталона используй **новый `id`**, чтобы старые вызовы не сравнивались с другой мелодией. Старые MIDI-генераторы оставлены для регрессионных данных; их результат не является актуальным вокальным каталогом.

## Лицензии

Программный код — MIT (`LICENSE`). **Музыка, текст и их переработанные материалы сохраняют лицензии авторов**: CC BY 4.0, CC BY 3.0 US либо CC BY-SA 4.0; for the 8 public-domain songs the recordings are CC BY 3.0, CC BY-SA 3.0, CC0 1.0 or a US federal work. MIT проекта не распространяется на чужие фонограммы. Для BY-SA адаптации музыкальных материалов предоставляются под той же версией CC BY-SA, что и запись (4.0 или 3.0); adaptations of the CC0 and US federal recordings are CC0 1.0. При дальнейшем распространении сохраняй авторство, источники, лицензии и указание изменений. Подробности — [LICENSES.md](LICENSES.md) и `/legal/music`.

Уведомления о сторонних компонентах сайта и сервера — `THIRD_PARTY_NOTICES.txt` (их собирает `node tools/notices.mjs`). Шкафчики, достижения, регистрация и правила подсчёта рейтинга от обновления каталога не меняются.

## Защита хакатона · mugsize

Актуальная презентация в `presentation/v2/`: восемь слайдов на пять минут, включая короткое живое демо:

- `Perepev-mugsize-v2.pdf` — для показа с сохранённым оформлением на любом ноутбуке;
- `Perepev-mugsize-v2.pptx` — редактируемая версия с заметками докладчика и графиком транспонирования (шрифты Oswald, Golos Text и Caveat);
- `Сценарий защиты — 5 минут.txt` — речь, тайминг, подготовка демо, запасной сценарий и ответы на вопросы.

Предыдущая версия сохранена в `presentation/`.

PDF сохраняет внешний вид проверенных слайдов. PPTX содержит редактируемый текст, но без установленных шрифтов PowerPoint может заменить их. Скриншоты демонстрируют тестовые исполнения прототипа, а не запись реального человека. Стек, функции и ограничения описаны по фактической версии сайта.

## Навигация и прослушивание — 16.10.2026

- «Друзья» — отдельная вкладка `/friends`. Музыкальная тетрадь и история исполнений находятся в `/progress`; гостю доступна его локальная история. `/account` содержит вход, регистрацию, личные данные и настройки безопасности.
- В документах есть крестик: он возвращает в предыдущий раздел сайта, а после прямого открытия или перезагрузки документа — на главную.
- На результате кнопки «Как пел» и «Ориентир» запускают прослушивание, если звук ещё не включён, и переключают дорожку во время воспроизведения. «Стоп» останавливает обе дорожки; шкала времени привязана к аудиочасам. Подготовка ориентира и ошибки показываются явно, необработанную запись можно слушать без готового ориентира.
- На главной мелодию включает сам магнитофон или подпись под ним. Дверцы шкафчиков открываются вправо почти до положения ребром, чтобы не заслонять соседний шкаф.
