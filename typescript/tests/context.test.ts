import { describe, expect, it, vi } from 'vitest';

import { AudioContextLifecycle } from '../src/index.js';

describe('AudioContextLifecycle', () => {
  it('waits for activation, owns one context, and deduplicates resume attempts', async () => {
    let resolveResume: (() => void) | undefined;
    const context = {
      state: 'suspended',
      resume: vi.fn(() => new Promise<void>((resolve) => (resolveResume = resolve))),
    };
    const createContext = vi.fn(() => context);
    const lifecycle = new AudioContextLifecycle({ createContext });

    expect(lifecycle.acquire({ hasBeenActive: false })).toBeNull();
    expect(createContext).not.toHaveBeenCalled();
    expect(lifecycle.acquire({ hasBeenActive: true })).toBe(context);
    expect(lifecycle.acquire({ hasBeenActive: true })).toBe(context);
    expect(context.resume).toHaveBeenCalledTimes(1);
    resolveResume?.();
    await Promise.resolve();
  });

  it('recreates a closed context and closes the owned context on teardown', async () => {
    const first = { state: 'closed', resume: vi.fn(() => Promise.resolve()) };
    const close = vi.fn(() => Promise.resolve());
    const second = {
      state: 'running',
      resume: vi.fn(() => Promise.resolve()),
      close,
    };
    const createContext = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const lifecycle = new AudioContextLifecycle({ createContext });

    expect(lifecycle.acquire()).toBe(first);
    expect(lifecycle.current).toBeNull();
    expect(lifecycle.acquire()).toBe(second);
    await lifecycle.close();
    expect(close).toHaveBeenCalledOnce();
    expect(lifecycle.current).toBeNull();
  });

  it('reports resume failures and retries on a later acquire', async () => {
    const error = new Error('interrupted');
    const context = {
      state: 'interrupted',
      resume: vi.fn().mockRejectedValue(error),
    };
    const onResumeError = vi.fn();
    const lifecycle = new AudioContextLifecycle({
      createContext: () => context,
      onResumeError,
    });

    lifecycle.acquire();
    await vi.waitFor(() => {
      expect(onResumeError).toHaveBeenCalledWith(error, context);
    });
    await vi.waitFor(() => {
      lifecycle.acquire();
      expect(context.resume).toHaveBeenCalledTimes(2);
    });
  });
});
