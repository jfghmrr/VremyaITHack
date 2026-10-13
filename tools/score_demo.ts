import { scorePerformance } from "../src/scoring";
import { scenarios, testSong } from "./scenarios";
console.table(
  Object.entries(scenarios()).map(([scenario, frames]) => {
    const r = scorePerformance(frames, testSong);
    return {
      scenario,
      score: r.score,
      intervals: Math.round(r.axes.intervals * 100),
      rhythm: Math.round(r.axes.rhythm * 100),
      stability: Math.round(r.axes.stability * 100),
      coverage: Math.round(r.axes.coverage * 100),
      lag_ms: Math.round(r.lag * 1000),
      shift: r.shift.toFixed(1),
    };
  }),
);
