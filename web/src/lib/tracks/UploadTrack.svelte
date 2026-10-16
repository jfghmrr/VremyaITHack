<script lang="ts">
  // Загрузка своего трека: файл раскодируется в браузере, по волне выбирается отрывок 15–60 с,
  // на сервер уходит только он с полями по 2 с (WAV 44,1 кГц моно). Ошибки файла — до загрузки.
  import { onDestroy } from "svelte";
  import { paint } from "#lib/ui/canvas.ts";
  import { MAX_WINDOW_S, MIN_WINDOW_S, TRACK_RATE, encodeWav, mono, suggestWindow } from "./wav.ts";
  import { headerDuration } from "./header.ts";
  import { createTrack, deleteTrack, sendTrackAudio } from "./tracks.svelte.ts";
  import { ApiError } from "#lib/api/http.ts";

  const MAX_BYTES = 30 * 1024 * 1024;
  const MAX_DURATION_S = 10 * 60;
  const BINS = 1200;
  const UNREADABLE = "Не удалось прочитать аудио. Выбери файл MP3, M4A, WAV, OGG или FLAC.";
  const SHORT = "Нужен отрывок от 15 секунд, а этот файл короче.";
  const LONG = "Файл длиннее 10 минут. Выбери одну песню.";

  let input: HTMLInputElement;
  let canvas: HTMLCanvasElement | undefined = $state();
  // Звук файла не реактивен: десятки миллионов отсчётов.
  let samples: Float32Array<ArrayBuffer> | null = null;
  let peaks = $state.raw<Float32Array | null>(null);
  let duration = $state(0);
  let start = $state(0);
  let length = $state(30);
  let title = $state("");
  let language = $state<"ru" | "en">("ru");
  let phase = $state<"idle" | "reading" | "ready" | "uploading">("idle");
  let error = $state("");
  let done = $state("");
  let listening = $state(false);
  let preview: { ctx: AudioContext; source: AudioBufferSourceNode } | null = null;
  let ticket = 0;
  // Трек создан, но звук не принят (сбой сети, 5xx): повтор отправляет только звук в тот же трек,
  // не создавая второй и не тратя ещё одну из пяти загрузок в сутки.
  let created = $state<string | null>(null);
  let destroyed = false;

  /** Понятная пользователю причина отказа; любые другие ошибки показываются как UNREADABLE. */
  class FileProblem extends Error {}

  const maxLength = $derived(Math.min(MAX_WINDOW_S, Math.floor(duration)));
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const range = $derived(`${clock(start)}–${clock(start + length)} · ${Math.round(length)} с`);

  onDestroy(() => {
    destroyed = true;
    stopPreview();
    discard();
  });

  /**
   * Брошенный трек без звука удаляется, чтобы не висел в списке. Пока звук отправляется, трек
   * не трогаем: отправка доживёт после ухода со страницы, а при её сбое трек удалит submit().
   */
  function discard() {
    if (phase === "uploading") return;
    const id = created;
    created = null;
    if (id) void deleteTrack(id).catch(() => {});
  }

  function limit(seconds: number) {
    if (seconds > MAX_DURATION_S) throw new FileProblem(LONG);
    if (seconds < MIN_WINDOW_S) throw new FileProblem(SHORT);
  }

  /** Длительность через <audio> без раскодирования; null — браузер её не сообщил (iOS может молчать). */
  function probe(file: File): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const audio = new Audio();
      const finish = (fn: () => void) => {
        clearTimeout(timer);
        audio.onloadedmetadata = audio.onerror = null;
        audio.removeAttribute("src");
        URL.revokeObjectURL(url);
        fn();
      };
      const timer = setTimeout(() => finish(() => resolve(null)), 3000);
      audio.preload = "metadata";
      audio.onloadedmetadata = () => finish(() => resolve(Number.isFinite(audio.duration) ? audio.duration : null));
      audio.onerror = () => finish(() => reject(new FileProblem(UNREADABLE)));
      audio.src = url;
    });
  }

  /** Раскодирует в 44,1 кГц, проверяет длительность и сразу сводит в моно: AudioBuffer дальше не держим. */
  async function decodeMono(file: File): Promise<Float32Array<ArrayBuffer>> {
    let decoded: AudioBuffer;
    try {
      decoded = await new OfflineAudioContext(1, 1, TRACK_RATE).decodeAudioData(await file.arrayBuffer());
    } catch {
      throw new FileProblem(UNREADABLE);
    }
    limit(decoded.duration);
    return mono(decoded);
  }

  function envelope(data: Float32Array) {
    const out = new Float32Array(BINS);
    const per = data.length / BINS;
    for (let b = 0; b < BINS; b++) {
      let peak = 0;
      for (let i = Math.floor(b * per); i < Math.floor((b + 1) * per); i++) peak = Math.max(peak, Math.abs(data[i]));
      out[b] = peak;
    }
    return out;
  }

  function reset() {
    stopPreview();
    samples = null;
    peaks = null;
    error = "";
    phase = "idle";
  }

  async function choose() {
    const file = input.files?.[0];
    const t = ++ticket;
    discard();
    reset();
    done = "";
    if (!file) return;
    if (file.size > MAX_BYTES) {
      error = "Файл больше 30 МБ. Выбери файл поменьше.";
      return;
    }
    phase = "reading";
    try {
      // Длительность до раскодирования: из заголовка (WAV, MP3, FLAC, M4A), иначе через <audio>.
      const header = await headerDuration(file);
      if (t !== ticket) return;
      if (header?.exact) limit(header.seconds);
      else {
        // Оценка MP3 по битрейту бывает неточной: по ней отклоняем только явно длинный файл.
        if (header && header.seconds > 1.5 * MAX_DURATION_S) throw new FileProblem(LONG);
        const known = await probe(file);
        if (t !== ticket) return;
        if (known !== null) limit(known);
      }
      const data = await decodeMono(file);
      if (t !== ticket) return;
      samples = data;
      duration = data.length / TRACK_RATE;
      ({ start, length } = suggestWindow(data));
      peaks = envelope(data);
      title = file.name.replace(/\.[^.]+$/, "").trim().slice(0, 100) || "Мой трек";
      phase = "ready";
    } catch (e) {
      if (t !== ticket) return;
      // Сбой чтения файла браузером (DOMException и т. п.) тоже показывается по-русски.
      error = e instanceof FileProblem ? e.message : UNREADABLE;
      phase = "idle";
    }
  }

  function setLength(value: number) {
    length = Math.min(maxLength, Math.max(MIN_WINDOW_S, value));
    start = Math.min(start, duration - length);
  }

  // Перетаскивание окна по волне: за середину — сдвиг, за край — длина 15–60 с.
  let drag: { kind: "move" | "left" | "right"; x: number; start: number; length: number } | null = null;
  function at(e: PointerEvent) {
    const box = canvas!.getBoundingClientRect();
    return { x: e.clientX - box.left, width: box.width };
  }
  function pointerdown(e: PointerEvent) {
    if (!duration || phase !== "ready") return;
    const { x, width } = at(e);
    const left = (start / duration) * width;
    const right = ((start + length) / duration) * width;
    let kind: "move" | "left" | "right" = Math.abs(x - left) <= 12 ? "left" : Math.abs(x - right) <= 12 ? "right" : "move";
    if (kind === "move" && (x < left || x > right)) start = Math.min(duration - length, Math.max(0, (x / width) * duration - length / 2));
    drag = { kind, x, start, length };
    canvas!.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function pointermove(e: PointerEvent) {
    if (!drag) return;
    const { x, width } = at(e);
    const dt = ((x - drag.x) / width) * duration;
    if (drag.kind === "move") start = Math.min(duration - length, Math.max(0, drag.start + dt));
    else if (drag.kind === "right") length = Math.min(maxLength, duration - drag.start, Math.max(MIN_WINDOW_S, drag.length + dt));
    else {
      const end = drag.start + drag.length;
      start = Math.min(end - MIN_WINDOW_S, Math.max(0, end - maxLength, drag.start + dt));
      length = end - start;
    }
  }
  function pointerup() {
    drag = null;
  }

  function draw(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (!peaks || !duration) return;
    ctx.fillStyle = "#1f1c1a";
    ctx.fillRect(0, 0, w, h);
    const x0 = (start / duration) * w;
    const x1 = ((start + length) / duration) * w;
    ctx.fillStyle = "rgb(168 29 29 / 0.35)";
    ctx.fillRect(x0, 0, x1 - x0, h);
    for (let x = 0; x < w; x++) {
      const b = Math.min(BINS - 1, Math.floor((x / w) * BINS));
      const half = Math.max(0.5, peaks[b] * (h / 2 - 4));
      ctx.fillStyle = x >= x0 && x <= x1 ? "#f5f0e6" : "#8d8678";
      ctx.fillRect(x, h / 2 - half, 1, half * 2);
    }
    ctx.fillStyle = "#e2525a";
    ctx.fillRect(x0 - 2, 0, 4, h);
    ctx.fillRect(x1 - 2, 0, 4, h);
  }

  function stopPreview() {
    preview?.source.stop();
    void preview?.ctx.close();
    preview = null;
    listening = false;
  }

  async function listen() {
    if (preview) return stopPreview();
    if (!samples) return;
    const ctx = new AudioContext();
    const from = Math.round(start * TRACK_RATE);
    const count = Math.min(samples.length - from, Math.round(length * TRACK_RATE));
    const buffer = ctx.createBuffer(1, count, TRACK_RATE);
    buffer.copyToChannel(samples.subarray(from, from + count), 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = () => {
      if (preview?.source === source) stopPreview();
    };
    preview = { ctx, source };
    listening = true;
    await ctx.resume();
    source.start();
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (!samples || phase !== "ready") return;
    stopPreview();
    phase = "uploading";
    error = "";
    try {
      created ??= await createTrack(title.trim() || "Мой трек", language);
      await sendTrackAudio(created, encodeWav(samples, start, length));
      created = null;
      ticket++;
      reset();
      input.value = "";
      done = "Отрывок загружен. Обработка обычно занимает около минуты.";
    } catch (err) {
      // Трек пропал или уже со звуком: следующая попытка создаст новый.
      if (err instanceof ApiError && (err.status === 404 || err.status === 409)) created = null;
      error = err instanceof ApiError ? err.message : "Не удалось отправить отрывок. Попробуй ещё раз.";
      phase = "ready";
      // Страницу уже закрыли: повторить некому, трек без звука удаляется.
      if (destroyed) discard();
    }
  }
</script>

<form class="upload sheet" aria-labelledby="upload-title" onsubmit={submit}>
  <h3 id="upload-title">Загрузить свою песню</h3>
  <p class="small">
    Файл до 30 МБ: MP3, M4A, WAV, OGG или FLAC. Целиком он остаётся на устройстве: на сервер уходит только выбранный отрывок 15–60 секунд. Трек видишь только ты, через 24 часа он удаляется.
    Загружай записи, на которые у тебя есть права.
  </p>
  <label class="field">Файл с песней<input bind:this={input} type="file" accept="audio/*" disabled={phase === "reading" || phase === "uploading"} onchange={choose} /></label>
  {#if phase === "reading"}<p class="small" role="status">Читаем файл…</p>{/if}
  {#if error}<p class="notice error" role="alert">{error}</p>{/if}
  {#if done}<p class="notice" role="status">{done}</p>{/if}
  {#if peaks && phase !== "idle" && phase !== "reading"}
    <div class="wave" role="img" aria-label="Звуковая волна, выбран отрывок {range}">
      <canvas bind:this={canvas} use:paint={{ draw, deps: [peaks, start, length] }} aria-hidden="true" onpointerdown={pointerdown} onpointermove={pointermove} onpointerup={pointerup} onpointercancel={pointerup}></canvas>
    </div>
    <p class="window"><span class="mono">{range}</span><button type="button" class="btn btn-quiet" onclick={listen}>{listening ? "Стоп" : "Послушать отрывок"}</button></p>
    <div class="ranges">
      <label class="field range">Начало отрывка<input type="range" min="0" max={Math.max(0, duration - length)} step="0.5" bind:value={start} /></label>
      <label class="field range">Длина отрывка<input type="range" min={MIN_WINDOW_S} max={maxLength} step="1" value={length} oninput={(e) => setLength(Number((e.currentTarget as HTMLInputElement).value))} /></label>
    </div>
    <div class="details">
      <label class="field">Название<input bind:value={title} required maxlength="100" disabled={!!created} /></label>
      <label class="field">Язык песни<select bind:value={language} disabled={!!created}><option value="ru">Русский</option><option value="en">English</option></select></label>
    </div>
    <button class="btn btn-primary" disabled={phase === "uploading"}>{phase === "uploading" ? "Загружаем…" : "Загрузить отрывок"}</button>
  {/if}
</form>

<style>
  .upload {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--s-3);
    align-content: start;
    min-width: 0;
    padding: var(--s-4) var(--s-5);
  }
  h3 {
    margin: 0;
    font: 700 1.6rem/1.1 var(--font-hand);
  }
  p {
    margin: 0;
  }
  .field input[type="file"] {
    width: 100%;
    min-width: 0;
    padding: var(--s-2) 0;
    min-height: 44px;
    background: transparent;
    border: 0;
  }
  .wave {
    height: 96px;
    border-radius: 4px;
    overflow: hidden;
  }
  .wave canvas {
    display: block;
    width: 100%;
    height: 100%;
    touch-action: none;
    cursor: ew-resize;
  }
  .window {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--s-2);
  }
  .window .btn {
    min-height: 44px;
  }
  .ranges,
  .details {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--s-3);
  }
  .range input {
    min-height: 44px;
    padding: 0;
    border: 0;
    background: transparent;
    accent-color: var(--accent);
  }
  .details select,
  .details input {
    min-height: 44px;
  }
  .btn-primary {
    justify-self: start;
  }
  @media (max-width: 599px) {
    .upload {
      padding: var(--s-3);
    }
    .ranges,
    .details {
      grid-template-columns: minmax(0, 1fr);
    }
    .btn-primary {
      justify-self: stretch;
    }
  }
</style>
