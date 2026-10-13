// Timestamp is the centre of the analysis window, in the AudioContext clock.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ring = new Float32Array(2048);
    this.pos = 0;
    this.total = 0;
    this.since = 0;
    this.hop = Math.round(sampleRate * 0.01);
    this.raw = [];
    this.rawStart = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    if (!this.raw.length) this.rawStart = currentFrame;
    for (let i = 0; i < input.length; i++) {
      this.raw.push(input[i]);
      this.ring[this.pos] = input[i];
      this.pos = (this.pos + 1) % 2048;
      this.total++;
      this.since++;
      if (this.total >= 2048 && this.since >= this.hop) {
        this.since = 0;
        const frame = new Float32Array(2048);
        for (let j = 0; j < 2048; j++)
          frame[j] = this.ring[(this.pos + j) % 2048];
        this.port.postMessage(
          {
            kind: "pitch",
            time: (currentFrame + i + 1 - 1024) / sampleRate,
            data: frame,
          },
          [frame.buffer],
        );
      }
    }
    if (this.raw.length >= 2048) {
      const raw = new Float32Array(this.raw);
      this.port.postMessage(
        { kind: "raw", time: this.rawStart / sampleRate, data: raw },
        [raw.buffer],
      );
      this.raw = [];
    }
    return true;
  }
}
registerProcessor("echo-capture", Capture);
