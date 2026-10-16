# Запуск и обслуживание

Быстрый путь — [START_HERE.md](START_HERE.md). Команды ниже выполняются из корня `Perepev`.

## Настройки локальной установки

По умолчанию сайт доступен на `http://localhost:8080`. Настройки можно записать в `.env`; образец — `.env.example`.

| Переменная | Назначение |
| --- | --- |
| `PEREPEV_PORT` | Порт сайта на компьютере; стандартно 8080. |
| `APP_ORIGINS` | Разрешённые адреса браузера через запятую, с протоколом и портом. |
| `POSTGRES_PASSWORD` | Пароль новой базы; локально есть значение по умолчанию. Для собственного значения удобны латинские буквы и цифры, поскольку оно входит в URL подключения. |
| `COOKIE_SECURE` | `true` adds the `Secure` flag to cookies; default `false` for `http://localhost`. Set `true` behind HTTPS (the nginx example does; `compose.server.yaml` forces it). |
| `WORKER_TOKEN_SHA256` | SHA-256 (64 hex characters) of the GPU worker token. Empty: `/api/worker/*` answers 401 and `POST /api/perf` answers 503 (no voice is uploaded), so the browser score stays final. |
| `PERF_DEADLINE_S` | Seconds to wait for the precise score after the song ends; default 20. Then the browser score becomes final. Keep it well under 7 minutes: a performance's audio is swept once the performance is 7 minutes old (at most 10 minutes), so a longer deadline would delete inputs that are still waiting. |
| `PERF_LIMIT_PER_HOUR` | Precise-scoring performances accepted per hour from one IP address; default 300 (at a venue every phone shares one NAT address). Must be 1 or more. |
| `SITE_DOMAIN` | Only for `compose.server.yaml` (Caddy on 80/443): the site's domain. |

GPU worker token: generate it with `openssl rand -hex 32`, give the token itself only to the worker PC, and put its hash into `.env`: `printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1` (on Linux, `sha256sum`). The API refuses to start if the value is not 64 hex characters. API-only setting: `DATA_DIR` (default `/data`, the `data` volume; the image sets it, `compose.yaml` does not pass it). `TRUST_PROXY` is fixed to `true` in `compose.yaml` and cannot be set from `.env`. `POST /api/perf` also answers 503 while the worker's heartbeat is older than 30 s.

### Sign-in through Yandex ID and VK ID

The buttons appear only when the provider's credentials are set; empty values mean "off". Register the apps as described in [docs/oauth-setup.md](docs/oauth-setup.md) and put the values into `.env` (never into the repository). `compose.yaml` passes them to the API.

| Variable | Purpose |
| --- | --- |
| `YANDEX_CLIENT_ID`, `YANDEX_CLIENT_SECRET` | Yandex ID app «ClientID» and «Client secret». |
| `VK_CLIENT_ID`, `VK_CLIENT_SECRET` | VK ID app «ID приложения» and «Защищённый ключ». Both enable VK; the PKCE code exchange does not send the secret. |
| `PUBLIC_ORIGIN` | Optional. Site address for `redirect_uri` (`{PUBLIC_ORIGIN}/api/auth/{yandex,vk}/callback`); defaults to the first `APP_ORIGINS` entry, e.g. `https://perepev.lumnex.ru` on the server. |
| `OAUTH_YANDEX_BASE`, `OAUTH_YANDEX_INFO`, `OAUTH_VK_BASE` | Provider endpoints; defaults `https://oauth.yandex.ru`, `https://login.yandex.ru/info`, `https://id.vk.ru`. Only tests override them; `compose.yaml` does not pass them. |

Check: `GET /api/auth/providers` returns `{"providers":["yandex","vk"]}` when both are configured. Register the exact callback URL of every address you use (for example `https://perepev.lumnex.ru/…` and `http://localhost:8091/…`) at both providers; the VK app must keep its default «Уровень конфиденциальности» (see docs/oauth-setup.md). When this was written (2026-10-16), a full sign-in through the real services had not been completed; only the start redirect was checked with real credentials on a local stack.

Простое изменение `POSTGRES_PASSWORD` не меняет пароль в уже созданном томе PostgreSQL. Не удаляй существующий том ради изменения настройки: сначала предусмотрены резервная копия и отдельная процедура смены пароля в базе.

В одном Docker Engine можно запустить несколько независимых копий: используй другое имя Compose-проекта и другой порт. Например, создай `.env` с портом 8081 и обоими origin на 8081, затем запускай все команды с `docker compose -p perepev-demo …`. Имена проекта определяют также имена томов.

## Обновление и диагностика

```sh
docker compose up --build -d --wait --wait-timeout 180
docker compose ps
docker compose logs --tail=100 api
docker compose logs --tail=100 web
```

Перед заменой исходников создай резервную копию базы. При обновлении используй то же имя проекта и сохранённые настройки `.env`, чтобы подключились прежние тома. Миграции применяет API при старте.

Обычная остановка — `docker compose down`, повторный запуск — `docker compose up -d`. Удаление с `down -v` предназначено для сознательного сброса данных, а не для перезапуска.

## Данные и резервная копия

PostgreSQL хранит аккаунты, историю, друзей, результаты и рейтинг. Valkey хранит рабочее состояние очереди/матчей; его нельзя считать заменой основной базы. Закрытие или удаление контейнеров не удаляет именованные тома.

The `data` volume holds only short-lived private files (voice recordings for at most 10 minutes, own tracks for 24 hours) and is not part of the backup. All API instances share it when scaled.

На macOS/Linux или в Bash на Windows:

```sh
bash deploy/backup.sh
```

Скрипт создаёт `backups/perepev-ДАТА-ВРЕМЯ.dump`. Для Windows PowerShell, без Bash и двоичного перенаправления вывода:

```powershell
docker compose exec -T postgres pg_dump --format=custom --no-owner -U perepev -d perepev -f /tmp/perepev-backup.dump
docker compose cp postgres:/tmp/perepev-backup.dump ./perepev-backup.dump
```

Чтобы восстановить свою копию на новой установке, сначала запусти её, затем останови API и сайт на время восстановления:

```sh
docker compose stop web api
docker compose cp ./perepev-backup.dump postgres:/tmp/perepev-restore.dump
docker compose exec -T postgres pg_restore --clean --if-exists --no-owner -U perepev -d perepev /tmp/perepev-restore.dump
docker compose start api web
```

Восстановление перезаписывает данные целевой базы. На исходной установке не выполняй его, если задача — только перенести копию на другой компьютер. Гостевая история находится в localStorage браузера и в PostgreSQL-копию не входит. Рабочие матчи во время переноса нужно завершить; перенос временной очереди не предусмотрен.

## Сервер за существующим nginx

Use this mode when the server's host nginx already serves other sites on ports 80 and 443, as on the lumnex server for `https://perepev.lumnex.ru`. The containers listen only on `127.0.0.1:8097`; nginx terminates TLS with a certbot certificate and proxies everything to Caddy. Files: `deploy/server-nginx.env.example`, `deploy/nginx/perepev.lumnex.ru.conf` (site template) and `deploy/nginx/install-site.sh` (root installer). Docker Compose 2.24.4 or newer is needed, as for the other modes. Deployment to perepev.lumnex.ru was in progress at the time of writing (2026-10-16).

1. Copy the repository to the server. The repository has no remote, so send a tracked-files archive from the Mac (`git archive` leaves out `.env`, `target` and `node_modules`; while the Mac's VPN is on, add `-o ProxyCommand='nc -b en0 %h %p'` to `ssh`):

   ```sh
   git archive --format=tar hackathon-upgrade | ssh lumnex 'mkdir -p ~/apps/perepev && tar -x -C ~/apps/perepev'
   ssh lumnex
   cd ~/apps/perepev
   ```

2. Write `.env` with mode 600 and a generated database password:

   ```sh
   cp deploy/server-nginx.env.example .env
   chmod 600 .env
   sed -i "s/^POSTGRES_PASSWORD=$/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env
   grep -c '^POSTGRES_PASSWORD=.' .env      # must print 1
   ```

   Then fill in `WORKER_TOKEN_SHA256` and, if needed, the Yandex ID / VK ID values (`nano .env`). The OAuth redirect URIs are `https://perepev.lumnex.ru/api/auth/yandex/callback` and `https://perepev.lumnex.ru/api/auth/vk/callback`. Never leave `POSTGRES_PASSWORD` empty: `compose.yaml` would fall back to the local default password.

3. Build and start (the project name `perepev` equals the `name:` in `compose.yaml`, so `deploy/backup.sh` works unchanged):

   ```sh
   docker compose -p perepev up -d --build --wait --wait-timeout 180
   curl -s http://127.0.0.1:8097/api/health        # "ok":true
   docker compose -p perepev ps                      # web: 127.0.0.1:8097->80/tcp only
   ```

4. The owner runs the nginx step once; it needs root:

   ```sh
   sudo bash deploy/nginx/install-site.sh
   ```

   The script refuses to run without root and stops before changing anything if `nginx -t` already fails or another enabled site already uses `perepev.lumnex.ru`. It then obtains the certificate `perepev` if it is missing, installs `/etc/nginx/sites-available/perepev.lumnex.ru.conf` with its link in `sites-enabled`, and reloads nginx only after `nginx -t` passes. On any error it puts the site files back as they were. Other sites' files are never touched. At the end it checks `https://perepev.lumnex.ru/api/health` through this nginx with certificate verification, checks `certbot.timer`, and runs `certbot renew --dry-run` (to skip it: `sudo SKIP_DRY_RUN=1 bash deploy/nginx/install-site.sh`). Running it again is safe: an existing certificate and an unchanged site file are left alone. A rerun after a template change replaces a hand-edited site file without keeping a lasting backup.

   Options are environment variables placed **after** `sudo`, for example `sudo ACME_METHOD=dns-cloudflare bash deploy/nginx/install-site.sh`. Written before it (`ACME_METHOD=… sudo bash …`) they do not reach the script, because sudo resets the environment by default.

   The script picks the domain check method (`ACME_METHOD=auto`):
   - It uses DNS-01 through the certbot Cloudflare plugin when the server already has a Cloudflare key used for a `lumnex.ru` certificate. On this server that is the key of `hram.lumnex.ru` and `hackathon.lumnex.ru`, which all current certificates use.
   - Otherwise it uses HTTP-01 through the webroot `/var/www/perepev-acme`, after checking that `http://perepev.lumnex.ru/.well-known/acme-challenge/` reaches this nginx.

   HTTP-01 does not work on this server: external port 80 of 46.39.20.24 goes to another device. A probe on 2026-10-16 got an IIS 404 page, and the note in `/etc/nginx/sites-available/hram.conf` says the same. The script's probe stops the HTTP-01 path before it can hit Let's Encrypt limits. Other options, passed the same way: `sudo ACME_METHOD=dns-cloudflare CF_CREDENTIALS=/path/to/cloudflare.ini bash deploy/nginx/install-site.sh`, `sudo ACME_METHOD=webroot bash …` (add `SKIP_HTTP_PROBE=1` only if sure that port 80 reaches this nginx), and `sudo CERTBOT_EMAIL=… bash …` (used only when the server has no Let's Encrypt account yet; without it the account is registered without an email).

   Renewal runs from `certbot.timer`. The renewal settings stored by certbot (DNS-01 or webroot) are reused, and the deploy hook `systemctl reload nginx` loads the new certificate.

5. Verify:

   ```sh
   curl -sS https://perepev.lumnex.ru/api/health
   curl -sI https://perepev.lumnex.ru/ | grep -i -E '^HTTP|strict-transport|via'
   sudo certbot certificates --cert-name perepev
   ```

   In a browser, create an account and open «Дуэли»: the live connection is a WebSocket on `/api/ws`. The GPU worker uses `PEREPEV_SERVER=https://perepev.lumnex.ru`.

**Updates.** Send a new archive as in step 1 and run `docker compose -p perepev up -d --build --wait --wait-timeout 180` again. Files deleted from the repository stay in `~/apps/perepev` until removed by hand. nginx and the certificate need no changes, unless `deploy/nginx/perepev.lumnex.ru.conf` itself changed: then re-run `sudo bash deploy/nginx/install-site.sh` once (see below). Back up the database first (`bash deploy/backup.sh`). Caddy serves pages with `Cache-Control: no-cache`, so browsers revalidate pages after an update and do not request deleted build files.

**Access log off (template change of 2026-10-17): the owner must re-run `sudo bash deploy/nginx/install-site.sh` once.** The template now has `access_log off;` in the HTTPS (443) server too, not only in the port-80 one, so the host no longer writes client addresses of normal requests to its access log (the privacy page and the data export promise that an IP is kept at most one hour). The error log stays and records the client address only for failed requests. The script is idempotent: the certificate is left alone, the changed site file is replaced atomically, nginx reloads only after `nginx -t` passes, and on any error the previous site file is put back. A site installed before this change keeps logging HTTPS requests until the script is re-run. Check (the default log format has no host name, so use a marker): `curl -s -o /dev/null "https://perepev.lumnex.ru/?logcheck=$$"; sudo grep -c logcheck /var/log/nginx/access.log` prints 0 (adjust the path if the server logs elsewhere). The server's other sites keep their own logging.

**What nginx passes on.**
- `/api/ws`: WebSocket upgrade with a 1 h read timeout. The browser pings every 5 s, and the API itself closes a socket after about 20 s of silence.
- `/api/`: no buffering in either direction and a 90 s read timeout. The worker lease is a 25 s long poll; track uploads are up to 12 MB and worker files up to 20 MB.
- Bodies: `client_max_body_size 25m`. The API keeps its own smaller limits per route.
- HSTS and the other security headers come from Caddy.
- Logging: no access log for this site (both servers); the error log is the server's default.

**Client address for rate limits.**
- nginx overwrites `X-Forwarded-For` with `$remote_addr`, so a value sent by the client is dropped.
- Caddy trusts `X-Forwarded-For` only from private addresses. The published port reaches the container from the Docker gateway, which is one of them. Caddy then forwards exactly one address upstream (`header_up X-Forwarded-For {client_ip}`).
- The API (`TRUST_PROXY=true`) counts these per address: registrations, failed logins and password checks, friend requests, Yandex/VK sign-in starts, complaints, and precise-scoring performances.

Checked locally on 2026-10-16 behind `nginx:1.24.0`:
- A 13th registration from one client got 429, and spoofed `X-Forwarded-For` / `X-Real-IP` values did not change that.
- A second client still registered.
- With the previous Caddyfile, two clients shared one counter, the Docker gateway address.

A client on a private network (for example the server's own LAN) is counted as the Docker gateway, because Caddy skips trusted addresses when it reads the header.

**http://.** External port 80 does not reach this nginx, so `http://perepev.lumnex.ru` links do not redirect. After the first HTTPS visit, HSTS makes browsers use HTTPS.

**Removing the site.**

```sh
sudo rm /etc/nginx/sites-enabled/perepev.lumnex.ru.conf
sudo nginx -t && sudo systemctl reload nginx
```

## Общий HTTPS-сервер (Caddy сам на портах 80 и 443)

This is the alternative to the previous section, for a server where ports 80 and 443 are free and no other site runs. Два компьютера с отдельными localhost-установками не видят друг друга. Для совместной игры оба открывают один сервер. В комплекте есть `compose.server.yaml` и `deploy/server.env.example`.

1. Подготовь сервер с Docker и доменом, направленным на него; нужны входящие порты 80 и 443.
2. Скопируй `deploy/server.env.example` в `.env`, укажи домен и пароль базы.
3. Используй Docker Compose версии не ниже 2.24.4: серверный файл применяет `!override` для портов.
4. Выполни:

   ```sh
   docker compose -f compose.yaml -f compose.server.yaml up --build -d --wait --wait-timeout 180
   ```

Caddy настроен на получение HTTPS-сертификата; API ограничивает origin указанным доменом и использует Secure cookie. Выдача сертификата требует доступного домена и корректной сети. Конфигурация входит в комплект, но публичный HTTPS-сервер в этой работе не разворачивался. In this mode `compose.server.yaml` sets `CADDY_TRUSTED_PROXIES` to an empty value. Clients reach Caddy directly, so `X-Forwarded-For` is accepted from nobody and the limits use the connection address.

Перед публичным размещением прочитай разделы README о документах владельца и лицензиях. Настройки локальной демоверсии не заменяют настройку конкретного публичного сервиса.

## Разработка и проверки

Для обычного Docker-запуска инструменты разработчика на хосте не нужны. При разработке вне Docker следуй разделу README «Разработка без Docker»: версии берутся из `rust-toolchain.toml` и lock-файлов. `npm test` и `npm run build` вызывают сборку WASM и поэтому требуют Rust, если запускаются на хосте.

При Docker-сборке автоматически запускаются тесты scoring-core и Vitest. Полный Playwright-прогон отдельно требует браузеры Chromium и WebKit (`npx playwright install chromium webkit`) и работающий изолированный экземпляр API. Тесты могут регистрировать аккаунты и создавать матчи, поэтому их не запускают на базе с личными данными.

## Повторная подготовка музыки

Для игры используются готовые файлы в `web/static/songs`, и ничего скачивать с сайтов авторов при запуске не требуется. `tools/songs/import_vocals.py` служит для повторной подготовки каталога; ему дополнительно нужны исходные записи, отделённые вокальные дорожки и расшифровки, описанные в README. Эти большие рабочие кеши не включены в ZIP. Права, источники и параметры подготовки сохранены в манифесте и CREDITS.json.

## GPU-воркер

Установка на Windows-ПК с NVIDIA — `deploy/gpu-worker/setup.ps1`, инструкция для команды — [deploy/gpu-worker/README.md](deploy/gpu-worker/README.md). Проверка скрипта без Windows: `pwsh deploy/gpu-worker/setup.Tests.ps1` (только `-DryRun`).

The installer was run for real on the team's PC on 2026-10-16 (Windows 10 19045, RTX 3070 Ti 8 GB, driver 610.74): first run, 946 s, no fixes needed. That install first pointed at a local test API.

- **Pointing the worker at a server.** The server's `.env` must hold the SHA-256 of the installed token in `WORKER_TOKEN_SHA256`. Then either edit `"server"` in `C:\Perepev\worker.json` and restart the task (`Stop-ScheduledTask PerepevWorker; Start-ScheduledTask PerepevWorker` in an admin PowerShell), or re-run `setup.ps1 -ServerUrl https://…` with a new token and put the new hash into the server's `.env`.
- **Check.** `GET /api/health` shows `"worker": true` within 30 s.
- **Removal.** `setup.ps1 -Uninstall` removes the task and `C:\Perepev`.
- **Operating notes.** Keep other GPU work off the PC during a demo (VRAM use is 6.1-6.8 of 8 GB; on 2026-10-16 the worker process held 6.06 GB and the desktop about 0.7 GB, leaving about 1.4 GB). Once `htdemucs` is in the model cache, the worker starts with `HF_HUB_OFFLINE=1` and does not contact huggingface.co (`perepev_worker/runtime.py`); set `HF_HUB_OFFLINE=0` to let it check the hub for updates again. An explicit `HF_HUB_OFFLINE=1` on an empty model cache makes the first install fail by design: the models cannot be downloaded, so leave the variable unset for the first `setup.ps1` run or `--warmup`. Code installed before this change asks the hub at every start and falls back to the cache when the hub is unreachable (checked on the PC on 2026-10-16: loading htdemucs took 3.3 s online, 6.9 s with the connection refused, 22.8 s with packets dropped, 2.8 s with `HF_HUB_OFFLINE=1`).

Команды из папки `gpu-worker` (нужен [uv](https://docs.astral.sh/uv/)); на Mac и ПК без NVIDIA используется extra `cpu`:

```sh
uv sync --extra cpu
uv run --extra cpu pytest -m "not models"     # быстрые тесты без моделей
uv run --extra cpu pytest                     # вместе с моделями; при первом запуске скачивает около 550 МБ
uv run --extra cpu python -m perepev_worker.catalog stems ../web/static/songs --ids cn-earth   # стемы песни
PEREPEV_SERVER=https://… PEREPEV_WORKER_TOKEN=… uv run --extra cpu python -m perepev_worker.main
```

Модели кешируются в `PEREPEV_MODELS_DIR` (по умолчанию `~/.cache/perepev-worker`). Сервер принимает воркер, если SHA-256 его токена совпадает с `WORKER_TOKEN_SHA256`. На Mac с 16 ГБ памяти тяжёлые команды запускай по одной и стемы — по одной песне на процесс: разделение занимает около 1,9 ГБ, самопроверка — до 4,4 ГБ.
