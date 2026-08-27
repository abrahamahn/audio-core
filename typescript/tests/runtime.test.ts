import { describe, expect, it, vi } from "vitest";

import {
  AudioCueRuntime,
  CueScheduler,
  planAudioSequence,
  type StoppableAudioVoice,
} from "../src/index.js";

interface TestVoice extends StoppableAudioVoice {
  readonly stopSpy: ReturnType<typeof vi.fn<() => void>>;
}

function voice(): TestVoice {
  const stopSpy = vi.fn<() => void>();
  return {
    stop: () => {
      stopSpy();
    },
    stopSpy,
  };
}

describe("planAudioSequence", () => {
  it("creates ordered absolute cue plans", () => {
    const scheduler = new CueScheduler<"deal" | "result">();
    const plans = planAudioSequence(
      scheduler,
      [
        {
          request: { cue: "deal", bus: "game-foley", priority: "material" },
          offsetMs: 0,
        },
        {
          request: { cue: "result", bus: "game-foley", priority: "important" },
          offsetMs: 450,
        },
      ],
      1_000,
    );
    expect(plans.map(({ dueAtMs }) => dueAtMs)).toEqual([1_000, 1_450]);
  });

  it("rejects negative or unordered offsets", () => {
    const scheduler = new CueScheduler<"cue">();
    const request = { cue: "cue", bus: "ui", priority: "normal" } as const;
    expect(() =>
      planAudioSequence(
        scheduler,
        [
          { request, offsetMs: 10 },
          { request, offsetMs: 5 },
        ],
        0,
      ),
    ).toThrow(/ordered/u);
  });
});

describe("AudioCueRuntime", () => {
  it("reports started, unavailable, dropped, and cancellation decisions", () => {
    const scheduler = new CueScheduler<"alert">();
    const events: string[] = [];
    const runtime = new AudioCueRuntime<"alert", TestVoice>(scheduler, {
      telemetry: (event) => events.push(event.type),
    });
    const unavailable = scheduler.plan(
      { cue: "alert", bus: "ui", priority: "important", eventId: "alert:1" },
      10,
    );
    expect(runtime.dispatch(unavailable, 10, () => null).status).toBe(
      "unavailable",
    );
    expect(runtime.dispatch(unavailable, 10, voice).status).toBe("started");
    expect(runtime.dispatch(unavailable, 10, voice).status).toBe("drop");
    runtime.cancelGroup("round:1");
    expect(events).toEqual([
      "cue.dropped",
      "cue.started",
      "cue.dropped",
      "cue.group-cancelled",
    ]);
  });

  it("cancels active voices with their scheduler group", () => {
    const scheduler = new CueScheduler<"deal">();
    const runtime = new AudioCueRuntime<"deal", TestVoice>(scheduler);
    const planned = scheduler.plan(
      {
        cue: "deal",
        bus: "game-foley",
        priority: "material",
        cancellationGroup: "round:4",
      },
      100,
    );
    const first = voice();
    const result = runtime.dispatch(planned, 100, () => first);
    expect(result.status).toBe("started");
    expect(runtime.activeVoiceCount("round:4")).toBe(1);
    expect(runtime.cancelGroup("round:4")).toBe(1);
    expect(first.stopSpy).toHaveBeenCalledOnce();
    expect(runtime.dispatch(planned, 101, () => voice())).toMatchObject({
      status: "drop",
      reason: "cancelled",
    });
  });

  it("does not consume an event ID when the renderer is unavailable", () => {
    const scheduler = new CueScheduler<"alert">();
    const runtime = new AudioCueRuntime<"alert", TestVoice>(scheduler);
    const planned = scheduler.plan(
      {
        cue: "alert",
        bus: "ui",
        priority: "important",
        eventId: "alert:7",
      },
      50,
    );
    expect(runtime.dispatch(planned, 50, () => null).status).toBe(
      "unavailable",
    );
    expect(runtime.dispatch(planned, 50, voice).status).toBe("started");
  });

  it("removes completed voices without stopping them", () => {
    const scheduler = new CueScheduler<"music">();
    const runtime = new AudioCueRuntime<"music", TestVoice>(scheduler);
    const planned = scheduler.plan(
      {
        cue: "music",
        bus: "music",
        priority: "normal",
        cancellationGroup: "scene",
      },
      0,
    );
    const current = voice();
    const result = runtime.dispatch(planned, 0, () => current);
    if (result.status !== "started") throw new Error("voice did not start");
    result.playback.complete();
    expect(runtime.activeVoiceCount()).toBe(0);
    runtime.cancelGroup("scene");
    expect(current.stopSpy).not.toHaveBeenCalled();
  });
});
