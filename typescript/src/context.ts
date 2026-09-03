import { audioActivationAllowsPlayback } from "./policy.js";
import {
  emitAudioTelemetry,
  type AudioContextTelemetryEvent,
  type AudioTelemetrySink,
} from "./telemetry.js";

export interface RecoverableAudioContext {
  readonly state: string;
  resume(): Promise<unknown>;
  close?(): Promise<unknown>;
}

export interface AudioContextLifecycleOptions<
  Context extends RecoverableAudioContext,
> {
  readonly createContext: () => Context | null;
  readonly onResumeError?: (error: unknown, context: Context) => void;
  readonly telemetry?: AudioTelemetrySink<AudioContextTelemetryEvent>;
}

/** Owns one recoverable context without depending on browser globals. */
export class AudioContextLifecycle<Context extends RecoverableAudioContext> {
  readonly #createContext: () => Context | null;
  readonly #onResumeError:
    | ((error: unknown, context: Context) => void)
    | undefined;
  readonly #telemetry:
    | AudioTelemetrySink<AudioContextTelemetryEvent>
    | undefined;
  #context: Context | null = null;
  #resume: Promise<void> | null = null;

  constructor(options: AudioContextLifecycleOptions<Context>) {
    this.#createContext = options.createContext;
    this.#onResumeError = options.onResumeError;
    this.#telemetry = options.telemetry;
  }

  get current(): Context | null {
    return this.#context?.state === "closed" ? null : this.#context;
  }

  acquire(activation?: { readonly hasBeenActive: boolean }): Context | null {
    if (!audioActivationAllowsPlayback(activation)) return null;
    if (this.#context?.state === "closed") {
      this.#context = null;
      this.#resume = null;
    }
    if (this.#context === null) {
      this.#context = this.#createContext();
      if (this.#context !== null) {
        emitAudioTelemetry(this.#telemetry, { type: "context.created" });
      }
    }
    const context = this.#context;
    if (context === null) return null;
    if (
      context.state !== "running" &&
      context.state !== "closed" &&
      this.#resume === null
    ) {
      emitAudioTelemetry(this.#telemetry, { type: "context.resume-requested" });
      const resume = context.resume().then(
        () => {
          emitAudioTelemetry(this.#telemetry, { type: "context.resumed" });
        },
        (error: unknown) => {
          try {
            this.#onResumeError?.(error, context);
          } catch {
            // A diagnostic callback must not break context recovery.
          }
          emitAudioTelemetry(this.#telemetry, {
            type: "context.resume-failed",
          });
        },
      );
      this.#resume = resume;
      void resume.finally(() => {
        if (this.#resume === resume) this.#resume = null;
      });
    }
    return context;
  }

  /** Forget a context after external teardown or recreation. */
  clear(context?: Context): void {
    if (context !== undefined && context !== this.#context) return;
    this.#context = null;
    this.#resume = null;
  }

  async close(): Promise<void> {
    const context = this.#context;
    this.clear();
    if (context?.state !== "closed") await context?.close?.();
    if (context !== null)
      emitAudioTelemetry(this.#telemetry, { type: "context.closed" });
  }
}
