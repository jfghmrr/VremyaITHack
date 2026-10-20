// Линия голоса певца на графиках (voice-line.ts): только картинка. Лёгкое сглаживание и
// мостики через короткие провалы внутри ноты; настоящие паузы и скачки высоты не соединяются.
import { describe, expect, it } from "vitest";
import { createVoicePath, RIVAL_LINE, VOICE, voiceParts, voicePath } from "../src/lib/ui/voice-line";

type F = { t: number; midi: number | null };
/** Кадры 10 мс: [от, до) секунд с высотой midi (null — пауза). */
function frames(...spans: [number, number, number | null][]): F[] {
  const out: F[] = [];
  for (const [from, to, midi] of spans) for (let t = from; t < to - 1e-9; t += 0.01) out.push({ t: Math.round(t * 100) / 100, midi });
  return out;
}

describe("линия голоса: мостики", () => {
  it("провал распознавания до 80 мс внутри ноты соединяется", () => {
    const parts = voiceParts(frames([0, 0.5, 60], [0.5, 0.56, null], [0.56, 1, 60.2]));
    expect(parts).toHaveLength(1);
    expect(parts[0][0].t).toBe(0);
    expect(parts[0].at(-1)!.t).toBeCloseTo(0.99, 6);
  });

  it("пауза длиннее 80 мс остаётся разрывом: высота через паузу не придумывается", () => {
    const parts = voiceParts(frames([0, 0.5, 60], [0.5, 0.7, null], [0.7, 1, 60]));
    expect(parts).toHaveLength(2);
    expect(parts[0].at(-1)!.t).toBeCloseTo(0.49, 6);
    expect(parts[1][0].t).toBeCloseTo(0.7, 6);
  });

  it("короткий провал, но высота по краям отличается больше чем на 1,5 полутона, — разрыв", () => {
    const parts = voiceParts(frames([0, 0.5, 60], [0.5, 0.55, null], [0.55, 1, 63]));
    expect(parts).toHaveLength(2);
  });

  it("скачок от 5 полутонов между соседними кадрами рвёт линию: без вертикальной иглы", () => {
    const parts = voiceParts(frames([0, 0.3, 60], [0.3, 0.6, 67]));
    expect(parts).toHaveLength(2);
    const small = voiceParts(frames([0, 0.3, 60], [0.3, 0.6, 62]));
    expect(small).toHaveLength(1);
  });

  it("кадры вне окна не рисуются", () => {
    const parts = voiceParts(frames([0, 2, 60]), 0.5, 1);
    expect(parts).toHaveLength(1);
    expect(parts[0][0].t).toBeGreaterThanOrEqual(0.5);
    expect(parts[0].at(-1)!.t).toBeLessThanOrEqual(1);
  });

  it("пустой вход и одни паузы — без линий", () => {
    expect(voiceParts([])).toEqual([]);
    expect(voiceParts(frames([0, 1, null]))).toEqual([]);
  });
});

describe("линия голоса: сглаживание", () => {
  it("одиночный выброс внутри ноты убирается, дрожание приглушается", () => {
    const input = frames([0, 0.5, 60]);
    input[20].midi = 72; // октавная ошибка в одном кадре
    for (let i = 0; i < input.length; i++) if (i !== 20) input[i].midi = 60 + (i % 2 ? 0.1 : -0.1);
    const [part] = voiceParts(input);
    expect(part).toHaveLength(input.length);
    const values = part.map((p) => p.m);
    expect(Math.max(...values)).toBeLessThan(60.2);
    // Дрожание ±0,1 полутона кадр к кадру после сглаживания меньше.
    const jitter = values.slice(2, -2).map((v, i) => Math.abs(v - values[i + 1]));
    expect(Math.max(...jitter)).toBeLessThan(0.1);
  });

  it("смена ноты остаётся резкой: значения по обе стороны скачка не усредняются", () => {
    const [part] = voiceParts(frames([0, 0.3, 60], [0.3, 0.6, 62]));
    const before = part.filter((p) => p.t < 0.3).map((p) => p.m);
    const after = part.filter((p) => p.t >= 0.3).map((p) => p.m);
    expect(before.every((m) => m === 60)).toBe(true);
    expect(after.every((m) => m === 62)).toBe(true);
  });

  it("исходные кадры не меняются", () => {
    const input = frames([0, 0.3, 60], [0.3, 0.33, null], [0.33, 0.5, 61]);
    const copy = JSON.parse(JSON.stringify(input));
    voiceParts(input);
    expect(input).toEqual(copy);
  });
});

describe("линия соперника (кривая 50 мс)", () => {
  const curve = (values: (number | null)[]) => values.map((midi, i) => ({ t: i * 0.05, midi }));
  it("без сглаживания; одна пропущенная точка соединяется, две — нет", () => {
    const one = voiceParts(curve([60, 60.5, null, 61, 61]), -Infinity, Infinity, RIVAL_LINE);
    expect(one).toHaveLength(1);
    expect(one[0].map((p) => p.m)).toEqual([60, 60.5, 61, 61]);
    const two = voiceParts(curve([60, 60, null, null, 60]), -Infinity, Infinity, RIVAL_LINE);
    expect(two).toHaveLength(2);
  });

  it("своя линия: разрыв 80 мс соединяется, 90 мс — нет; соперник: 100 мс соединяется", () => {
    // Крайние кадры кусков отстоят на 80 мс (7 пропущенных кадров) и на 90 мс (8 пропущенных).
    const at = (gapFrames: number) => [...frames([0, 0.3, 60]), ...frames([0.3 + gapFrames * 0.01, 0.6, 60])].map((f) => ({ ...f, t: Math.round(f.t * 100) / 100 }));
    expect(voiceParts(at(7))).toHaveLength(1);
    expect(voiceParts(at(8))).toHaveLength(2);
    expect(VOICE.bridgeS).toBeCloseTo(0.08, 9);
    expect(RIVAL_LINE.bridgeS).toBeCloseTo(0.1, 9);
  });

  it("решение не зависит от округления времени кадров (часы AudioContext)", () => {
    // Те же кадры со временем, накопленным сложением 0.01 (ошибка округления): тот же результат.
    const exact = frames([0, 0.2, 60], [0.2, 0.22, null], [0.22, 0.5, 61]);
    let t = 0;
    const drift = exact.map((f) => ({ ...f, t: (t += 0.01) - 0.01 }));
    const a = voiceParts(exact);
    const b = voiceParts(drift);
    expect(b.map((p) => p.length)).toEqual(a.map((p) => p.length));
    // Пропуск одного кадра — уже мостик с проверкой высоты: скачок 3 полутона через пропуск рвёт линию.
    expect(voiceParts(frames([0, 0.2, 60], [0.2, 0.21, null], [0.21, 0.5, 63]))).toHaveLength(2);
  });
});

describe("линия в переиспользуемых буферах", () => {
  it("voicePath даёт те же точки, что voiceParts, и не теряет точки при росте буфера", () => {
    const input = frames([0, 3, 60], [3, 3.05, null], [3.05, 6, 60.5], [6, 6.5, null], [6.5, 9, 64]);
    const path = voicePath(createVoicePath(4), input);
    const parts = voiceParts(input);
    expect(path.n).toBe(parts.reduce((s, p) => s + p.length, 0));
    let k = 0;
    for (const part of parts)
      part.forEach((q, i) => {
        expect(path.start[k]).toBe(i === 0 ? 1 : 0);
        expect(path.t[k]).toBeCloseTo(q.t, 9);
        expect(path.m[k]).toBeCloseTo(q.m, 9);
        k++;
      });
    // Диапазон индексов вместо копии массива: только кадры окна.
    const window = voicePath(createVoicePath(), input, 100, 200);
    expect(window.n).toBe(100);
    expect(window.t[0]).toBeCloseTo(input[100].t, 9);
  });
});
