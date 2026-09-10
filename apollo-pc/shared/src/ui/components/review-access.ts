import { reviewStatus } from '../../review-client';
import type { Ctx } from '../context';
import { el } from './helpers';

export function renderReviewAccess(ctx: Ctx): HTMLElement {
  const key = el('input', { class: 'field-input', type: 'password', autocomplete: 'off', 'aria-label': 'Team review key', placeholder: 'Team review key' }) as HTMLInputElement;
  const status = el('p', { class: 'field-error', role: 'status' });
  const submit = el('button', { class: 'btn primary', type: 'submit' }, 'Enable reviewing') as HTMLButtonElement;
  return el('form', { class: 'card review-access-form', onsubmit: async (event: Event) => {
    event.preventDefault();
    const candidate = key.value.trim();
    if (!candidate) { status.textContent = 'Enter the team review key.'; return; }
    submit.disabled = true;
    status.textContent = 'Checking access…';
    try {
      await reviewStatus(candidate, ctx.actions.reviewerPid() || undefined);
      key.value = '';
      ctx.actions.setReviewKey(candidate);
    } catch {
      status.textContent = 'That review key was not accepted. Check the key and your connection.';
      submit.disabled = false;
    }
  } }, el('h3', null, 'Connect review tools'), el('p', { class: 'muted' }, 'Enter the internal team key once on this device to access task feedback, review, and grading. The key is saved locally.'), key, status, submit);
}
