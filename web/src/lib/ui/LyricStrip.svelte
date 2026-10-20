<script lang="ts">
  // Слова на сцене дуэли: текущая строка крупно и следующая строка мельче, на бумажной
  // полосе, как лист одиночной сцены. С разметкой слов (lyrics.words.json) звучащее слово
  // заливается маркером по ходу пения; без неё строка подсвечивается целиком.
  // Время читается в requestAnimationFrame (около 30 обновлений в секунду), а не реактивно.
  // «Вместе» (turns из расписания сервера): у строки ярлык, чья она, — «Твоя строка» красным
  // или «Поёт {имя}» синим, словом и цветом; у следующей строки — кто поёт дальше.
  import { onMount } from "svelte";
  import type { Turn } from "#lib/api/types.ts";
  import type { Song } from "#lib/scoring/types.ts";
  import { ownerOfLine } from "#lib/duel/coop.ts";
  import { isCurrentWord, lineAt, wordProgress, type WordTiming } from "#lib/lyrics.ts";

  let {
    song,
    time,
    words = null,
    turns = null,
    slot = 0,
    partner = "друг",
  }: { song: Song; time: () => number; words?: WordTiming | null; turns?: Turn[] | null; slot?: number; partner?: string } = $props();

  let t = $state(-1);
  onMount(() => {
    let raf = 0;
    const tick = () => {
      const next = time();
      if (Math.abs(next - t) >= 0.03) t = next;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  });

  const current = $derived(lineAt(song.lyrics, t));
  const next = $derived(song.lyrics[current + 1] ?? null);
  const text = (s: string) => s.replaceAll(" · ", " ");
  /** Чья строка в «Вместе»: «mine», «partner» или null (обычная дуэль, строка вне ходов). */
  const whose = (line: number) => {
    const owner = turns?.length ? ownerOfLine(turns, line) : null;
    return owner == null ? null : owner === slot ? "mine" : "partner";
  };
  const nowOwner = $derived(whose(current));
  const nextOwner = $derived(whose(current + 1));
  const firstOwner = $derived(whose(0));
</script>

<section class="lyric-strip" class:coop={!!turns?.length} aria-label="Слова песни">
  <p class="now" class:theirs={nowOwner === "partner"}>
    {#if nowOwner}<span class="who {nowOwner}">{nowOwner === "mine" ? "Твоя строка" : `Поёт ${partner}`}</span>{/if}
    {#if current < 0}
      <mark>{firstOwner ? (firstOwner === "mine" ? "Приготовься: первую строку поёшь ты" : `Приготовься: первую строку поёт ${partner}`) : t < 0 ? "Приготовься: скоро первая строка" : "Вдохни: скоро первая строка"}</mark>
    {:else if words}
      {#each words.lines[current].words as word, k (k)}
        <span class="word" class:active-word={isCurrentWord(word, t)} style:--fill={`${wordProgress(word, t) * 100}%`}>{word.text}</span>{" "}
      {/each}
    {:else}
      <mark>{text(song.lyrics[current].text)}</mark>
    {/if}
  </p>
  <p class="next">
    {#if next && nextOwner && nextOwner !== nowOwner}<span class="who-next {nextOwner}">{nextOwner === "mine" ? "Дальше ты:" : `Дальше ${partner}:`}</span>{/if}
    {next ? text(next.text) : current >= 0 ? "Последняя строка" : ""}
  </p>
</section>

<style>
  .lyric-strip {
    display: grid;
    gap: 2px;
    min-width: 0;
    padding: 6px var(--s-4) 8px;
    background:
      linear-gradient(90deg, transparent 22px, rgb(168 29 29 / 0.35) 22px 23px, transparent 23px),
      var(--paper) var(--tex-paper);
    color: var(--ink);
    box-shadow: var(--shadow-sheet);
  }
  p {
    margin: 0;
    padding-left: 18px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .now {
    min-height: 1.5em;
    font-size: clamp(1.1rem, 1.6vw, 1.5rem);
    font-weight: 700;
    line-height: 1.45;
  }
  .next {
    min-height: 1.4em;
    font-size: var(--t-s);
    color: var(--ink-3);
    line-height: 1.4;
  }
  mark {
    padding: 0.05em 0.25em;
    background: linear-gradient(100deg, transparent 0.2em, rgb(242 215 78 / 0.9) 0.35em, rgb(242 215 78 / 0.75) calc(100% - 0.3em), transparent);
    color: var(--ink);
  }
  .word {
    border-radius: 2px;
    background: linear-gradient(to right, #eccb62 var(--fill), transparent var(--fill));
  }
  .active-word {
    color: #8e191e;
    text-decoration: underline;
    text-underline-offset: 4px;
  }
  /* «Вместе»: ярлык владельца строки — слово и цвет (красный — ты, синий — друг). */
  .who {
    display: inline-block;
    margin-right: 0.5em;
    padding: 0.05em 0.45em 0.1em;
    border-radius: 3px;
    color: var(--paper-2);
    font-size: 0.72em;
    font-weight: 800;
    letter-spacing: 0.02em;
    vertical-align: 0.12em;
  }
  .who.mine {
    background: var(--accent);
  }
  .who.partner {
    background: var(--rival);
  }
  .now.theirs {
    color: var(--ink-2);
  }
  .now.theirs .active-word {
    color: var(--rival);
  }
  .who-next {
    margin-right: 0.35em;
    font-weight: 700;
  }
  .who-next.mine {
    color: var(--accent);
  }
  .who-next.partner {
    color: var(--rival);
  }
  /* Короткий экран (телефон боком): только текущая строка, чтобы график остался крупным. */
  @media (max-height: 520px) {
    .lyric-strip {
      padding-block: 4px;
    }
    .next {
      display: none;
    }
    .now {
      font-size: 1.05rem;
    }
  }
</style>
