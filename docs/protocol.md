# Протокол HTTP и WebSocket, версия 1

Типы сообщений описаны в `crates/api/src/protocol.rs`. JSON-схемы лежат в `contracts/` (`perepev-api schemas contracts`), типы клиента генерируются из них в `web/src/lib/api/types.ts` (`node web/scripts/gen-types.mjs`). CI проверяет, что схемы и типы не устарели.

## HTTP

Все изменяющие запросы требуют заголовки `Origin` (из `APP_ORIGINS`), `X-Perepev-Request: 1` и `Content-Type: application/json`. Тело ограничено 16 КиБ. Ошибки имеют вид `{"error": "понятное сообщение"}`.

| Метод и путь | Что делает |
| --- | --- |
| `GET /api/health` | состояние PostgreSQL и Valkey, экземпляр, соединения, матчи |
| `GET /api/me` | `{profile, rating}` или `{profile: null}`; `profile` = `{id, email\|null, name, hasPassword, providers}` |
| `POST /api/register` | `{email, name, password, consent: true, ageGroup: "14plus"\|"under14", parentName}` → 201, cookie сессии; `parentName` (2-64 characters) is required for `under14` |
| `POST /api/login` | `{email, password}` → cookie сессии |
| `POST /api/logout` | удаляет сессию и закрывает её WebSocket на всех экземплярах |
| `PATCH /api/me` | `{name}` |
| `POST /api/password` | `{currentPassword, newPassword}`; отзывает все сессии и соединения пользователя. Without a password (Yandex ID / VK ID account): `{confirm: "УДАЛИТЬ", newPassword}` |
| `POST /api/me/delete` | `{password}`, or `{confirm: "УДАЛИТЬ"}` without a password; deletes the account and all its data |
| `GET /api/auth/providers` | `{providers: ["yandex", "vk"]}`: only providers whose credentials are configured |
| `GET /api/auth/{yandex,vk}/start?return=/path` | `302` to the provider with PKCE S256 and a 64-character state; temporary cookie `perepev_oauth` (`SameSite=Lax`, 10 min) |
| `GET /api/auth/{yandex,vk}/callback` | `302 {return}` with a session for a known account, `302 /account?signup={token}` for a new one, `302 /account?authError=state\|denied\|provider\|limit\|server` on failure |
| `POST /api/auth/complete` | `{token, consent: true, ageGroup, parentName}` → 201 `{profile}` and a session; nickname `Певец-NNNN` |
| `POST /api/complaints` | `{name, email, url, text}`, each ≤ 2000 characters, valid email → 201 `{id}`; at most 5 per IP per hour |
| `GET /api/attempts`, `POST /api/attempts` | приватная история одиночных попыток (до 100), повтор `id` идемпотентен |
| `GET /api/rating` | MMR для показа, калибровка, ранг, защита |
| `GET /api/catalog` | песни с версией эталона |
| `GET /api/matches`, `GET /api/matches/{id}` | история дуэлей; итог матча только для участника |

С одного адреса за 15 минут — не больше 12 регистраций и не больше 12 неудачных проверок пароля (вход, смена пароля, удаление кабинета). Успешный вход лимит не расходует. Счётчики общие для всех экземпляров. `POST /api/auth/complete` counts as a registration; provider sign-in starts are limited to 60 per IP per 15 minutes.

## WebSocket `/api/ws`

Подключение принимается только с разрешённым `Origin` и действующей cookie сессии. Сессия перепроверяется каждые 30 с, отзыв закрывает соединение сразу. Сообщения — JSON-текст до 16 КиБ, не больше 40 команд в секунду (всплеск 80).

### Клиент → сервер

Конверт: `{"v": 1, "id": <номер команды>, "type": ..., ...}`. Сервер отвечает `ack` с тем же `id`. После переподключения клиент повторяет неподтверждённые команды. Все команды идемпотентны.

| type | Поля | Смысл |
| --- | --- | --- |
| `hello` | `match_id?`, `last_seq?` | первое сообщение после подключения; сервер присылает состояние |
| `ping` | `c` (время клиента, мс) | heartbeat каждые 5 с и оценка смещения часов |
| `queue_join` / `queue_leave` | — | рейтинговая очередь; повторный вход не создаёт вторую заявку |
| `room_create` | `song_id` | комната для игры с другом |
| `room_join` | `code` | вход по коду комнаты |
| `accept` / `decline` | `match_id` | подтверждение участия в найденном матче |
| `ready` | `match_id`, `song_version`, `algorithm_version` | материалы загружены, микрофон и звук готовы |
| `perf` | `match_id`, `from`, `points[]` | точки канонической кривой: десятые доли полутона (0…1270) или `null` — пауза, до 100 точек |
| `finish` | `match_id`, `count` | кривая отправлена полностью |
| `leave` | `match_id` | выход: до старта — отмена, после — техническое поражение |
| `rematch` | `match_id` | новая дружеская комната после дружеского матча |

### Сервер → клиент

Конверт: `{"v": 1, "seq"?: n, "type": ...}`.

| type | Смысл | Доставка |
| --- | --- | --- |
| `welcome` | пользователь, время сервера, период heartbeat | при `hello` |
| `pong` | `c` и время сервера `s` | на каждый `ping` |
| `ack` | `id`, `ok`, `error?` | на каждую команду |
| `queue` | `{state: {status, pool, window, since_ms, match_id}}` | при изменении и с каждым heartbeat во время поиска |
| `match` | `{view}` — состояние матча целиком | **важное**: с `seq`, повторяется после переподключения |
| `opponent` | `from`, `points[]` — кривая соперника для анимации | промежуточное: может прийти позже или повторно |
| `room` | `match_id`, `code` | создана комната или предложен реванш |
| `error` | `message` | адресная ошибка |

### Последовательность, подтверждения, восстановление

- Владелец матча нумерует важные события `seq`. Клиент отбрасывает `seq`, который уже видел.
- Команды доставляются владельцу через поток Valkey `m:{id}:in`, события — через `m:{id}:out`. Поэтому игрок может быть подключён к любому экземпляру и переподключиться к другому.
- После переподключения шлюз отправляет снимок состояния матча, затем события потока с начала (до 4000 записей): все важные и все точки соперника. Итог матча после закрытия вкладки доступен и через `GET /api/matches/{id}`.
- Промежуточные `opponent` можно потерять или получить заново: клиент записывает точки по индексу. Итог `finished` не теряется — он хранится в PostgreSQL и повторяется при каждом подключении.
- Клиент переподключается с экспоненциальной задержкой 0,5–10 с со случайным разбросом ±50%. Неподтверждённые команды ждут в ограниченной очереди (600) и повторяются после подключения.
- Медленный клиент, чья исходящая очередь (512 сообщений) переполнилась, отключается. После переподключения он получает актуальное состояние.

## Хранение временных данных

| Ключ Valkey | Что | Срок |
| --- | --- | --- |
| `kv:q:t:{user}`, `kv:q:pool:{cal,main}`, `kv:q:reserved` | заявки, пулы, резервы пар | заявка 30 с с последнего heartbeat |
| `kv:p:{user}` | присутствие | 15 с |
| `kv:m:{id}:owner`, `:gen` | аренда владельца и поколение | 6 с / сутки |
| `kv:m:{id}:in`, `:out`, `:state`, `:curve:{slot}` | команды, события, снимок, кривые | 2 часа |
| `kv:u:{user}:out` | события пользователя (матч найден, реванш) | 1 час |
| `kv:sys:revoke` | отзыв сессий | 1 час |
