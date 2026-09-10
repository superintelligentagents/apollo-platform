// Local-only visual fixture. Run before browser QA; remove the generated HTML afterwards.
import { writeFile } from "node:fs/promises";

const path = new URL("../../apollo-pc/web/pc-discovery-qa.html", import.meta.url);
await writeFile(path, `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>PC discovery QA</title></head><body><main id="app"></main><script type="module">
import '../shared/src/styles.css';import './src/site.css';
import {initialState} from '../shared/src/ui/context.ts';import {renderTasks} from '../shared/src/ui/screens/tasks.ts';
const state=initialState();state.identity={kind:'internal',participantId:'fixture',name:'Synthetic Annotator',email:'fixture@example.test',consent:{version:'fixture',accepted_at:'2026-09-10'}};
const mail=(id,from,subject,snippet)=>({id,source:'email',sourceDetail:'eml',timestamp:'2026-09-08T12:00:00Z',searchText:(from+' '+subject+' '+snippet).toLowerCase(),messageId:id,from:{name:from,email:'updates@'+from.toLowerCase().replace(/[^a-z]/g,'')+'.com'},to:[],cc:[],subject,snippet,bodyRef:false,bodyTruncated:false,labels:[],hasListUnsubscribe:false,attachments:[]});
const records=[mail('flight','Delta','Flight itinerary to New York','JFK departure, one checked bag'),mail('dinner','OpenTable','Dinner reservation','Table for four on Friday'),mail('project','Asana','Project deadline','Sprint issue needs an owner'),{id:'resume',source:'documents',sourceDetail:'document-pdf',timestamp:'2026-09-09T12:00:00Z',searchText:'resume product manager experience skills',filename:'resume.pdf',title:'Resume',mimeType:'application/pdf',size:4000,text:'Product manager experience, education, and skills.',pageCount:2,bodyTruncated:false}];
state.records=new Map(records.map(record=>[record.id,record]));const root=document.getElementById('app');
const ctx={state,rerender(){draw()},actions:{isIncluded:()=>true,startRecommendedTask:()=>{},startTask:()=>{},goto:()=>{},editTask:()=>{},deleteTask:()=>{}}};function draw(){root.replaceChildren(renderTasks(ctx))}draw();
</script></body></html>`);
console.log(path.pathname);
