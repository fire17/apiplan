import {appendFileSync,statSync,renameSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {accountDir,type Account} from './accounts.ts';

export function classifyError(error:any){const text=String(error?.message||error);let code='OPERATION_FAILED',retryable=false,action='Inspect the operation receipt and current browser state.';
 if(error?.status===401||/sign in|(?:^|HTTP |returned |status[: ]+)401\b|login|authenticated/i.test(text)){code='AUTH_REQUIRED';action='Open the account browser and sign in; then retry.';}
 else if(/(?:^|HTTP |returned |status[: ]+)403\b|unusual activity|captcha|challenge/i.test(text)){code='SITE_CHECK_REQUIRED';action='Inspect the browser and complete the site check manually. Do not replay writes.';}
 else if(/(?:^|HTTP |returned |status[: ]+)429\b|rate.limit|too many requests/i.test(text)){code='RATE_LIMITED';retryable=true;action='Wait for the reported reset/retry-after before retrying safe reads.';}
 else if(/^\s*5\d\d\b|(?:HTTP|returned|status)\s*5\d\d\b|network|connect|socket/i.test(text)){code='UPSTREAM_UNAVAILABLE';retryable=true;action='Check connectivity and browser health. Retry reads only.';}
 else if(/control|picker|selector|pagination|missing.*route|Unrecognized/i.test(text)){code='SITE_DRIFT';action='Capture a fresh UI/capability map, validate an adapter revision and hot-promote it.';}
 else if(/timed out|timeout|without a completion|outcome unknown|unknown outcome/i.test(text)){code='OUTCOME_UNKNOWN';action='Inspect the existing conversation/download before retrying. Writes may have completed.';}
 else if(/different user|identity|account/i.test(text)){code='ACCOUNT_MISMATCH';action='Select or create the correct isolated account profile.';}
 if(typeof error?.code==='string'&&(/^(?:QUEUE_[A-Z_]+|ACCOUNT_IDENTITY_REQUIRED|NEEDS_RECONCILIATION)$/.test(error.code))){code=error.code;retryable=false;action=error.action||'Inspect queue status and the matching receipt. Resolve the reported queue condition before explicitly running it.';}
 if(typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,80}$/.test(error.code)&&typeof error?.action==='string'){code=error.code;action=error.action;retryable=error.retryable===true;}
 return {code,message:text.replace(/Bearer\s+\S+/gi,'Bearer [redacted]').replace(/https?:\/\/\S+/g,u=>{try{const x=new URL(u);return x.origin+x.pathname;}catch{return '[url]';}}),retryable,action};
}
export function recordEvent(a:Account,event:any){const path=join(accountDir(a),'events.jsonl');try{if(existsSync(path)&&statSync(path).size>8*1024*1024)renameSync(path,path+'.1');appendFileSync(path,JSON.stringify({time:new Date().toISOString(),account:a.id,...event})+'\n',{mode:0o600});}catch{/* logging never turns success into a failed write */}}
