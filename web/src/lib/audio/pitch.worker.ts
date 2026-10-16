// Worker детектора: получает окна из AudioWorklet и отдаёт кадры высоты основному потоку.
import { createPitchTracker } from "./pitch";

self.onmessage = ({ data }: MessageEvent<{ port: MessagePort; sampleRate: number }>) => {
  const track = createPitchTracker(data.sampleRate);
  data.port.onmessage = ({ data: w }: MessageEvent<{ time: number; data: Float32Array }>) => {
    (self as unknown as Worker).postMessage({ time: w.time, ...track(w.data) });
  };
};
