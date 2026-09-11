// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialState, type Ctx } from '../src/ui/context';
import { renderReviewAccess } from '../src/ui/components/review-access';

describe('runtime review access', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('validates against the PC API before storing the key', async () => {
    const fetcher = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetcher);
    const setReviewKey = vi.fn();
    const ctx = { state: initialState(), actions: { setReviewKey, reviewerPid: () => 'protected-participant' } } as unknown as Ctx;
    const form = renderReviewAccess(ctx);
    form.querySelector('input')!.value = 'fixture-key';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(setReviewKey).toHaveBeenCalledWith('fixture-key'));
    expect(fetcher.mock.calls[0][0]).toContain('t1ynh195m1.execute-api.us-east-1.amazonaws.com/review/status');
    expect(form.querySelector('input')!.value).toBe('');
  });
  it('does not save rejected keys and allows retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'denied' }) })));
    const setReviewKey = vi.fn();
    const ctx = { state: initialState(), actions: { setReviewKey, reviewerPid: () => 'protected-participant' } } as unknown as Ctx;
    const form = renderReviewAccess(ctx);
    form.querySelector('input')!.value = 'invalid-key';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.waitFor(() => expect(form.textContent).toContain('not accepted'));
    expect(setReviewKey).not.toHaveBeenCalled();
    expect(form.querySelector('button')!.disabled).toBe(false);
  });
});
