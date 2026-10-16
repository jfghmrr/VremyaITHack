# Catalog candidates: free recordings with vocals (research of 2026-10-16)

- **Purpose:** the input for plan task F2.
- **Status:** licences were read from the source pages during research. **Re-verify each one at download time** and record it in the song's `CREDITS.json`. Vocals marked "presumed" and clip positions must be confirmed by ear.

## F2 outcome (2026-10-16, evening)

Eight songs were added with `python -m perepev_worker.catalog import` (4 Russian, 4 English). Each passed the hard gates: composition and lyrics in the public domain in Russia, recording licence re-checked on the source page (PD, CC0, CC BY or CC BY-SA), foreign-agent register and extremist-materials list checked, lyrics screened for 0+/6+. Evidence, SHA-256 hashes and quality numbers are in each `web/static/songs/<id>/CREDITS.json`; the summary is in [vocal-catalog.md](vocal-catalog.md).

| Song | Id | Recording | Licence | Age | Outcome |
|---|---|---|---|---|---|
| Amazing Grace | `amazing-grace-usaf` | Southern Aire, USAF Reserve Band (2002) | PD-USGov | 0+ | added |
| Twinkle, Twinkle, Little Star | `twinkle-little-star` | Dcoetzee (2012), a cappella | CC0 1.0 | 0+ | added |
| My Bonnie Lies Over the Ocean | `bonnie-krystyna` | Krystyna K (2018); vocal confirmed in the separated stem. The id avoids the `my-` prefix, which the site and API reserve for own tracks | CC BY-SA 3.0 | 0+ | added |
| Danny Boy | `danny-boy-evans` | Tom Evans (Sain, 1994), 30-second excerpt | CC BY-SA 3.0 (VRTS) | 6+ | added |
| Ой, то не вечер | `oi-to-ne-vecher` | Лена Селянина (2009); first lines only | CC BY 3.0 | 6+ | added |
| Дорогой длинною | `dorogoi-dlinnoyu` | Елена Жданова (2013), chorus | CC BY-SA 3.0 | 6+ | added |
| Ямщик, не гони лошадей | `yamshchik-ne-goni` | Елена Жданова (2013), chorus | CC BY-SA 3.0 | 6+ | added |
| Гори, гори, моя звезда | `gori-gori-moya-zvezda` | Krystyna K (2016); sung in Russian (whisper is more confident in Russian than Polish) | CC BY-SA 3.0 | 6+ | added; long instrumental pauses inside lines, so only 33% of line time has a melody reference |

Not added:

| Candidate | Reason |
|---|---|
| Silent Night (LibriVox, CC0), Shenandoah (Singing Sergeants, PD), Yankee Doodle (US Army Chorus, PD) | Imported but not reviewed; not included. They are outside the 8 songs that F2 publishes. Their quality numbers passed (voiced in lines 0.92 / 0.86 / 0.65); they can be published after a credits review |
| Silent Night (US Army Chorus) | Imported, then removed by the first F2 run (no reason recorded). Its numbers: melody voiced in 33% of the lyric lines, a choir rather than a lead vocal; the LibriVox solo was imported instead |
| Joy to the World (US Army Chorus) | Imported, then removed by the first F2 run (no reason recorded). Its numbers: melody voiced in only 23% of the lyric lines (choir) |
| Jingle Bells, We Wish You a Merry Christmas (Starlifter, 2020) | No vocals: the separated vocal stem stays 16-60 dB below the instrumental in every 5-second window, and whisper finds no words in it. "Vocals presumed" was wrong |
| Silent Night (Singing Sergeants), Deck the Halls, Hark! The Herald Angels Sing, Отцвели хризантемы, Калинка (1910), Коробейники (1927), Очи чёрные (Chaliapin) | Downloaded and probed, not imported before the time box. Калинка has a clear vocal in the separated stem (median +16 dB over the instrumental) and is the best next candidate; its 78 rpm noise needs a listen |
| «Эй, ухнем» and «Les bateliers de la Volga» (Chaliapin, PD on Commons), Scarborough Fair (other recording) | Found during processing, probed only; not in the reviewed candidate list, so not imported |
| Auld Lang Syne, Battle Hymn of the Republic, Happy Birthday to You, Scarborough Fair (lunasspecto), MKHLSDRV songs | Not processed (time box) |
| Из-за острова на стрежень, Ой, мороз, мороз | Excluded in advance (content; disputed authorship) |

## Legal basis

- **US military band and chorus recordings** are US federal government works with no copyright (17 U.S.C. §105). Commons tags them `PD-USGov-Military-*`.
  - Russian law has no explicit rule for foreign government works: low risk, not tested.
  - The Air Force band site states a usage policy (broadcast, education, public service). That is a policy, not a copyright licence.
  - Prefer arrangements made by band members.
- **Old recordings under Russian law:**
  - The phonogram term is 50 years (Civil Code 1327).
  - The performer term is life, but at least 50 years, plus 4 for WWII participants (1318).
  - Under the Introductory Law 231-FZ art. 6, these apply only where the term was not expired on 1993-01-01. So performances and recordings from 1942 or earlier are public domain in Russia.
- **CC BY-SA:** clips and derived melodies must also be released under CC BY-SA. Every CC recording needs a credit on its song page.

## English

Sources:
- **C:** Wikimedia Commons. The file page is `https://commons.wikimedia.org/wiki/File:<name>`; the download is `https://commons.wikimedia.org/wiki/Special:FilePath/<name>`.
- **Jamendo** licences were verified through Internet Archive mirrors.

| Song | Composition: why it's public domain | Recording (source) | Licence | Notes | Verdict |
|---|---|---|---|---|---|
| Silent Night | Gruber 1863, Mohr 1848 | Singing Sergeants, USAF Band, 2006 (C: `Silent_Night_-_Singing_Sergeants_-_United_States_Air_Force_Band.mp3`) | PD-USGov | Choir + band, 197 s. Alternatives: US Army Chorus `Silent_Night_(choral).ogg` (PD); LibriVox `Silent_Night_Librivox_2009.ogg` (CC0, solo) | strong |
| Jingle Bells | Pierpont 1893; arrangement by USAF airmen | Starlifter & Roots in Blue, USAF Band of Mid-America, 2020 (C: `Jingle_Bells_(2020)_-_Starlifter_and_Roots_in_Blue_-_United_States_Air_Force_Band_of_Mid-America.mp3`) | PD-USGov | Vocals presumed | strong if vocals confirmed |
| We Wish You a Merry Christmas | Traditional | Same album (C: `We_Wish_You_a_Merry_Christmas_(2020)_-_Starlifter_and_Roots_in_Blue_-_United_States_Air_Force_Band_of_Mid-America.mp3`) | PD-USGov | Vocals presumed | ok |
| Deck the Halls | Traditional | A Cappella Singers, USAF Band of the Rockies, 1993 (C: `It_Came_Upon_a_Midnight_Clear,_Deck_the_Halls_-_A_Cappella_Singers_-_United_States_Air_Force_Band_of_the_Rockies.mp3`) | PD-USGov | 135 s, a cappella | ok |
| Amazing Grace | Newton 1807; traditional tune | Southern Aire, USAF Reserve Band, 2002 (C: `Amazing_Grace_(vocalist_with_guitar)_-_Southern_Aire_-_United_States_Air_Force_Reserve_Band.mp3`) | PD-USGov | Solo + guitar | strong |
| Auld Lang Syne | Burns 1796 | VJ_Memes, ccMixter #40622 (`https://ccmixter.org/content/VJ_Memes/VJ_Memes_-_Auld_Lang_Syne.mp3`) | CC BY 3.0 | Female lead. Alternative: Starlifter 2020 (PD) | ok |
| Shenandoah | Traditional; USAF arrangement | Singing Sergeants, 2017 (C: `Shenandoah_(2017)_-_Singing_Sergeants_-_United_States_Air_Force_Band.mp3`) | PD-USGov | Choir + soloist | strong |
| Yankee Doodle | Traditional | US Army Chorus, 2005 (C: `Yankee_Doodle_(choral).ogg`) | PD-USGov | | ok |
| Happy Birthday to You | Hill sisters 1916 / 1946 | Alexander Stephens, 2011 (C: `Happy_birthday.ogg`) | CC BY-SA 3.0 | German then English; rights of the uploader not verified | ok |
| Twinkle Twinkle Little Star | J. Taylor 1824 | Dcoetzee, 2012 (C: `Twinkle_Twinkle_Little_Star_-_sung_with_full_lyrics.ogg`) | CC0 | Amateur, a cappella | weak/ok |
| My Bonnie Lies Over the Ocean | Traditional | Krystyna K, 2018 (Jamendo 1571932; archive.org/download/jamendo-178935, track 06) | CC BY-SA 3.0 | Solo presumed | ok |
| Scarborough Fair | Traditional (not the copyrighted arrangements) | lunasspecto, ccMixter #13335 | CC BY 3.0 | Male a cappella, rough | ok |
| Joy to the World | Watts 1748, Mason 1872 | US Army Chorus, 2010 (C: `Joy_To_The_World.ogg`) | PD-USGov | 74 s | strong |
| Hark! The Herald Angels Sing | Wesley 1788, Mendelssohn 1847 | Singing Sergeants, 2004 (C: `Hark_the_Herald_Angels_Sing_-_Singing_Sergeants_-_United_States_Air_Force_Band.mp3`) | PD-USGov | | ok |
| Battle Hymn of the Republic | Howe 1910, Steffe 1890 | Singing Sergeants, 1995 (C: `The_Battle_Hymn_of_the_Republic_(1995)_-_Singing_Sergeants_-_United_States_Air_Force_Band.mp3`) | PD-USGov | | ok |
| Danny Boy | Weatherly 1929 | Tom Evans, 1994 (C: `Danny_Boy_-_Tom_Evans.ogg`) | CC BY-SA 3.0 (OTRS permission) | 30 s excerpt only | ok |

## Russian

| Song | Composition: why it's public domain | Recording (source) | Licence | Notes | Verdict |
|---|---|---|---|---|---|
| Ой, то не вечер | Folk | Lena Selyanina, 2009 (C: `Lena_Selyanina_-_Oi_Da_Ne_Vecher.ogg`; IA mirror jamendo-044920) | CC BY 3.0 | Solo female, modern | strong |
| Дорогой длинною | Fomin 1948 (PD with the +4 WWII rule), Podrevsky 1930 | Elena Zhdanova, 2013 (Jamendo 1028723; archive.org/download/jamendo-120975, track 02) | CC BY-SA 3.0 | Voice + electric piano | strong |
| Ямщик, не гони лошадей | Feldman 1950 (PD in 2021, or 2025 with +4); von Ritter born 1846, died 1919 or later | Elena Zhdanova (Jamendo 1028892; jamendo-120975, track 12) | CC BY-SA 3.0 | Solo | ok |
| Гори, гори, моя звезда | Bulakhov 1885; Chuevsky (death year unverified) | Krystyna K (jamendo-160284, track 10) | CC BY-SA 3.0 | Solo presumed | ok |
| Отцвели хризантемы | Harito 1918; Shumsky (death year unverified) | Elena Zhdanova (Jamendo 1028872; track 09) | CC BY-SA 3.0 | | ok |
| Калинка | Larionov 1889 | Albert Janpolski, 1910 (C: `Калинка._Альберт_Янпольский_(IA_78_kalinka_albert-janpolski_gbia0420126a).flac`) | PD (old) | 78 rpm noise | ok |
| Из-за острова на стрежень | Sadovnikov 1883 | A. S. Pirogov, ≤1954 (C: `Pirogov_AS_-_Iz-za_ostrova_na_strezhen.ogg`) | PD (Russia) | The plot includes drowning, so it's unsuitable for 0+ | exclude |
| Очи чёрные | Hrebinka 1848 | Chaliapin, <1938 (C: `Ochi_chernie.ogg`) | PD | Old | weak/ok |
| Коробейники | Nekrasov 1878; folk | David Medoff, 1927 (C: `Коробушка,_Давид_Медов,_акк._оркестр,_Victor,_1927.ogg`) | PD in Russia | 78 rpm | weak/ok |
| Во поле берёза стояла / Валенки / Тонкая рябина | Folk | MKHLSDRV, 2025 (Jamendo; jamendo-616194 / 617758) | CC BY-SA 3.0 | Possibly AI-generated vocals; verify | ok |
| Ой, мороз, мороз | Disputed authorship (1954 claim) | — | — | Legal risk | exclude |

## Rejected (not public domain in Russia, or no usable recording)

- **Still under copyright in Russia:**
  - Катюша, Подмосковные вечера, Вечер на рейде, Пусть бегут неуклюже, Ложкой снег мешая.
  - В лесу родилась ёлочка (Kudasheva died 1964).
  - Take Me Out to the Ball Game (Norworth died 1959).
  - This Land Is Your Land.
  - O Sole Mio (co-author Mazzucchi died 1972).
- **Licence not usable:** ND-licensed recordings; Internet Archive "CC0" items that are really commercial records; amateur videos of choirs.
- **No usable vocal recording found:** Oh! Susanna, Clementine, Old MacDonald, Row Row Row Your Boat, Down by the Riverside, Однозвучно гремит колокольчик, Степь да степь кругом.
