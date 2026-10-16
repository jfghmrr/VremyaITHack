"""Каталог песен, свободных от авторских прав.

Мелодии — в общественном достоянии: народные или написанные авторами, умершими более
70 лет назад (Россия: ст. 1281 ГК РФ). Исходные MIDI — работы Peter Gerloff (Rabanus
Flavus) на Wikimedia Commons, опубликованные под CC0; лицензия каждого файла
проверяется при загрузке (fetch_sources.py). Тексты песен не используются: поём на «ла».

`melody` — дорожки MIDI с мелодией и их сдвиг в полутонах (дорожки найдены по началу
мелодии, см. peek.py); остальные голоса становятся минусовкой. `skip_s` — с какой секунды
начинать, `max_s` — предел длины фрагмента (обрезка на конце ноты).
"""

SONGS = [
    # Русские
    {"id": "volga", "title": "Эй, ухнем!", "artist": "Русская народная · запись М. Балакирева, 1866", "tag": "Русская", "category": "Русские",
     "source": "File:Ej, uchnem!.mid", "max_s": 34, "melody": [(1, 0), (2, -12)]},
    {"id": "troika", "title": "Вот мчится тройка", "artist": "Русская народная мелодия", "tag": "Русская", "category": "Русские",
     "source": "File:Seht ihr drei Rosse (Troika).mid", "max_s": 15, "melody": [(1, 0)]},
    {"id": "korobeiniki", "title": "Коробейники", "artist": "Русская народная · стихи Н. Некрасова, 1861", "tag": "Та самая мелодия", "category": "Русские",
     "source": None, "max_s": 40},
    # Мировая классика
    {"id": "silent-night", "title": "Тихая ночь", "artist": "Франц Грубер · 1818", "tag": "Спокойная", "category": "Праздничные",
     "source": "File:Stille Nacht, heilige Nacht.mid", "max_s": 34, "melody": [(3, 12)], "skip_s": 36.0},
    {"id": "jingle-bells", "title": "Бубенцы (Jingle Bells)", "artist": "Джеймс Пирпонт · 1857", "tag": "Бодрая", "category": "Праздничные",
     "source": "File:Jingle Bells.mid", "max_s": 30, "melody": [(1, 0)]},
    {"id": "tannenbaum", "title": "О, ёлочка (O Tannenbaum)", "artist": "Немецкая народная мелодия", "tag": "Праздничная", "category": "Праздничные",
     "source": "File:O Tannenbaum.mid", "max_s": 34, "melody": [(1, 0)]},
    {"id": "auld-lang-syne", "title": "Старая дружба (Auld Lang Syne)", "artist": "Шотландская народная мелодия", "tag": "Праздничная", "category": "Праздничные",
     "source": None, "max_s": 40},
    {"id": "happy-birthday", "title": "С днём рождения", "artist": "Милдред и Патти Хилл · 1893", "tag": "Короткая", "category": "Праздничные",
     "source": "File:Happy birthday to you (Zum Geburtstag viel Glück).mid", "max_s": 15, "melody": [(1, 0)]},
    {"id": "frere-jacques", "title": "Братец Яков (Frère Jacques)", "artist": "Французская народная · XVIII век", "tag": "Для разогрева", "category": "Детские",
     "source": "File:Frère Jacques (pg).mid", "max_s": 30, "melody": [(1, 0)]},
    {"id": "alouette", "title": "Алуэтт (Alouette)", "artist": "Франко-канадская народная песня", "tag": "Детская", "category": "Детские",
     "source": "File:Alouette.mid", "max_s": 30, "melody": [(1, 0)]},
    {"id": "lullaby", "title": "Колыбельная", "artist": "Иоганнес Брамс · 1868", "tag": "Нежная", "category": "Классика",
     "source": "File:Guten Abend, gut Nacht (Wiegenlied).mid", "max_s": 34, "melody": [(1, 0)]},
    {"id": "ode-joy-full", "title": "Ода к радости (хор)", "artist": "Людвиг ван Бетховен · 1824", "tag": "Полная тема", "category": "Классика",
     "source": "File:Freude, schöner Götterfunken.mid", "max_s": 32, "melody": [(1, 0)]},
    {"id": "santa-lucia", "title": "Санта Лючия", "artist": "Теодоро Коттрау · 1849", "tag": "Итальянская", "category": "Классика",
     "source": "File:Santa Lucia.mid", "max_s": 36, "melody": [(3, 0)]},
    {"id": "funiculi", "title": "Фуникули-фуникула", "artist": "Луиджи Денца · 1880", "tag": "Итальянская", "category": "Классика",
     "source": "File:Funiculì funiculà.mid", "max_s": 34, "melody": [(2, 0)]},
    {"id": "scarborough", "title": "Ярмарка в Скарборо", "artist": "Английская народная баллада", "tag": "Баллада", "category": "Мировые",
     "source": "File:Scarborough Fair (ballad).mid", "max_s": 29, "melody": [(1, 0)]},
    {"id": "danny-boy", "title": "Лондондеррийский напев (Danny Boy)", "artist": "Ирландская народная мелодия", "tag": "Протяжная", "category": "Мировые",
     "source": "File:The Londonderry Air.mid", "max_s": 36, "melody": [(1, 0)]},
    {"id": "amazing-grace", "title": "О, благодать (Amazing Grace)", "artist": "Американская мелодия · 1829", "tag": "Протяжная", "category": "Мировые",
     "source": "File:Amazing grace (org).mid", "max_s": 34, "melody": [(1, 0)]},
    {"id": "my-bonnie", "title": "Мой Бонни (My Bonnie)", "artist": "Шотландская народная песня", "tag": "Вальс", "category": "Мировые",
     "source": "File:My Bonnie is over the Ocean.mid", "max_s": 34, "melody": [(1, 0)]},
    {"id": "clementine", "title": "Клементина", "artist": "Американская народная песня · 1884", "tag": "Вальс", "category": "Мировые",
     "source": "File:O My Darling Clementine.mid", "max_s": 27, "melody": [(1, 0), (3, 0)]},
    {"id": "saints", "title": "Когда святые маршируют", "artist": "Американская народная песня", "tag": "Джаз", "category": "Мировые",
     "source": "File:When The Saints.mid", "max_s": 30, "melody": [(1, 0)]},
    {"id": "cucaracha", "title": "Кукарача", "artist": "Мексиканская народная песня", "tag": "Бодрая", "category": "Мировые",
     "source": "File:La Cucaracha (pg).mid", "max_s": 30, "melody": [(1, 0)]},
]

# «Коробейники»: общеизвестная мелодия (та же тема звучит в «Тетрисе»), записана вручную.
# (MIDI-высота, длительность в четвертях); гармония — аккорд на каждый такт 4/4.
KOROBEINIKI = {
    "tempo": 132,
    "melody": [
        (76, 1), (71, .5), (72, .5), (74, 1), (72, .5), (71, .5),
        (69, 1), (69, .5), (72, .5), (76, 1), (74, .5), (72, .5),
        (71, 1.5), (72, .5), (74, 1), (76, 1),
        (72, 1), (69, 1), (69, 2),
        (None, .5), (74, 1), (77, .5), (81, 1), (79, .5), (77, .5),
        (76, 1.5), (72, .5), (76, 1), (74, .5), (72, .5),
        (71, 1), (71, .5), (72, .5), (74, 1), (76, 1),
        (72, 1), (69, 1), (69, 2),
    ],
    "chords": ["Am", "Am", "E", "Am", "Dm", "Am", "E", "Am"],
    "repeat": 2,
}

# «Auld Lang Syne»: народная мелодия; записана вручную по нотному примеру статьи
# англоязычной Википедии (фа мажор, затакт четверть).
AULD_LANG_SYNE = {
    "tempo": 88,
    "pickup": 1,
    "melody": [
        (60, 1),
        (65, 1.5), (65, .5), (65, 1), (69, 1), (67, 1.5), (65, .5), (67, 1), (69, 1),
        (65, 1.5), (65, .5), (69, 1), (72, 1), (74, 3), (74, 1),
        (72, 1.5), (69, .5), (69, 1), (65, 1), (67, 1.5), (65, .5), (67, 1), (69, 1),
        (65, 1.5), (62, .5), (62, 1), (60, 1), (65, 3), (74, 1),
        (72, 1.5), (69, .5), (69, 1), (65, 1), (67, 1.5), (65, .5), (67, 1), (74, 1),
        (72, 1.5), (69, .5), (69, 1), (72, 1), (74, 3), (74, 1),
        (72, 1.5), (69, .5), (69, 1), (65, 1), (67, 1.5), (65, .5), (67, 1), (69, 1),
        (65, 1.5), (62, .5), (62, 1), (60, 1), (65, 3),
    ],
    "chords": ["F", "C", "F", "Bb", "F", "C", "Bb", "F", "F", "C", "F", "Bb", "F", "C", "Bb", "F"],
    "repeat": 1,
}

MANUAL = {"korobeiniki": KOROBEINIKI, "auld-lang-syne": AULD_LANG_SYNE}
