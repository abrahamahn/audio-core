import { describe, expect, it } from 'vitest';

import { CueScheduler, type AudioCueRequest } from '../src/index.js';

describe('planned cue scheduling', () => {
  it('plans absolute timing and atomically deduplicates event IDs', () => {
    const scheduler = new CueScheduler<'deal'>({ defaultMinGapMs: 0 });
    const request: AudioCueRequest<'deal'> = {
      cue: 'deal',
      bus: 'game-foley',
      priority: 'material',
      eventId: 'round-4:deal-1',
      scheduledAtMs: 100,
      delayMs: 20,
    };
    const planned = scheduler.plan(request, 90);
    expect(planned.dueAtMs).toBe(120);
    expect(scheduler.inspect(planned, 110)).toEqual({
      status: 'defer',
      dueAtMs: 120,
      waitMs: 10,
    });
    expect(scheduler.commit(planned, 120)).toEqual({
      status: 'ready',
      dueAtMs: 120,
      lateByMs: 0,
    });
    expect(scheduler.commit(planned, 121)).toEqual({
      status: 'drop',
      dueAtMs: 120,
      reason: 'duplicate',
    });
  });

  it('drops cancelled, late, and rate-limited planned cues', () => {
    const scheduler = new CueScheduler<'deal'>({ defaultMinGapMs: 20, maxLateByMs: 10 });
    const request = {
      cue: 'deal',
      bus: 'game-foley',
      priority: 'material',
      scheduledAtMs: 100,
    } as const;
    const planned = scheduler.plan(request, 100);
    expect(scheduler.inspect(planned, 111)).toMatchObject({ status: 'drop', reason: 'late' });

    scheduler.markPlayed('deal', 100);
    expect(scheduler.inspect(planned, 110)).toMatchObject({
      status: 'drop',
      reason: 'rate-limited',
    });

    scheduler.cancelGroup('round');
    const cancelled = scheduler.plan({ ...request, cancellationGroup: 'round' }, 100);
    expect(scheduler.inspect(cancelled, 100)).toMatchObject({
      status: 'drop',
      reason: 'cancelled',
    });
  });

  it('bounds remembered event identities', () => {
    const scheduler = new CueScheduler<'deal' | 'win'>({ maxRememberedEventIds: 1 });
    const first = scheduler.plan(
      { cue: 'deal', bus: 'game-foley', priority: 'material', eventId: 'first' },
      10,
    );
    const second = scheduler.plan(
      { cue: 'win', bus: 'game-foley', priority: 'important', eventId: 'second' },
      20,
    );
    expect(scheduler.commit(first, 10).status).toBe('ready');
    expect(scheduler.commit(second, 20).status).toBe('ready');
    expect(scheduler.inspect(first, 30).status).toBe('ready');
  });

  it('rejects invalid timeline and retention policy', () => {
    expect(() => new CueScheduler({ maxLateByMs: -1 })).toThrow(/maxLateByMs/u);
    expect(() => new CueScheduler({ maxRememberedEventIds: 0 })).toThrow(/maxRememberedEventIds/u);
    const scheduler = new CueScheduler<'cue'>();
    expect(() =>
      scheduler.plan({ cue: 'cue', bus: 'ui', priority: 'normal', delayMs: -1 }, 0),
    ).toThrow(/delayMs/u);
  });
});
