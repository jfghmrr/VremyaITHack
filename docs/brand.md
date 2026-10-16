# Перепев: музыкальная комната

Название закреплено владельцем: **Перепев**; латинское имя в файлах и настройках — `perepev`. Бренд не переименовывается автоматически. Проверка товарных знаков и доменов в рамках редизайна не проводилась.

## Материалы и композиция

Источник композиции — предоставленный коллаж из девяти экранов. Источник предметов — `perepev-design-kit 2`; шкафчики и курсор сверены с `perepev-locker.html`. Список и происхождение ассетов — `web/static/art/ASSET_SOURCES.txt`.

- Главная: бумажное название сверху, слоган под ним, кот слева в кресле, магнитофон в центре, основное действие внизу. Справа два открывающихся шкафчика с переходами в дуэли и кабинет.
- Песни: заголовок, фильтры и поиск, ряд полароидов, кассета и выбор под ним. Обложки отражают существующий каталог, без подмены его песнями из макета.
- Микрофон: кот слева, индикатор справа сверху, проверки и выбор входа под ним, действие справа внизу.
- Пение: тетрадь со строками слева, поющий кот справа сверху, график и кнопки плеера справа снизу.
- Результат: звезда с настоящим баллом слева, кот в центре, оценки справа, повтор и ссылка снизу. A/B и кнопка разбора остаются в нижней панели.
- Дуэль: две карточки участников и VS между ними; сравнение по осям открывается на месте результата.
- Лидеры: тетрадный список слева и предметы справа. Отображаются только данные сервера.
- Мой прогресс: разворот тетради с графиком и достижениями. История и настройки доступны соседней кнопкой, без второй страницы под основным экраном.
- Пустое состояние: записка с действием и спящий кот.

Фон менее контрастный, чем бумага и элементы управления. Крупные блоки выровнены; небольшие наклоны сохранены у наклеек и карточек. Ширина контента ограничена 1440 px (1680 px на xwide). Вне раскладки wide абсолютная композиция переходит в последовательные блоки.

## Layouts (2026-10-16)

Browsers do not support `@custom-media` yet, so pages write these queries literally; the names are a shared vocabulary for styles, tests and this document (see the comment in `web/src/lib/styles/tokens.css`).

| Name | Query | Behaviour |
| --- | --- | --- |
| compact | `(max-width: 599px)` | Phone portrait: one column, compact wrapping nav tabs, icons in a column. |
| short | `(max-height: 520px) and (orientation: landscape)` | Phone landscape: flow or two-column layouts; on the sing stage lyrics take the left 55 %, the pitch canvas and player keys the right; the cat and decorations are hidden. |
| medium | `(min-width: 600px) and (max-width: 1099px) and (min-height: 521px)` | Tablets and narrow windows: flowing scenes; the sing stage uses two columns in landscape. |
| wide | `(min-width: 1100px) and (min-height: 521px)` | Laptops and monitors: the absolute "scene" compositions from the mockups. |
| xwide | `(min-width: 2200px), (min-aspect-ratio: 21/9)` | Container up to 1680 px; the root font size grows with `clamp()` (16 px up to 21 px). |

- "Not wide" (`not all and (min-width: 1100px) and (min-height: 521px)`) replaces the old `max-width: 900px` scene collapse: `.scene` flows in a column and `.deco` is hidden.
- Touch targets: under `(pointer: coarse)` or "not wide", every interactive control is at least 44 px (`--tap`). Desktop mouse layouts keep the 40 px controls of the mockups. Styled `<select>` elements get an explicit `height`, because WebKit ignores `min-height` on them.
- Safe areas: `viewport-fit=cover` plus `--safe-top/right/bottom/left` (`env(safe-area-inset-*)`) pad the header, footer, sing stage player and cookie banner.
- Sing stage in portrait: lyrics, then the legend and pitch canvas, then the player keys pinned at the bottom above the home indicator. Rotation is a pure re-layout: the AudioContext and the recording continue.
- While singing, `web/src/lib/ui/wakelock.ts` holds a Screen Wake Lock (feature-detected, re-requested when the tab becomes visible again, released on stop, finish or leave).
- Check: `web/tests/e2e/responsive.spec.ts` runs 14 sizes (phones 360×740, 390×844, 430×932, 844×390, 932×430; tablets 768×1024, 1024×768, 820×1180, 1180×820; desktops 1280×720, 1366×768, 1920×1080, 2560×1440, 3440×1440) in Chromium and WebKit. It asserts no horizontal scroll, no overlapping controls, nav tabs inside their container, 44 px targets on touch sizes and the sing stage keys inside the viewport, and saves screenshots to `web/test-results/matrix/`.

## Маскот и взаимодействие

Готовые позы чёрного кота в красных наушниках используются на основных экранах. Поза меняется по состоянию; при сигнале кот слегка двигается без тяжёлых SVG-фильтров. Растер не имеет отдельных слоёв рта и лап, поэтому полноценной артикуляции здесь нет.

Дверцы шкафчиков выполнены чёткими деталями HTML/CSS/SVG по HTML-референсу; повторное нажатие на ту же дверь закрывает её. Дверцы открываются на петлях, свет лампы и звезды переключается, магнитофон запускает мелодию, катушки кассет вращаются только при воспроизведении. Все действия — настоящие кнопки и ссылки, доступные через Tab. Скрытое содержимое шкафа исключено из Tab-порядка. Анимации учитывают `prefers-reduced-motion`.

## Цвет и текст

Бумага `#efe6d2`, чернила `#1f1c1a`, красный акцент `#a81d1d`, приглушённый фон `#171719`. Линия своего голоса — красная, соперника — синяя пунктирная, эталон — серый. Различия дублируются толщиной и штрихами.

Golos Text — обычный текст, Caveat — короткие подписи и заголовки, IBM Plex Mono — время и числа. Остальные локальные шрифты используются в обложках. Лицензии шрифтов лежат рядом с ними.

## Границы точности

Низкое разрешение некоторых исходных вырезок заметно при увеличении. Композиция адаптирована к широкому браузеру и настоящим данным; утверждение о пиксельном совпадении со статичным коллажем не делается. Для идеально резкого исполнения нужны исходники того же дизайна в большем разрешении.
