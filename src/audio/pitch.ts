import { PitchDetector } from "pitchy";
import { AUDIO } from "../config";
export function createPitchTracker(sampleRate: number) {
  const detector = PitchDetector.forFloat32Array(AUDIO.window);
  const history: number[] = [];
  return (data: Float32Array) => {
    const rms = Math.sqrt(data.reduce((s, x) => s + x * x, 0) / data.length);
    const [hz, clarity] = detector.findPitch(data, sampleRate);
    const voiced =
      clarity >= AUDIO.clarity &&
      rms >= AUDIO.rms &&
      hz >= AUDIO.minHz &&
      hz <= AUDIO.maxHz;
    if (!voiced) {
      history.length = 0;
      return { midi: null, clarity, rms };
    }
    history.push(69 + 12 * Math.log2(hz / 440));
    if (history.length > 3) history.shift();
    return {
      midi: [...history].sort((a, b) => a - b)[Math.floor(history.length / 2)],
      clarity,
      rms,
    };
  };
}
