// Worker детектора: получает окна из AudioWorklet и отдаёт кадры высоты основному потоку.
// Основной поток включает замер ноты певца на проверке микрофона и выключает его с началом попытки.
// Детектор решает кадр с задержкой в несколько окон (pitch.ts, VOICING.delay): время кадра — его
// собственное, поэтому кадры приходят на 30 мс позже, но на своих местах шкалы. В конце записи
// основной поток просит flush: последние кадры решаются по уже видимым окнам и отдаются сразу,
// затем приходит { kind: "flushed" }. Каждое окно даёт ровно один кадр.
import { createPitchTracker } from "./pitch";

let track: ReturnType<typeof createPitchTracker> | null = null;

type Command = { port: MessagePort; sampleRate: number } | { kind: "measure"; on: boolean } | { kind: "flush" };

self.onmessage = ({ data }: MessageEvent<Command>) => {
  const post = (message: unknown) => (self as unknown as Worker).postMessage(message);
  if ("kind" in data) {
    if (data.kind === "measure") track?.measure(data.on);
    else {
      for (const { ready: _, ...frame } of track?.flush() ?? []) post(frame);
      post({ kind: "flushed" });
    }
    return;
  }
  const tracker = createPitchTracker(data.sampleRate);
  track = tracker;
  data.port.onmessage = ({ data: w }: MessageEvent<{ time: number; data: Float32Array }>) => {
    const { ready, ...frame } = tracker(w.data, w.time);
    if (ready) post(frame);
  };
};
