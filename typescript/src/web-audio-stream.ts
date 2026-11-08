import type { AudioOutputChannelConfig } from "./output.js";
import { clampAudioLevel } from "./policy.js";
import {
  emitAudioTelemetry,
  type AudioOutputTelemetryEvent,
  type AudioStreamTelemetryEvent,
  type AudioTelemetrySink,
} from "./telemetry.js";
import { nonNegativeFinite } from "./validation.js";
import {
  WebAudioOutput,
  type AudioOutputConnection,
  type WebAudioOutputOptions,
} from "./web-audio.js";

export interface WebAudioStreamControllerOptions<Channel extends string>
  extends Omit<WebAudioOutputOptions<Channel>, "telemetry"> {
  readonly channel: Channel;
  readonly defaultCrossfadeMs?: number;
  readonly readyTimeoutMs?: number;
  readonly telemetry?: AudioTelemetrySink<
    AudioOutputTelemetryEvent<Channel> | AudioStreamTelemetryEvent<Channel>
  >;
}

export interface WebAudioStreamReplaceOptions {
  readonly autoplay?: boolean;
  readonly crossfadeMs?: number;
  readonly level?: number;
  readonly readyTimeoutMs?: number;
}

interface ActiveStream<Channel extends string> {
  readonly element: HTMLMediaElement;
  readonly connection: AudioOutputConnection<Channel>;
  readonly level: number;
}

interface PendingStream<Channel extends string> {
  readonly timer: ReturnType<typeof globalThis.setTimeout>;
  readonly connection: AudioOutputConnection<Channel>;
}

/** Owns one logical music/radio stream with safe replacement and optional crossfade overlap. */
export class WebAudioStreamController<Channel extends string> {
  readonly #output: WebAudioOutput<Channel>;
  readonly #channel: Channel;
  readonly #defaultCrossfadeMs: number;
  readonly #readyTimeoutMs: number;
  readonly #telemetry:
    | AudioTelemetrySink<
        AudioOutputTelemetryEvent<Channel> | AudioStreamTelemetryEvent<Channel>
      >
    | undefined;
  readonly #pending = new Map<HTMLMediaElement, PendingStream<Channel>>();
  #replacementQueue: Promise<void> = Promise.resolve();
  #readinessAbort: AbortController | null = null;
  #current: ActiveStream<Channel> | null = null;
  #resumeAfterVisibility = false;
  #disposed = false;

  constructor(
    context: AudioContext,
    options: WebAudioStreamControllerOptions<Channel>,
  ) {
    this.#channel = options.channel;
    this.#telemetry = options.telemetry;
    this.#defaultCrossfadeMs = nonNegativeFinite(
      options.defaultCrossfadeMs ?? 0,
      "defaultCrossfadeMs",
    );
    this.#readyTimeoutMs = nonNegativeFinite(
      options.readyTimeoutMs ?? 10_000,
      "readyTimeoutMs",
    );
    this.#output = new WebAudioOutput(
      context,
      {
        mode: "multi-channel",
        channels: {
          [options.channel]: { maxVoices: 2, overflow: "stop-oldest" },
        } as Record<Channel, AudioOutputChannelConfig>,
      },
      options,
    );
  }

  get output(): WebAudioOutput<Channel> {
    return this.#output;
  }

  get currentElement(): HTMLMediaElement | null {
    return this.#current?.element ?? null;
  }

  replace(
    element: HTMLMediaElement,
    options: WebAudioStreamReplaceOptions = {},
  ): Promise<boolean> {
    this.#assertActive();
    const level = clampAudioLevel(options.level ?? 1);
    const crossfadeMs = nonNegativeFinite(
      options.crossfadeMs ?? this.#defaultCrossfadeMs,
      "crossfadeMs",
    );
    const readyTimeoutMs = nonNegativeFinite(
      options.readyTimeoutMs ?? this.#readyTimeoutMs,
      "readyTimeoutMs",
    );
    const autoplay = options.autoplay ?? true;
    const replacement = this.#replacementQueue.then(() =>
      this.#replaceNow(element, level, crossfadeMs, readyTimeoutMs, autoplay),
    );
    this.#replacementQueue = replacement.then(
      () => undefined,
      () => undefined,
    );
    return replacement;
  }

  async #replaceNow(
    element: HTMLMediaElement,
    level: number,
    crossfadeMs: number,
    readyTimeoutMs: number,
    autoplay: boolean,
  ): Promise<boolean> {
    if (this.#disposed) return this.#replaceFailed("disposed");
    if (this.#current?.element === element) {
      this.#current.connection.setLevel(level, crossfadeMs);
      if (!autoplay) return true;
      const started = await playMedia(element);
      if (started && this.#hasBeenDisposed()) element.pause();
      if (!started) return this.#replaceFailed("autoplay");
      if (this.#hasBeenDisposed()) return this.#replaceFailed("disposed");
      return true;
    }

    this.#cancelPending(element);
    const previous = this.#current;
    const readinessAbort = new AbortController();
    this.#readinessAbort = readinessAbort;
    const ready = await waitForMedia(
      element,
      readyTimeoutMs,
      readinessAbort.signal,
    );
    if (this.#readinessAbort === readinessAbort) this.#readinessAbort = null;
    if (!ready)
      return this.#replaceFailed(
        this.#hasBeenDisposed() ? "disposed" : "not-ready",
      );
    if (this.#hasBeenDisposed()) return this.#replaceFailed("disposed");
    const initialLevel = previous === null || crossfadeMs === 0 ? level : 0;
    const connection = this.#output.connectMediaElement(element, {
      channel: this.#channel,
      level: initialLevel,
    });
    if (connection === null) return this.#replaceFailed("capacity");
    if (autoplay) {
      const started = await playMedia(element);
      if (!started || this.#hasBeenDisposed()) {
        connection.disconnect();
        if (started) element.pause();
        return this.#replaceFailed(
          this.#hasBeenDisposed() ? "disposed" : "autoplay",
        );
      }
    }

    this.#current = { element, connection, level };
    this.#resumeAfterVisibility = false;
    emitAudioTelemetry(this.#telemetry, {
      type: "stream.replaced",
      channel: this.#channel,
      crossfadeMs: previous === null ? 0 : crossfadeMs,
    });
    if (previous === null) return true;
    if (crossfadeMs === 0) {
      previous.connection.disconnect();
      previous.element.pause();
      return true;
    }

    connection.setLevel(level, crossfadeMs);
    previous.connection.setLevel(0, crossfadeMs);
    const timer = globalThis.setTimeout(() => {
      this.#pending.delete(previous.element);
      previous.connection.disconnect();
      if (this.#current?.element !== previous.element) previous.element.pause();
    }, crossfadeMs);
    this.#pending.set(previous.element, {
      timer,
      connection: previous.connection,
    });
    return true;
  }

  suspend(): void {
    this.#assertActive();
    const element = this.#current?.element;
    if (element === undefined) return;
    this.#resumeAfterVisibility ||= !element.paused;
    element.pause();
    emitAudioTelemetry(this.#telemetry, {
      type: "stream.suspended",
      channel: this.#channel,
    });
  }

  async resume(): Promise<boolean> {
    this.#assertActive();
    const element = this.#current?.element;
    if (element === undefined || !this.#resumeAfterVisibility) return true;
    const resumed = await playMedia(element);
    if (this.#hasBeenDisposed() || this.#current?.element !== element) {
      if (resumed && this.#hasBeenDisposed()) element.pause();
      return false;
    }
    if (resumed) {
      this.#resumeAfterVisibility = false;
      emitAudioTelemetry(this.#telemetry, {
        type: "stream.resumed",
        channel: this.#channel,
      });
    } else {
      emitAudioTelemetry(this.#telemetry, {
        type: "stream.resume-failed",
        channel: this.#channel,
      });
    }
    return resumed;
  }

  async setVisibility(visibilityState: string): Promise<boolean> {
    if (visibilityState !== "visible") {
      this.suspend();
      return true;
    }
    return this.resume();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#readinessAbort?.abort();
    this.#readinessAbort = null;
    for (const [element, pending] of this.#pending) {
      globalThis.clearTimeout(pending.timer);
      pending.connection.disconnect();
      element.pause();
    }
    this.#pending.clear();
    this.#current?.connection.disconnect();
    this.#current?.element.pause();
    this.#current = null;
    this.#output.dispose();
  }

  #cancelPending(element: HTMLMediaElement): void {
    const pending = this.#pending.get(element);
    if (pending === undefined) return;
    globalThis.clearTimeout(pending.timer);
    pending.connection.disconnect();
    this.#pending.delete(element);
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error("audio stream controller is disposed");
  }

  #hasBeenDisposed(): boolean {
    return this.#disposed;
  }

  #replaceFailed(
    reason: Extract<
      AudioStreamTelemetryEvent<Channel>,
      { type: "stream.replace-failed" }
    >["reason"],
  ): false {
    emitAudioTelemetry(this.#telemetry, {
      type: "stream.replace-failed",
      channel: this.#channel,
      reason,
    });
    return false;
  }
}

async function playMedia(element: HTMLMediaElement): Promise<boolean> {
  try {
    await element.play();
    return true;
  } catch {
    return false;
  }
}

async function waitForMedia(
  element: HTMLMediaElement,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  if (element.readyState >= 3) return true;
  if (timeoutMs === 0 || signal.aborted) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timer);
      element.removeEventListener("canplay", onCanPlay);
      element.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      resolve(ready);
    };
    const onCanPlay = (): void => {
      finish(true);
    };
    const onError = (): void => {
      finish(false);
    };
    const onAbort = (): void => {
      finish(false);
    };
    const timer = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
    element.addEventListener("canplay", onCanPlay, { once: true });
    element.addEventListener("error", onError, { once: true });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
