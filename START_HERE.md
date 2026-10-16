# Перепев - запуск из архива

> **Repository state (2026-10-16, branch `hackathon-upgrade`).** This file was written for the portable archive the repository was imported from. The hackathon upgrade has since added precise scoring with word checking on the team's GPU PC, own-track upload, Yandex ID / VK ID sign-in, the legal pages, phone and tablet layouts, a Russian error page and 8 public-domain songs (32 in total). The Docker start-up below is unchanged. Precise scoring and own tracks also need the GPU worker (`WORKER_TOKEN_SHA256`, see [OPERATIONS.md](OPERATIONS.md)); without it the browser score is used. Current overview: [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md); change history: [WORK_DONE.md](WORK_DONE.md).

Комплект от 16 октября 2026 года. Базовая версия приложения: `041344f`; проверка комплекта описана в [docs/portable-verification.md](docs/portable-verification.md).
В репозитории актуальный дизайн, каталог из 32 фрагментов с настоящим вокалом (14 русских и 18 английских), одиночное пение, дуэли и кабинет.
Внутренние имена приложения и контейнеров (`perepev`, «Перепев») сохранены.

## Что нужно

- Запущенный [Docker Desktop](https://docs.docker.com/get-started/get-docker/) на Windows/macOS или Docker Engine с плагином Docker Compose на Linux.
- Docker Compose 2.24.4 или новее, включая Compose 5. Версию можно посмотреть командой `docker compose version`.
- Интернет для первой сборки: Docker скачает образы, Rust и npm-зависимости. Песни и шрифты уже в архиве.
- Node.js, Rust, Python, PostgreSQL и Valkey на компьютер отдельно устанавливать не нужно.

На Windows используй Docker Desktop в режиме Linux-контейнеров. Команды запуска подходят и для PowerShell. Это комплект исходников: он требует интернета для первой сборки, а не набор готовых образов для автономной установки. Практический запас для сборки — около 8 ГБ RAM для Docker и 15 ГБ свободного диска; это рекомендация, а не измеренный минимальный порог.

Сборка проверена на Linux ARM64 внутри Docker Desktop. В конфигурации нет привязки к архитектуре: Docker выбирает базовые образы и собирает бинарники под текущую платформу. На отдельном Windows/Linux x86-64 компьютере запуск не проверялся.

## Первый запуск

1. Полностью распакуй ZIP.
2. Открой терминал в папке `Perepev`, где лежат `compose.yaml` и `Dockerfile`. Например, из папки, в которую распакован архив:

   ```sh
   cd Perepev
   ```

3. Выполни:

   ```sh
   docker compose up --build -d --wait --wait-timeout 180
   ```

   Первый запуск собирает API, WASM и сайт, затем создаёт базы и применяет миграции. Дождись завершения команды. Файл `.env` для обычного локального запуска не нужен.

4. Открой **http://localhost:8080** в Chrome или Edge. Разреши доступ к микрофону и используй наушники. Для кабинета создай новый аккаунт через сайт.

Быстрая проверка: **http://localhost:8080/api/health** должен вернуть JSON с `"ok": true`, `"db": true` и `"valkey": true`.

## Остановка и повторный запуск

```sh
docker compose down
docker compose up -d --wait --wait-timeout 180
```

Аккаунты, история и прочие данные сохраняются в Docker volumes. **Не добавляй `-v` к `docker compose down` для обычной остановки: этот флаг удаляет данные.**

## Если не запускается

```sh
docker compose ps -a
docker compose logs --tail=100
```

- Ошибка подключения к Docker: запусти Docker Desktop или Docker Engine.
- Ошибка скачивания: проверь интернет и доступ Docker к реестрам образов и зависимостей, затем повтори команду запуска.
- Не хватило памяти или места: увеличь ресурсы Docker и повтори сборку.
- Порт 8080 занят: создай рядом с `compose.yaml` файл `.env` с таким содержимым и повтори команду запуска:

  ```dotenv
  PEREPEV_PORT=8081
  APP_ORIGINS=http://localhost:8081,http://127.0.0.1:8081
  ```

  После этого открывай **http://localhost:8081**.

## Игра с другого компьютера

Локальная конфигурация открывает сайт только на компьютере, где запущен Docker. Для совместной игры оба человека должны зайти на один общий сервер с HTTPS. Инструкция и готовая конфигурация `compose.server.yaml` находятся в разделе «Общий сервер» файла [README.md](README.md).

## Состав архива

Сохранены исходники, Dockerfile и оба Compose-файла, миграции, lock-файлы, 32 вокальных фрагмента с аудио, словами, эталонами и сведениями о лицензиях, графика, шрифты, лицензии, тесты, инструменты разработки, скриншоты проверок и презентация.

Исключены Git-история, `node_modules`, Rust `target`, готовые сборки и сгенерированный WASM, виртуальные окружения Python, кеши, отчёты тестов, резервные копии, реальные базы и локальные настройки с секретами.

`fixtures/legacy/perepev.sqlite` - специально созданная тестовая база для проверки миграции с двумя вымышленными пользователями. Это часть тестов; она не загружается в рабочую базу при запуске.

При запуске на новом компьютере создаётся пустая база. Пользовательские аккаунты и история из исходной установки не входят в архив.

Git-теги и исходная история разработки в архив не включены. Для сборки и запуска они не нужны. Старые музыкальные файлы оставлены для совместимости; в активном индексе только 32 вокальные песни. Кеши исходных записей и модели, нужные для повторной подготовки музыки, в архив не входят: для игры достаточно готовых файлов.

В корне ZIP-комплекта находился `MANIFEST.sha256` с контрольными суммами файлов; рядом с ZIP — контрольная сумма самого архива. In this repository the manifest was intentionally not imported: it lists the archive's files, not the current tree. Пример необязательных настроек локального запуска: [.env.example](.env.example).

## Документация комплекта

| Файл | Что описывает |
| --- | --- |
| [PROJECT_OVERVIEW.md](PROJECT_OVERVIEW.md) | Суть проекта, функции и ограничения. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Компоненты, аудио, оценка, данные и сборка. |
| [WORK_DONE.md](WORK_DONE.md) | Проделанная работа и результаты проверок. |
| [OPERATIONS.md](OPERATIONS.md) | Настройки, обновление, резервные копии и общий сервер. |
| [docs/portable-verification.md](docs/portable-verification.md) | Проверка именно этого переносимого комплекта. |
| [README.md](README.md) | Подробная документация разработчика. |
| [LICENSES.md](LICENSES.md) | Музыка, графика и права на материалы. |
| [ASSUMPTIONS.md](ASSUMPTIONS.md) | Decisions, business rules and limits in force, including the dated «Hackathon upgrade — 16.10.2026» section. |
| [docs/vocal-catalog.md](docs/vocal-catalog.md) | Catalog audit: sources, licences, lyric screening and the public-domain songs. |
| [docs/oauth-setup.md](docs/oauth-setup.md) | Registering the Yandex ID and VK ID apps and the `.env` values. |
| [deploy/gpu-worker/README.md](deploy/gpu-worker/README.md) | Installing the GPU worker on the team's Windows PC (`setup.ps1`). |
| [gpu-worker/bench/RESULTS.md](gpu-worker/bench/RESULTS.md) | Precise-scoring benchmark on the real GPU PC, with its caveats. |
| [docs/superpowers/specs/2026-10-16-hackathon-upgrade-design.md](docs/superpowers/specs/2026-10-16-hackathon-upgrade-design.md) | Hackathon upgrade design (§6a overrides the rest). |
| [docs/superpowers/plans/2026-10-16-hackathon-upgrade.md](docs/superpowers/plans/2026-10-16-hackathon-upgrade.md) | Hackathon upgrade plan with the worker, client and OAuth contracts (C1-C4). |

Минимальная версия Compose для серверного файла связана с [поддержкой `!override`](https://docs.docker.com/reference/compose-file/merge/#replace-value).

