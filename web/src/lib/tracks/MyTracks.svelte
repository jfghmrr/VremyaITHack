<script lang="ts">
  // «Мои треки» на странице песен: свои загрузки владельца, этапы обработки, срок хранения и удаление.
  import { onMount } from "svelte";
  import ConfirmDialog from "#lib/ui/ConfirmDialog.svelte";
  import UploadTrack from "./UploadTrack.svelte";
  import { deleteTrack, expiryText, statusText, tracks, watchTracks, type OwnTrack } from "./tracks.svelte.ts";

  let removing = $state<OwnTrack | null>(null);
  let busy = $state(false);
  let error = $state("");
  let now = $state(Date.now());

  onMount(() => {
    const stop = watchTracks();
    const clock = setInterval(() => (now = Date.now()), 60_000);
    return () => {
      stop();
      clearInterval(clock);
    };
  });

  async function remove(track: OwnTrack) {
    busy = true;
    error = "";
    try {
      await deleteTrack(track.id);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<section class="my-tracks" id="my-tracks" aria-labelledby="my-tracks-title">
  <h2 id="my-tracks-title">Мои треки</h2>
  <p class="lead">Своя песня: компьютер команды отделит голос, найдёт мелодию и слова. Обычно это около минуты.</p>
  <div class="columns">
    <div class="list">
      {#if tracks.error}<p class="notice error" role="alert">{tracks.error}</p>{/if}
      {#if error}<p class="notice error" role="alert">{error}</p>{/if}
      {#if tracks.loaded && !tracks.list.length && !tracks.error}<p class="empty">Пока нет своих треков.</p>{/if}
      <ul aria-live="polite">
        {#each tracks.list as track (track.id)}
          <li class="track sheet" class:failed={track.status === "failed"}>
            <div class="info">
              <strong>{track.title}</strong>
              <span class="meta">{track.language === "ru" ? "RU" : "EN"} · {expiryText(track, now)}</span>
            </div>
            <div class="state">
              {#if track.status === "ready"}
                <a class="btn btn-primary" href="/sing/my-{track.id}">Готово — петь</a>
                <a class="btn btn-quiet" href="/tracks/{track.id}/lyrics" aria-label="Править текст «{track.title}»">Править текст</a>
              {:else}
                <span class="status">{statusText(track)}</span>
                {#if track.status === "failed" && track.error}<span class="reason">{track.error}</span>{/if}
              {/if}
              <button type="button" class="btn btn-quiet" disabled={busy} aria-label="Удалить «{track.title}»" onclick={() => (removing = track)}>Удалить</button>
            </div>
          </li>
        {/each}
      </ul>
    </div>
    <UploadTrack />
  </div>
</section>

<ConfirmDialog
  open={!!removing}
  title="Удалить трек?"
  text={removing ? `«${removing.title}» и все его файлы удалятся с сервера сразу.` : ""}
  confirm="Удалить"
  cancel="Оставить"
  oncancel={() => (removing = null)}
  onconfirm={() => {
    const track = removing;
    removing = null;
    if (track) void remove(track);
  }}
/>

<style>
  .my-tracks {
    display: grid;
    gap: var(--s-3);
    padding: var(--s-6) 4% var(--s-7);
    color: var(--on-room);
  }
  h2 {
    margin: 0;
    font: 700 2.2rem/1 var(--font-hand);
  }
  .lead,
  .empty {
    margin: 0;
    color: var(--on-room-2);
    font-size: var(--t-s);
  }
  .columns {
    display: grid;
    gap: var(--s-5);
    align-items: start;
  }
  .list {
    display: grid;
    gap: var(--s-3);
    min-width: 0;
  }
  ul {
    display: grid;
    gap: var(--s-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .track {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2) var(--s-4);
    padding: var(--s-3) var(--s-4);
  }
  .info {
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .info strong {
    overflow-wrap: anywhere;
  }
  .meta,
  .reason {
    color: var(--ink-2);
    font-size: var(--t-xs);
  }
  .state {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s-2) var(--s-3);
  }
  .status {
    font-family: var(--font-mono);
    font-size: var(--t-s);
  }
  .failed .status {
    color: var(--accent);
  }
  .state .btn {
    min-height: 44px;
  }
  .btn-primary {
    font-size: 1.2rem;
  }
  @media (min-width: 1100px) and (min-height: 521px) {
    .columns {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
    }
  }
  @media (min-width: 2200px), (min-aspect-ratio: 21/9) {
    .my-tracks {
      max-width: 1680px;
      margin-inline: auto;
    }
  }
  @media (max-width: 599px) {
    .my-tracks {
      padding-inline: 16px;
    }
    .state {
      width: 100%;
      justify-content: space-between;
    }
  }
</style>
