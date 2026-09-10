// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialState, type Ctx } from '../src/ui/context';
import { renderMetrics } from '../src/ui/screens/metrics';

afterEach(() => vi.unstubAllGlobals());
function context(admin: boolean): Ctx {
  const state = initialState();
  state.identity = {kind:'internal',participantId:'protected-pid',name:'Fixture',email: admin ? 'ljang@andrew.cmu.edu' : 'fixture@example.test',consent:{version:'fixture',accepted_at:'now'}};
  state.reviewKey='fixture-key';
  return { state, actions:{ reviewerPid:()=> 'protected-pid', goto:vi.fn() } } as unknown as Ctx;
}
describe('PC metrics workspace', () => {
  it('loads cloud task totals and all admin quality panels from the PC API', async () => {
    const calls: string[]=[];
    vi.stubGlobal('fetch', vi.fn(async (url:string) => { calls.push(url); return {ok:true,json:async()=>url.endsWith('/contributions') ? {submitted:7,reviewed:3} : url.endsWith('/status') ? {claimable:1,finished:3,approved:2,rejected:1,reviewers:[]} : {items:[],users:[],reviewers:[],total:0,truncated:false}}; }));
    const root=renderMetrics(context(true));
    await vi.waitFor(()=>expect(root.textContent).toContain('Author quality'));
    expect(root.textContent).toContain('Reviewer quality');
    expect(root.textContent).toContain('tasks reviewed by you');
    expect(root.querySelector('[aria-label="Your contributions"]')?.textContent).toContain('7');
    expect(root.querySelector('[aria-label="Search team submissions"]')).not.toBeNull();
    expect(root.querySelector('[aria-label="Admin views"]')?.textContent).toContain('Showcase');
    expect(calls.every(url=>url.startsWith('https://t1ynh195m1.execute-api.us-east-1.amazonaws.com/'))).toBe(true);
  });
  it('does not request admin data for an annotator', async () => {
    const calls: string[]=[];
    vi.stubGlobal('fetch', vi.fn(async (url:string)=> {calls.push(url); return {ok:true,json:async()=>url.endsWith('/contributions') ? {submitted:2,reviewed:1} : {claimable:3,awaiting_live_audit:4,locked:5,finished:20,approved:17,rejected:3,reviewers:[{reviewer:'Private Reviewer',approved:9,rejected:1}]}};}));
    const root=renderMetrics(context(false));
    await vi.waitFor(()=>expect(root.textContent).toContain('3ready for review'));
    expect(calls).toHaveLength(2);
    expect(calls.some(url=>url.endsWith('/admin'))).toBe(false);
    expect(root.textContent).toContain('3ready for review');
    expect(root.textContent).toContain('5being reviewed now');
    expect(root.textContent).not.toContain('17approved');
    expect(root.textContent).not.toContain('Private Reviewer');
  });
  it('shows the key entry form before loading metrics', () => {
    const c=context(true); c.state.reviewKey=null;
    expect(renderMetrics(c).textContent).toContain('Connect review tools');
  });
});
