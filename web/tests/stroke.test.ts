// Обводка линии голоса (stroke.ts), общая для сцены и разбора: подряд идущие отрезки одного стиля —
// одна линия, смена стиля и разрыв части начинают новую.
import { describe, expect, it } from "vitest";
import { strokeRuns } from "../src/lib/ui/stroke";

function mock() {
  const calls: string[] = [];
  return {
    calls,
    ctx: {
      beginPath: () => calls.push("begin"),
      moveTo: (x: number) => calls.push(`move ${x}`),
      lineTo: (x: number) => calls.push(`line ${x}`),
      stroke: () => calls.push("stroke"),
    },
  };
}

describe("обводка линии голоса", () => {
  it("один стиль — одна линия через все точки", () => {
    const { ctx, calls } = mock();
    const applied: number[] = [];
    strokeRuns(ctx, 5, (k) => k, () => 0, () => false, () => 0, (s) => applied.push(s));
    expect(calls).toEqual(["begin", "move 0", "line 1", "line 2", "line 3", "line 4", "stroke"]);
    expect(applied).toEqual([0]);
  });

  it("смена стиля начинает новую линию с общей точки; разрыв части — без соединения", () => {
    const { ctx, calls } = mock();
    const styles = [0, 0, 0, 1, 1, 0, 0];
    const x0: number[] = [];
    strokeRuns(ctx, 7, (k) => k, () => 0, (k) => k === 5, (k) => styles[k], (_, x) => x0.push(x));
    expect(calls).toEqual(["begin", "move 0", "line 1", "line 2", "stroke", "begin", "move 2", "line 3", "line 4", "stroke", "begin", "move 5", "line 6", "stroke"]);
    expect(x0).toEqual([0, 2, 5]);
  });

  it("одна точка и пустая линия ничего не рисуют", () => {
    const { ctx, calls } = mock();
    strokeRuns(ctx, 1, (k) => k, () => 0, () => false, () => 0, () => {});
    strokeRuns(ctx, 0, (k) => k, () => 0, () => false, () => 0, () => {});
    expect(calls).toEqual([]);
  });
});
