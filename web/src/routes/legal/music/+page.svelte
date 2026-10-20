<script lang="ts">
  import LegalPage from "#lib/legal/LegalPage.svelte";
  import music from "#lib/legal/vocal-music.json";

  const plural = (n: number, one: string, few: string, many: string) =>
    n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many;
  const licenseName = (license: string) => (license === "Public domain" ? "Общественное достояние" : license);
</script>

<svelte:head><title>Музыка и лицензии — Перепев</title></svelte:head>

<LegalPage title="Музыка и лицензии" updated="16 октября 2026">
  <p>
    В каталоге — {music.length} {plural(music.length, "фрагмент", "фрагмента", "фрагментов")} с настоящим вокалом и словами:
    {music.filter((song) => song.language === "ru").length} на русском и
    {music.filter((song) => song.language === "en").length} на английском.
    Большинство записей авторы разрешили распространять и перерабатывать по лицензиям Creative Commons;
    авторские права на них сохраняются, а бесплатное прослушивание само по себе такого разрешения не даёт.
  </p>
  <p>
    Известные песни — народные или написанные авторами, умершими более 70 лет назад, — взяты только
    в свободных записях: в общественном достоянии (записи военных оркестров США — работы
    федерального правительства США), переданных в общественное достояние по CC0
    или опубликованных исполнителями под CC BY и CC BY-SA. Лицензия каждой записи проверена на странице
    источника при загрузке; адрес, версия лицензии и контрольные суммы файлов — в сведениях о фрагменте.
  </p>
  <h2>Как используются записи</h2>
  <p>
    Команда mugsize подготовила короткие фрагменты для «Перепева»: обрезала записи,
    добавила плавные границы, разметку слов и эталон мелодии, а для караоке разделила запись
    на минус и голос-подсказку. Голос исполнителя остаётся в основной записи.
    Автор, источник, лицензия и изменения указаны ниже и в файле сведений каждой песни.
    Авторы музыки не заявляются партнёрами проекта и не подтверждали качество караоке.
  </p>
  <p>
    CC BY разрешает копирование и переработку с сохранением указания авторства, ссылки на лицензию
    и сведений об изменениях. Для CC BY-SA переработанные музыкальные материалы распространяются
    по той же лицензии, что и запись: CC BY-SA 4.0 или CC BY-SA 3.0. Фрагменты записей в общественном
    достоянии и под CC0 команда также передаёт в общественное достояние (CC0 1.0).
    Лицензия MIT программного кода не заменяет лицензии музыки и текстов.
  </p>
  <h2>Песни и авторы</h2>
  <div class="music-list">
    {#each music as song (song.id)}
      <section class="music-credit" id={song.id} aria-labelledby={`${song.id}-title`}>
        <div class="credit-heading">
          <h3 id={`${song.id}-title`}>{song.title}</h3>
          <span lang="en">{song.language === "ru" ? "RU" : "EN"}</span>
        </div>
        <p class="artist">{song.artist}</p>
        <p>{song.credits}</p>
        {#if song.changes}<p class="changes">Изменения: {song.changes}</p>{/if}
        <div class="credit-links">
          <a href={song.source} rel="noreferrer" target="_blank">Запись у автора / источник</a>
          <a href={song.licenseUrl} rel="noreferrer" target="_blank">{licenseName(song.license)}</a>
          <a href={`/songs/${song.id}/CREDITS.json`}>Сведения о фрагменте</a>
        </div>
      </section>
    {/each}
  </div>
  <h2>Отбор текстов</h2>
  <p>
    Для включённых фрагментов проверены слова: в отбор не вошли мат, явные оскорбления групп людей,
    призывы к насилию и наркотическая тематика. Названия и имена авторов сверены
    с <a href="https://minjust.gov.ru/ru/extremist-materials/" rel="noreferrer" target="_blank">федеральным списком экстремистских материалов</a>
    16 октября 2026 года, а исполнители и авторы добавленных народных и старинных песен — ещё и
    с <a href="https://minjust.gov.ru/ru/pages/reestr-inostryannykh-agentov/" rel="noreferrer" target="_blank">реестром иностранных агентов</a>
    (выгрузка 16.10.2026); совпадений, относящихся к выбранным песням, не обнаружено.
    Это редакторская проверка конкретной подборки, а не юридическое заключение или возрастная классификация.
  </p>
  <h2>Другие материалы</h2>
  <p>
    Шрифты Golos Text, Caveat, IBM Plex Mono, Oswald, PT Serif и Rubik Mono One — SIL Open Font License 1.1. Полный список
    сторонних компонентов — <a href="/THIRD_PARTY_NOTICES.txt">THIRD_PARTY_NOTICES.txt</a>.
  </p>
</LegalPage>

<style>
  .music-list { display: grid; gap: 16px; }
  .music-credit { padding: 18px 0; border-top: 1px solid var(--line); scroll-margin-top: 28px; }
  .credit-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
  h3 { font-size: var(--t-l); line-height: 1.3; overflow-wrap: anywhere; }
  .credit-heading span { flex: 0 0 auto; font: 12px var(--font-mono); color: var(--ink-2); }
  .artist { font-weight: 600; }
  .changes { font-size: var(--t-s); color: var(--ink-2); }
  .credit-links { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: var(--t-s); }
  .credit-links a:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
  /* Сенсорный экран: ссылки сведений — цели нажатия не ниже 44 px (QA L5). */
  @media (pointer: coarse) {
    .credit-links { gap: 0 20px; }
    .credit-links a { display: inline-flex; align-items: center; min-height: var(--tap); }
  }
</style>
