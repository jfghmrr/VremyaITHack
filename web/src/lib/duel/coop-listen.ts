// «Вместе», прослушивание на итоге: один контекст звука на нажатие, синтезированный голос или
// настоящие голоса, и передача синтеза настоящим голосам, когда обе записи на месте. Решение о
// передаче проверяется и при приходе записи, и сразу после запуска звука: запись могла прийти,
// пока синтез запускался (ожидание контекста и сборки звука), — раньше в этом окне синтез
// доигрывал до конца под нажатой «Настоящие голоса». Минус песни всегда звучит под голосами:
// нажатие сразу после песни ждёт его декодирования («Готовим минус…»), а не играет без него.
// Без Svelte: проверяется модульными тестами.

export type ListenKind = "real" | "synth";

/** Звучащее прослушивание (CurveVoices или VoiceMix). Времена — по часам его контекста. */
export interface ListenPlayer {
  /** Место в песне сейчас, с. */
  readonly position: number;
  /** Когда звук начинается. */
  readonly startsAt: number;
  /** Место в песне в момент `t`. */
  positionAt(t: number): number;
  /** Остановить сейчас или в момент `when` (тогда без разрыва со следующим звуком). */
  stop(when?: number): void;
}

export interface ListenContext {
  readonly currentTime: number;
}

/**
 * Минус песни: `buffer` — декодированный минус (null — без него); `missing` — у песни минус есть,
 * но загрузить его не удалось (сеть), и прослушивание об этом говорит.
 */
export interface Backing<B> {
  buffer: B | null;
  missing: boolean;
}

export interface ListenDeps<C extends ListenContext, B> {
  /** Новый контекст — синхронно, прямо в обработчике нажатия (активация пользователя); запущен. */
  context(): C;
  close(ctx: C): void;
  /** Минус песни: ждёт его загрузки и декодирования (у готового — сразу). */
  backing(): Promise<Backing<B>>;
  synth(ctx: C, from: number, to: number, onEnd: () => void, backing: B | null): Promise<ListenPlayer>;
  /** `at` — время старта на часах контекста (передача с того же места). */
  real(ctx: C, from: number, to: number, onEnd: () => void, backing: B | null, at?: number): Promise<ListenPlayer>;
  /** Изменились playing / window / error. */
  changed(): void;
}

/** Запас до старта сведения при передаче, с: успеть подготовить буферы. */
export const HANDOVER_LEAD = 0.12;

/**
 * Пора передавать: звучит синтезированный голос, обе записи здесь, игрок синтез сам не
 * выбирал, и передача ещё не идёт.
 */
export function shouldHandOver(s: { realReady: boolean; chosen: boolean; playing: ListenKind | null; handing: boolean }): boolean {
  return s.realReady && !s.chosen && s.playing === "synth" && !s.handing;
}

export class CoopListening<C extends ListenContext, B = unknown> {
  playing: ListenKind | null = null;
  window: { from: number; to: number; moment: number | null } | null = null;
  error = "";
  /** Нажали «Прослушать», а минус ещё готовится: звук начнётся вместе с ним. */
  preparing = false;
  /** Минус загрузить не удалось: голоса звучат без него. */
  backingMissing = false;
  private track: B | null = null;
  private player: ListenPlayer | null = null;
  private ctx: C | null = null;
  private ticket = 0;
  private handing = false;
  private realReady = false;
  private chosen = false;

  constructor(private readonly deps: ListenDeps<C, B>) {}

  /** Место в песне сейчас (для счётчика), 0 без звука. */
  get position(): number {
    return this.player?.position ?? 0;
  }

  /** Входы решения: обе ли записи на месте и выбрал ли игрок источник сам. */
  set(o: { realReady: boolean; chosen: boolean }) {
    this.realReady = o.realReady;
    this.chosen = o.chosen;
    this.check();
  }

  /**
   * Прослушивание окна [from, to]. Контекст создаётся до первого ожидания (активация нажатия),
   * затем звук ждёт минус: голоса и минус стартуют вместе, по одним часам.
   */
  async listen(kind: ListenKind, from: number, to: number, moment: number | null): Promise<void> {
    this.stop();
    const t = this.ticket;
    const ctx = (this.ctx = this.deps.context());
    const onEnd = () => {
      if (t === this.ticket) this.stop();
    };
    this.window = { from, to, moment };
    this.preparing = true;
    this.deps.changed();
    try {
      const backing = await this.deps.backing();
      if (t !== this.ticket) return;
      // Пока готовился минус, могла прийти запись партнёра: сразу настоящие голоса, без синтеза
      // на долю секунды и передачи.
      if (kind === "synth" && this.realReady && !this.chosen) kind = "real";
      this.track = backing.buffer;
      this.backingMissing = backing.missing;
      const p = await (kind === "real" ? this.deps.real(ctx, from, to, onEnd, this.track) : this.deps.synth(ctx, from, to, onEnd, this.track));
      if (t !== this.ticket) return p.stop();
      this.player = p;
      this.playing = kind;
      this.preparing = false;
      this.deps.changed();
      // Запись партнёра могла прийти, пока звук запускался.
      this.check();
    } catch (e) {
      // Устаревший запуск (уже нажали другое или ушли со страницы) закрывается молча.
      if (t !== this.ticket) return;
      this.stop();
      this.error = `Не удалось запустить звук: ${(e as Error).message}`;
      this.deps.changed();
    }
  }

  /** «Стоп», новый выбор, снятие согласия, уход со страницы: всё смолкает, контекст закрыт. */
  stop() {
    this.ticket++;
    this.handing = false;
    this.player?.stop();
    this.player = null;
    if (this.ctx) this.deps.close(this.ctx);
    this.ctx = null;
    this.playing = null;
    this.window = null;
    this.error = "";
    this.preparing = false;
    this.backingMissing = false;
    this.track = null;
    this.deps.changed();
  }

  private check() {
    if (shouldHandOver({ realReady: this.realReady, chosen: this.chosen, playing: this.playing, handing: this.handing })) void this.handover();
  }

  /** Синтез звучит, обе записи пришли: с того же места — настоящие голоса, на том же контексте. */
  private async handover() {
    const cur = this.player;
    const ctx = this.ctx;
    const w = this.window;
    if (!cur || !ctx || !w) return;
    const t = this.ticket;
    const at = ctx.currentTime + HANDOVER_LEAD;
    const from = cur.positionAt(at);
    if (w.to - from < 0.3) return;
    this.handing = true;
    try {
      // Тот же минус, что звучал под синтезом.
      const mix = await this.deps.real(ctx, from, w.to, () => {
        if (t === this.ticket) this.stop();
      }, this.track, at);
      if (t !== this.ticket || this.player !== cur) return mix.stop();
      // Синтез смолкает ровно там, где вступает сведение: ни паузы минуса, ни наложения голосов.
      cur.stop(mix.startsAt);
      this.player = mix;
      this.playing = "real";
      this.deps.changed();
    } catch {
      /* синтезированный голос доигрывает */
    } finally {
      if (t === this.ticket) this.handing = false;
    }
  }
}

/**
 * Минус для прослушивания: загрузка начинается заранее (`prefetch`, при открытии итога), `get`
 * ждёт её не дольше `waitMs`. Не загрузился — следующее нажатие загружает заново; загрузка, не
 * успевшая за `waitMs`, тоже заменяется новой при следующем нажатии.
 */
export function backingLoader<B>(load: () => Promise<Backing<B>>, waitMs: number) {
  type Run = { done: Promise<Backing<B>>; result: Backing<B> | null; abandoned: boolean };
  const missing: Backing<B> = { buffer: null, missing: true };
  let current: Run | null = null;
  const start = (): Run => {
    let run!: Run;
    // Обработчик промиса выполняется не раньше следующей микрозадачи — run к тому времени задан.
    const done = load()
      .catch(() => missing)
      .then((r) => (run.result = r));
    run = { done, result: null, abandoned: false };
    current = run;
    return run;
  };
  return {
    prefetch() {
      if (!current) start();
    },
    get(): Promise<Backing<B>> {
      let run = current;
      if (!run || run.abandoned || run.result?.missing) run = start();
      if (run.result) return Promise.resolve(run.result);
      const r = run;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          r.abandoned = true;
          resolve(missing);
        }, waitMs);
        void r.done.then((b) => {
          clearTimeout(timer);
          resolve(b);
        });
      });
    },
  };
}
