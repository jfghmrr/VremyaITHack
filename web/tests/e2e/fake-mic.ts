// Синтетический микрофон: генератор «поёт» эталон песни со сдвигом тональности,
// начиная ровно в момент старта минусовки (длительность буфера = длительность песни).
// Проверяет весь путь AudioWorklet → Worker → WASM, но не качество на реальных голосах.
import type { BrowserContext } from "@playwright/test";
import { readFileSync } from "node:fs";

export interface MicOptions {
  shift?: number;
  /** Ошибка в полутонах на отрезках [from, to) индексов 10-мс сетки. */
  errors?: [number, number, number][];
  silent?: boolean;
  /** «Мычание» одной нотой (MIDI) всю песню без пауз вместо мелодии: античит постоянного тона. */
  hum?: number;
  /** Амплитуда ровного тона до начала песни (проверка микрофона); по умолчанию 0.18. */
  level?: number;
  delay?: number;
  /** Рейтинговый матч выбирает песню на сервере: следуем реально загруженному эталону. */
  followLoadedSong?: boolean;
  /** Сколько раз «певец» начал петь под запущенную минусовку (пишет генератор; читается как window.__mic.starts). */
  starts?: number;
}

export async function fakeMic(context: BrowserContext, song: string, options: MicOptions = {}) {
  const reference = JSON.parse(readFileSync(new URL(`../../static/songs/${song}/reference.json`, import.meta.url), "utf8"));
  await context.addInitScript(
    ({ f0, duration, opts }) => {
      if (opts.followLoadedSong) {
        const fetchOriginal = window.fetch.bind(window);
        window.fetch = async (...args) => {
          const response = await fetchOriginal(...args);
          if (response.ok && /\/songs\/[^/]+\/reference\.json(?:\?|$)/.test(response.url)) {
            const song = await response.clone().json();
            f0 = song.f0_midi;
            duration = song.duration_s;
          }
          return response;
        };
      }
      let input: { ctx: AudioContext; osc: OscillatorNode; gain: GainNode; scheduled: boolean } | null = null;
      let granted = false;
      const w = window as unknown as { __mic: unknown };
      w.__mic = opts;
      const suspend = AudioContext.prototype.suspend;
      const resume = AudioContext.prototype.resume;
      // Пауза основного контекста приостанавливает и «певца».
      AudioContext.prototype.suspend = async function (this: AudioContext) {
        await suspend.call(this);
        if (input && input.ctx !== this && input.scheduled) await suspend.call(input.ctx);
      };
      AudioContext.prototype.resume = async function (this: AudioContext) {
        await resume.call(this);
        if (input && input.ctx !== this && input.scheduled && input.ctx.state === "suspended") await resume.call(input.ctx);
      };
      navigator.mediaDevices.enumerateDevices = async () =>
        ["built-in", "usb-headset"].map(
          (id, i) => ({ kind: "audioinput", deviceId: id, groupId: id, label: granted ? ["Встроенный микрофон", "USB-гарнитура"][i] : "", toJSON() {} }) as MediaDeviceInfo,
        );
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        granted = true;
        const selected = (constraints?.audio as MediaTrackConstraints)?.deviceId as { exact?: string } | undefined;
        if (selected?.exact && !["built-in", "usb-headset"].includes(selected.exact)) throw new DOMException("Missing", "NotFoundError");
        if (input) await input.ctx.close();
        const ctx = new AudioContext();
        await resume.call(ctx);
        const dest = ctx.createMediaStreamDestination();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.frequency.value = 220;
        gain.gain.value = opts.silent ? 0 : (opts.level ?? 0.18);
        osc.connect(gain).connect(dest);
        osc.start();
        input = { ctx, osc, gain, scheduled: false };
        return dest.stream;
      };
      const start = AudioBufferSourceNode.prototype.start;
      AudioBufferSourceNode.prototype.start = function (this: AudioBufferSourceNode, when = 0, offset?: number, ...rest: number[]) {
        // Каждый запуск песни с начала (в том числе «Начать заново» на сцене) — певец поёт заново.
        if (input && this.buffer && Math.abs(this.buffer.duration - duration) < 0.3 && !offset) {
          const f = input;
          f.scheduled = true;
          opts.starts = (opts.starts ?? 0) + 1;
          const base = f.ctx.currentTime + (when - this.context.currentTime) + (opts.delay ?? 0);
          f.gain.gain.cancelScheduledValues(0);
          f.osc.frequency.cancelScheduledValues(0);
          f.gain.gain.setValueAtTime(0, f.ctx.currentTime);
          if (opts.hum !== undefined) {
            f.gain.gain.setValueAtTime(0.22, base);
            f.osc.frequency.setValueAtTime(440 * 2 ** ((opts.hum - 69) / 12), base);
            f.gain.gain.setValueAtTime(0, base + duration);
            return start.call(this, when, offset as number, ...rest);
          }
          f0.forEach((m: number | null, i: number) => {
            const t = base + i * 0.01;
            f.gain.gain.setValueAtTime(m === null || opts.silent ? 0 : 0.22, t);
            if (m !== null) {
              const err = (opts.errors ?? []).find(([a, b]: number[]) => i >= a && i < b)?.[2] ?? 0;
              f.osc.frequency.setValueAtTime(440 * 2 ** ((m + (opts.shift ?? 0) + err - 69) / 12), t);
            }
          });
          f.gain.gain.setValueAtTime(0, base + duration);
        }
        return start.call(this, when, offset as number, ...rest);
      } as typeof AudioBufferSourceNode.prototype.start;
    },
    { f0: reference.f0_midi, duration: reference.duration_s, opts: options },
  );
}
