// Local-only visual fixture. Run before browser QA, remove the generated HTML afterwards.
import { writeFile } from 'node:fs/promises';
const path = new URL('../../apollo-pc/web/pc-parity-qa.html', import.meta.url);
await writeFile(path, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>PC parity QA (synthetic)</title></head><body><div id="app"></div><script type="module">
import '../shared/src/styles.css';
import './src/site.css';
import { initialState } from '../shared/src/ui/context.ts';
import { renderMyTasks, renderMyTask } from '../shared/src/ui/screens/my-tasks.ts';
import { renderTaskReviewEdit } from '../shared/src/ui/screens/task-review-edit.ts';
import { renderHome } from '../shared/src/ui/screens/home.ts';
const state=initialState(); state.identity={kind:'internal',participantId:'qa',name:'Synthetic Participant',email:'qa@example.test',consent:{version:'fixture',accepted_at:'2026-09-08'}};state.reviewKey='fixture-only';
const items=Array.from({length:24},(_,i)=>({task_id:'task-'+i,sub_key:'source-'+i,title:['Plan a museum visit using my calendar','Reconcile delivery dates from receipts','Find a free evening for dinner'][i%3],request:'Use the selected personal context to produce a plan with evidence for each recommendation.',status:['approved','returned','pending'][i%3],submitted_at:'2026-09-08T12:00:00Z',content_hash:'fixture',needs_signoff:i%3===0}));
const task={title:items[0].title,request:items[0].request,difficulty:'high',criteria:['Cite the relevant context.'],steps:[{order:0,title:'Check calendar',description:'Identify a free afternoon from the supplied calendar.'},{order:1,title:'Compare options',description:'Choose an open museum that fits the available time.'}],must_visit_or_reach:[],required_outputs:['A plan with sources'],notes:null};
window.fetch=async (url,init)=>{const body=JSON.parse(init.body); const value=String(url).endsWith('/my-tasks')?{items,offset:0,limit:200,source_total:24,approved_total:8,awaiting_signoff_total:8}:String(url).endsWith('/my-task-feedback')?{status:'approved',stale:false,review:null,task,final_task:task,needs_signoff:true,human_review:{original:{...task,request:'Plan a museum visit.'},final:task,rubrics:[],title_edited:false,request_edited:true,evergreen_verified:true},history:[{event:'approved',at:'2026-09-08',by:'',minutes:null,note:''}]}:{status:'not_reviewed',review:null};return {ok:true,json:async()=>value};};
const root=document.getElementById('app'); const storage={get:async()=>null,set:async()=>{}};
const ctx={state,adapter:{storage},actions:{goto(screen){draw(screen)},isIncluded:()=>true,reviewerName:()=> 'Synthetic reviewer',reviewerPid:()=> 'qa-reviewer',notifyInfo:()=>{},notifyError:()=>{},endReview:()=>draw('my-tasks')}};
state.reviewClaim={subKey:'fixture',token:'fixture',claimedAtMs:Date.now(),lockTtlMs:1800000,task:{task_id:'fixture',task:{...task,task_title:task.title,agent_request:task.request,success_criteria:task.criteria}}};
function draw(screen){root.replaceChildren(); const nav=document.createElement('nav');nav.className='topbar'; for(const [label,dest] of [['Dashboard','home'],['My tasks','my-tasks'],['Review','review']]){const b=document.createElement('button');b.className='btn ghost';b.textContent=label;b.onclick=()=>draw(dest);nav.append(b)}root.append(nav,screen==='home'?renderHome(ctx):screen==='review'?renderTaskReviewEdit(ctx):screen==='my-task'?renderMyTask(ctx):renderMyTasks(ctx));}draw('my-tasks');
</script></body></html>`);
console.log('Created local PC fixture at '+path.pathname);
