// Метрика для линии эталона: доля озвученного времени песни, которая на графике шириной width
// попадает в части короче limit px («точки» и «чёрточки» вместо линии). Часть — то же, что
// рисует referencePath: кадры подряд без паузы и без скачка от JUMP полутона.
import { JUMP, displayCurve, stageSpan } from "../src/lib/ui/reference-line";

export type Ref = { hop_ms: number; duration_s: number; f0_midi: (number | null)[]; phrases: { start_s: number; end_s: number }[] };

export function shortShare(song: Ref, width: number, mode: "before" | "after", limit = 14) {
  const hop = song.hop_ms / 1000;
  const span = mode === "before" ? 9 : stageSpan(width);
  const curve = mode === "before" ? song.f0_midi : displayCurve(song.f0_midi, hop, song.phrases);
  const pxPerFrame = (width / span) * hop;
  let voiced = 0;
  let short = 0;
  let i = 0;
  while (i < curve.length) {
    if (curve[i] === null) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < curve.length && curve[j] !== null && Math.abs(curve[j]! - curve[j - 1]!) < JUMP) j++;
    // Время исходного голоса в части; длина части на экране — от начала первого кадра до конца последнего.
    let own = 0;
    for (let k = i; k < j; k++) if (song.f0_midi[k] !== null) own++;
    voiced += own;
    if ((j - i) * pxPerFrame < limit) short += own;
    i = j;
  }
  return voiced ? short / voiced : 0;
}
