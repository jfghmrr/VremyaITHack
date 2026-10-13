# Проверка локального веб-сайта в Docker

13 октября 2026. Docker Desktop, Linux ARM64 (Apple Silicon). Отдельный Google Chrome через Playwright; личные профили браузера не используются.

- `docker compose config --quiet` — конфигурация корректна.
- `docker compose up --build -d` — выполнен с загрузкой базовых образов и чистой установкой npm-зависимостей внутри образа.
- Во время сборки: `npm test` — 22/22, `npm run build` — успешно.
- Контейнер `perepev-website-1` работает, healthcheck — healthy.
- `docker compose exec -T website nginx -t` — конфигурация Nginx корректна.
- `/healthz` отвечает 200, AudioWorklet отдаётся с `application/javascript`, минусовка с `audio/mpeg`; запрос диапазона MP3 отвечает 206.
- Обычный сервер разработки на 127.0.0.1:5173 также отвечает 200.
- `npm run format:check` — успешно.

## Браузерный сценарий

Оба сценария завершились успешно. Основной — 66 состояний на 1366×768, 1920×1080, 800 px и дополнительных узких экранах: регистрация, выбор микрофона, запись, A/B, репетиция, копирование вызова и дуэль во второй вкладке. Ошибок JavaScript и console.error не зарегистрировано. Дополнительный сценарий проверил геометрию карточек, фокус, DPR 2/reduced-motion, недоступное хранилище и тихий микрофон.

Протоколы: `docs/qa/docker/checks.json` и `edges.json`. Выбранные снимки лежат рядом; полный набор воспроизводится командами ниже.

Для повторения (нужны локальные npm-зависимости для Playwright и установленный Chrome):

```sh
ECHO_BASE_URL=http://localhost:8080/ ECHO_QA_OUTPUT=docs/qa/docker node docs/qa/perepev/check.mjs
ECHO_BASE_URL=http://localhost:8080/ ECHO_QA_OUTPUT=docs/qa/docker node docs/qa/perepev/edges.mjs
```

Эти команды — для разработчика на macOS/Linux. Для обычного запуска сайта получателю достаточно Docker Compose, Node.js не требуется.

Проверка использует синтетический микрофон через настоящий AudioWorklet. Физическое оборудование, субъективное качество звука, Windows/Linux-хосты и сборка на AMD64 в этом прогоне отдельно не проверялись. Сайт не опубликован в интернете.
