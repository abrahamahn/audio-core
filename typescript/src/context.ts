import { audioActivationAllowsPlayback } from './policy.js';

export interface RecoverableAudioContext {
  readonly state: string;
  resume(): Promise<unknown>;
  close?(): Promise<unknown>;
}

export interface AudioContextLifecycleOptions<Context extends RecoverableAudioContext> {
  readonly createContext: () => Context | null;
  readonly onResumeError?: (error: unknown, context: Context) => void;
}

/** Owns one recoverable context without depending on browser globals. */
export class AudioContextLifecycle<Context extends RecoverableAudioContext> {
  readonly #createContext: () => Context | null;
  readonly #onResumeError: ((error: unknown, context: Context) => void) | undefined;
  #context: Context | null = null;
  #resume: Promise<void> | null = null;

  constructor(options: AudioContextLifecycleOptions<Context>) {
    this.#createContext = options.createContext;
    this.#onResumeError = options.onResumeError;
  }

  get current(): Context | null {
    return this.#context?.state === 'closed' ? null : this.#context;
  }

  acquire(activation?: { readonly hasBeenActive: boolean }): Context | null {
    if (!audioActivationAllowsPlayback(activation)) return null;
    if (this.#context?.state === 'closed') {
      this.#context = null;
      this.#resume = null;
    }
    this.#context ??= this.#createContext();
    const context = this.#context;
    if (context === null) return null;
    if (context.state !== 'running' && context.state !== 'closed' && this.#resume === null) {
      const resume = context
        .resume()
        .catch((error: unknown) => this.#onResumeError?.(error, context))
        .then(() => undefined);
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
    if (context?.state !== 'closed') await context?.close?.();
  }
}
