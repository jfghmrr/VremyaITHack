import workletUrl from "./capture.worklet.js?url";
import { createPitchTracker } from "./pitch";
import type { PitchFrame, Recording } from "../types";
export class Capture {
  ctx: AudioContext;
  stream: MediaStream;
  node: AudioWorkletNode;
  source: MediaStreamAudioSourceNode;
  frames: PitchFrame[] = [];
  chunks: { time: number; data: Float32Array }[] = [];
  start = Infinity;
  end = Infinity;
  private constructor(
    ctx: AudioContext,
    stream: MediaStream,
    node: AudioWorkletNode,
    source: MediaStreamAudioSourceNode,
  ) {
    this.ctx = ctx;
    this.stream = stream;
    this.node = node;
    this.source = source;
  }
  static async open(onFrame: (f: PitchFrame) => void, deviceId?: string) {
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error("Микрофон доступен только по HTTPS или на localhost.");
    const ctx = new AudioContext({ latencyHint: "interactive" });
    try {
      await ctx.resume();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
      });
      try {
        await ctx.audioWorklet.addModule(workletUrl);
      } catch (e) {
        stream.getTracks().forEach((t) => t.stop());
        throw e;
      }
      const node = new AudioWorkletNode(ctx, "echo-capture");
      const source = ctx.createMediaStreamSource(stream);
      source.connect(node);
      node.connect(ctx.destination);
      const capture = new Capture(ctx, stream, node, source);
      const detect = createPitchTracker(ctx.sampleRate);
      node.port.onmessage = ({ data }) => {
        if (data.kind === "pitch") {
          const f = { t: data.time - capture.start, ...detect(data.data) };
          onFrame(f);
          if (f.t >= 0 && data.time <= capture.end) capture.frames.push(f);
        } else if (
          data.time + data.data.length / ctx.sampleRate >= capture.start &&
          data.time <= capture.end
        )
          capture.chunks.push(data);
      };
      return capture;
    } catch (e) {
      await ctx.close();
      throw e;
    }
  }
  begin(at: number, duration: number) {
    this.frames = [];
    this.chunks = [];
    this.start = at;
    this.end = at + duration;
  }
  recording(): Recording {
    const samples = new Float32Array(
      Math.ceil((this.end - this.start) * this.ctx.sampleRate),
    );
    for (const chunk of this.chunks) {
      const offset = Math.round(
        (chunk.time - this.start) * this.ctx.sampleRate,
      );
      const from = Math.max(0, -offset);
      const length = Math.min(
        chunk.data.length - from,
        samples.length - Math.max(0, offset),
      );
      if (length > 0)
        samples.set(
          chunk.data.subarray(from, from + length),
          Math.max(0, offset),
        );
    }
    return { samples, sampleRate: this.ctx.sampleRate };
  }
  stop() {
    this.node.port.onmessage = null;
    this.source.disconnect();
    this.node.disconnect();
    this.stream.getTracks().forEach((t) => t.stop());
    void this.ctx.close();
  }
}
