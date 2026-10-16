# Перепев — описание проекта

Актуальное состояние: 17 октября 2026 года.

## Идея

Перепев — браузерная караоке-игра для одиночной практики и соревнования двух певцов. Игрок выбирает короткую песню, проверяет микрофон и поёт. Приложение сравнивает мелодию и ритм с эталоном, показывает результат и предлагает потренировать трудные места.

Основной замысел — оценивать относительную точность мелодии с учётом удобной человеку тональности. Низкий и высокий голос могут исполнять одну песню в разных регистрах. Алгоритм учитывает общий сдвиг по высоте и задержку, затем оценивает интервалы, ритм, устойчивость и покрытие. При точной оценке (согласие на запись голоса и работающий компьютер команды) сервер ещё и проверяет слова: распознанный текст сопоставляется со словами песни, и половина оси «Ритм и слова» — доля спетых вовремя слов; без этого балл считает браузер по кривой высоты с пометкой «слова не проверены». Это игровая оценка, а не профессиональная экспертиза вокала.

## Возможности

| Раздел | Что доступно |
| --- | --- |
| Песни | 32 фрагмента с настоящим вокалом: 14 русских и 18 английских; поиск, языковые фильтры, прослушивание. 24 — авторские песни под Creative Commons, 8 — известные народные и старинные песни в общественном достоянии в свободных записях. Age label (0+ or 6+) on every card; songs without an explicit label show 0+. |
| Одиночное пение | Проверка микрофона, график высоты голоса, слова, результат, разбор проблемных моментов и тренировка отрезка. |
| Precise scoring | Sound modes «В наушниках» (instrumental plus a quiet guide vocal) and «Без наушников» (instrumental only, echo cancellation on), chosen on the mic check and remembered. With a one-tap voice consent (guests too), the voice is uploaded while singing; the team's GPU PC extracts the melody and the sung words, and the server computes the final score. The browser score is shown as «предварительно», then replaced by the final score, or kept with «слова не проверены» when the team PC is unavailable or does not answer within 25 s. Speaker bleed of the guide vocal caps the score at 30 with a headphones hint. Three Russian public-domain songs («Ямщик, не гони лошадей», «Ой, то не вечер», «Дорогой длинною») get the server's melody-only score with «слова не проверены»: Whisper finds no words in their recordings, so their words are not checked (`"wordsCheck": false` in `index.json`). |
| Прослушивание результата | Сравнение с синтезированным ориентиром; экспериментальная коррекция собственного голоса в пределах текущей попытки. |
| Мои треки | Signed-in users upload their own song (≤ 30 MB). The section to sing (15-60 s) is chosen on a waveform, and only that section is uploaded. The team PC separates the voice and extracts melody and words; the track stays private and is deleted after 24 hours. |
| Дуэли | Рейтинговый подбор, живая комната по ссылке, асинхронный вызов-призрак. |
| Кабинет | Регистрация по почте и паролю или вход через Яндекс ID и VK ID (кнопки видны, когда сервер настроен); вопрос о возрасте и согласие родителя для детей младше 14 лет; имя в игре, смена пароля (только у кабинета с почтой), выгрузка и удаление данных (без пароля — подтверждение словом «УДАЛИТЬ»). |
| Друзья | Личный код, заявки с подтверждением, приватный список и удаление связи. |
| Мой прогресс | Сохранённые исполнения, счётчики, достижения и состояние рейтинговой калибровки. |
| Главная | Музыкальная комната со шкафчиками и магнитофоном, который выбирает последнюю доступную спетую песню. |
| Документы | Пользовательское соглашение, политика, согласие, cookie, музыка и «Контакты» с заглушкой оператора («Команда mugsize») и формой обращения к оператору (вопросы о данных, отзыв согласия, жалобы правообладателей); знак 6+ в подвале и возрастная метка на каждой песне. |
| Screens | Phones in portrait and landscape, tablets, laptops and wide monitors; touch targets of at least 44 px on touch screens; the screen stays awake while singing where the browser supports Screen Wake Lock. A Russian error page («Такой страницы нет» for 404, «Что-то пошло не так» with a retry for other errors). |

Гость может петь без регистрации; его история привязана к текущему браузеру. Для живых матчей и серверной истории нужен аккаунт. Одиночные попытки не изменяют рейтинговую калибровку; для неё используются рейтинговые дуэли. Guests also get precise scoring after the voice consent; own tracks need an account.

## Пользовательский путь

1. Открыть «Песни», найти композицию и послушать фрагмент.
2. Нажать «Петь», разрешить микрофон и проверить входной сигнал.
3. Спеть фрагмент, ориентируясь на слова и график.
4. Получить общий балл и четыре показателя качества.
5. Открыть трудный момент, потренировать его или создать вызов.

Since the 2026-10-16 upgrade, step 2 also offers the sound mode and, once per consent version, the voice consent (declining keeps the browser score only). In step 4 the score first shows as «предварительно» and is usually replaced by the server's final score within a few seconds; the fourth axis becomes «Ритм и слова» when the words were checked. A signed-in user can instead upload an own song under «Мои треки» on the songs page: choose a 15-60 s section on the waveform, wait for «Готово — петь» (about 6 s of GPU work for a 30 s section on the team PC, longer when jobs queue), then sing it like a catalog song for 24 hours.

Для живой дуэли два пользователя входят на один сервер. Один создаёт комнату и передаёт ссылку, второй присоединяется. После готовности обоих сервер запускает общий отсчёт и самостоятельно пересчитывает итог по полученным кривым высоты.

## Музыка и оформление

В каталоге короткие фрагменты примерно по 14–40 секунд, суммарно 760,19 секунды. Файлы содержат авторский вокал вместе с сопровождением. Это не полноразмерные песни; авторских минусовок нет, но для каждой песни из записи машинно отделены минус и вокал-подсказка (`instrumental.mp3`, `guide.mp3`, модель Demucs). Для игры рекомендуются наушники, чтобы воспроизводимый вокал не попадал в микрофон; без наушников нужен режим «Без наушников», в котором звучит только минус.

Использованы записи Josh Woodward, Complex Numbers и Viktor Argonov Project. The 8 public-domain songs use free recordings: the US Air Force Reserve Band (US federal work), Dcoetzee (CC0), Tom Evans (CC BY-SA 3.0), Лена Селянина (CC BY 3.0), Krystyna K and Елена Жданова (CC BY-SA 3.0, Jamendo). Для каждого фрагмента сохранены источник, авторство, версия лицензии, описание изменений и SHA-256. Сведения доступны в `CREDITS.json` и на странице `/legal/music`. Подробности — [LICENSES.md](LICENSES.md) и [docs/vocal-catalog.md](docs/vocal-catalog.md).

Оформление построено вокруг ночной музыкальной комнаты: бумажные карточки, шкафчики, кассеты и кот. Исходные материалы предоставлены владельцем проекта; происхождение обработанных и созданных изображений описано в `web/static/art/ASSET_SOURCES.txt`.

## Границы текущей версии

- Времена отдельных слов и вокальные эталоны требуют дальнейшей слуховой редактуры. Автоматические тесты не доказывают точность оценки реального певца.
- Пословная подсветка есть в одиночном караоке; тренировка и живая дуэль используют строки.
- Запись голоса не сохраняется в аккаунте. Магнитофон на главной играет исходную фонограмму последней песни, а не прежнее исполнение пользователя.
- В друзьях нет чата, индикатора «онлайн» на всех страницах и автоматической доставки приглашения в комнату; передаётся ссылка.
- Локальные установки не объединяются автоматически. Deployment to perepev.lumnex.ru in progress at the time of writing; see OPERATIONS.md.
- Physical phones and tablets, Bluetooth microphones, real Safari and Firefox were not tested. Layouts for phones (portrait and landscape), tablets and wide monitors are checked by an automated 14-size matrix in Chromium and WebKit emulation (`web/tests/e2e/responsive.spec.ts`). Real acoustics and latency depend on the hardware.
- Precise scoring depends on one GPU PC that processes jobs one at a time (about 3.7 s each on production with the RTX 3070 Ti): about 5 singers finishing at once still get the final score within the 20 s deadline, later ones keep the browser score (the local-tunnel bench managed about 7). The words cap (40) and the bleed cap (30) were tuned only on synthetic and studio stand-ins, not on real singers on real phones. Recordings that lag more than 0.3 s (Bluetooth headphones) score badly, so wired headphones are advised.
- Yandex ID and VK ID sign-in was tested end to end only against a mock provider. With the real credentials only the start redirect was checked on a local stack; a full sign-in through the real services has not been completed yet.
- The licences of the four Jamendo recordings were confirmed through the Internet Archive mirror's License.txt; the check on jamendo.com itself is still pending.

Предыдущие этапы и принятые допущения сохранены в [ASSUMPTIONS.md](ASSUMPTIONS.md); некоторые его датированные разделы описывают промежуточные версии. Актуальная краткая картина дана в этом документе.
