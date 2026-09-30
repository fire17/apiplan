import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {existsSync} from 'node:fs';

export type InvoiceImportResult={
 source:string;sha256?:string;status:'added'|'duplicate'|'error';file?:string;provider?:string;invoice_no?:string;message?:string;
 /** Diagnosis fields: which step failed, whether a staged item survives it, and whether the ledger may already have moved. */
 stage?:'stage'|'confirm';errorCode?:string;httpStatus?:number;staged?:boolean;stagedId?:string;mutationPossible?:boolean;resumable?:boolean;
};
export type StagedInvoice={id:string;status:string;provider?:string;invoice_no?:string;original?:string;message?:string;stagedAt?:number};
export type InvoiceImportReport={projectPath:string;results:InvoiceImportResult[];added:number;duplicates:number;failed:number;warnings:string[];staged?:StagedInvoice[]};

/** Poppler ships outside the launchd/daemon default PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) on macOS. */
const TOOL_PATHS=['/opt/homebrew/bin','/usr/local/bin','/opt/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'];
/**
 * PATH the importer child runs with, plus where `pdftotext` was found.
 *
 * The existing importer answers every `/api/import*` call with ApiError(503,"tool_missing") when
 * `shutil.which("pdftotext")` misses, so a daemon started by launchd — minimal PATH, no Homebrew —
 * fails every filing while the same import works by hand. The child gets the standard tool
 * directories appended so the daemon and a login shell resolve the same binaries.
 */
export function resolveImportEnv(env:Record<string,string|undefined>=process.env){
 const parts=String(env.PATH||'').split(':').filter(Boolean);
 const PATH=[...parts,...TOOL_PATHS.filter(path=>!parts.includes(path))].join(':');
 return {PATH,pdftotext:Bun.which('pdftotext',{PATH})};
}
function toolMissing(){
 return Object.assign(new Error('pdftotext (poppler) was not found on PATH; the invoice importer cannot read any PDF. Install it with: brew install poppler'),
  {code:'TOOL_MISSING',retryable:false,action:'Install poppler (brew install poppler), then resume filing — the downloaded PDF is kept and nothing needs re-downloading.'});
}

// The existing application's import transaction owns parsing, safe names,
// flock, ledger/tracking atomic writes and README updates. Never run its CLI:
// without explicit arguments that CLI scans Downloads and moves source files.
const BRIDGE=String.raw`
import sys, json, os, hashlib, datetime, importlib.util, contextlib, io
from pathlib import Path
cfg=json.load(sys.stdin)
root=Path(cfg['projectPath']).resolve()
mode=cfg.get('mode') or 'import'
os.environ['INVOICES_ROOT']=str(root)
sys.path.insert(0,str(root/'app'))
spec=importlib.util.spec_from_file_location('chatgpt_invoice_server',root/'app'/'server.py')
s=importlib.util.module_from_spec(spec)
with contextlib.redirect_stdout(io.StringIO()):
    spec.loader.exec_module(s)
s.ROOT=root
s.QUIET=True
today=datetime.date.today()
results=[]
warnings=[]

def describe(exc, stage, staged):
    # Never return server state, PDF text or credentials: only the importer's own short error code,
    # its HTTP status and the step that raised, which is what a human needs to decide what to do.
    if isinstance(exc,ValueError): return str(exc)
    code=getattr(exc,'code',None) or type(exc).__name__
    status=getattr(exc,'status',None)
    detail=type(exc).__name__+' '+str(code)+(' '+str(status) if status else '')
    hint=''
    if code=='tool_missing': hint=' Install poppler (brew install poppler) and resume filing.'
    elif staged: hint=' The PDF stayed staged in the invoice project inbox; resume filing instead of re-downloading.'
    else: hint=' Nothing was staged and the ledger was not touched; resume filing from the downloaded PDF.'
    return 'Existing invoice importer failed during '+stage+' ('+detail+').'+hint

def stage_row(item):
    parsed=item.get('parsed') or {}
    row={'id':item.get('id'),'status':item.get('status')}
    if item.get('provider'): row['provider']=item['provider']
    if parsed.get('invoice_no'): row['invoice_no']=parsed['invoice_no']
    if item.get('original'): row['original']=item['original']
    if item.get('message'): row['message']=item['message']
    return row

def confirm(staged_id):
    # Only 412 means no mutation occurred: rebase and retry that conflict.
    # Other exceptions may follow a commit and must not be auto-replayed.
    for attempt in range(3):
        state=s.model.build_state(root,today)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                return s.import_confirm({'ids':[staged_id], 'copy':True, 'etags':{'tracking':state['etags']['tracking']}},{'If-Match':state['etags']['invoices']},today)
        except s.ApiError as exc:
            if exc.status!=412 or attempt==2: raise

def finish(row, out, staged_id):
    result=out['results'][0]
    row.update(status=result['status'] if result['status'] in ('added','duplicate') else 'error')
    if result.get('file'): row['file']=result['file']
    if result.get('message'): row['message']=result['message']
    if row['status']=='error':
        row.update(stage='confirm',staged=True,staged_id=staged_id,resumable=True,mutation_possible=False)
    warnings.extend(out.get('warnings') or [])

def staged_items():
    with contextlib.redirect_stdout(io.StringIO()):
        return s.import_list()

if mode=='list':
    print(json.dumps({'projectPath':str(root),'results':[],'added':0,'duplicates':0,'failed':0,'warnings':[],
                      'staged':[stage_row(item) for item in staged_items()]}))
    raise SystemExit(0)

if mode=='resume':
    # Resume files what a previous run already staged — no download, no site traffic. Items that
    # are not 'new' (duplicate/unreadable) are reported as-is and left alone for a human.
    wanted=set(cfg.get('ids') or [])
    for item in staged_items():
        if wanted and item.get('id') not in wanted: continue
        row={'source':'staged:'+str(item.get('id')),'status':'error','staged':True,'staged_id':item.get('id')}
        if item.get('provider'): row['provider']=item['provider']
        parsed=item.get('parsed') or {}
        if parsed.get('invoice_no'): row['invoice_no']=parsed['invoice_no']
        try:
            if item.get('status')=='duplicate':
                row.update(status='duplicate',file=item.get('existing_file'),staged=False)
            elif item.get('status')!='new':
                row.update(message=item.get('message') or 'Staged item is not filable; inspect it in the invoice project inbox.',resumable=False)
            else:
                finish(row,confirm(item['id']),item['id'])
        except Exception as exc:
            row['message']=describe(exc,'confirm',True)
            row.update(stage='confirm',resumable=True,mutation_possible=not isinstance(exc,s.ApiError) or getattr(exc,'status',None)!=412)
            if isinstance(exc,s.ApiError):
                row['error_code']=exc.code; row['http_status']=exc.status
        finally:
            if row['status'] in ('added','duplicate') and item.get('id'):
                try:
                    with contextlib.redirect_stdout(io.StringIO()): s.import_discard(item['id'])
                except Exception: pass
        results.append(row)

for source in cfg['paths']:
    row={'source':source,'status':'error'}
    staged=None
    stage='stage'
    try:
        path=Path(source)
        if not path.is_file(): raise ValueError('Invoice PDF does not exist.')
        if path.stat().st_size>s.MAX_IMPORT_FILE_BYTES: raise ValueError('Invoice exceeds existing importer size limit.')
        data=path.read_bytes()
        row['sha256']=hashlib.sha256(data).hexdigest()
        if not data.startswith(b'%PDF-'): raise ValueError('Downloaded file is not a PDF.')
        boundary='chatgpt-'+os.urandom(16).hex()
        # The multipart filename is metadata only, with CR/LF/quote injection removed.
        name=path.name.replace('"','_').replace('\r','_').replace('\n','_').replace('\\','_')
        body=('--'+boundary+'\r\nContent-Disposition: form-data; name="files[]"; filename="'+name+'"\r\nContent-Type: application/pdf\r\n\r\n').encode()+data+('\r\n--'+boundary+'--\r\n').encode()
        with contextlib.redirect_stdout(io.StringIO()):
            staged=s.import_upload(body,'multipart/form-data; boundary='+boundary)['items'][0]
        parsed=staged.get('parsed') or {}
        if staged.get('provider'): row['provider']=staged['provider']
        if parsed.get('invoice_no'): row['invoice_no']=parsed['invoice_no']
        warnings.extend(staged.get('warnings') or [])
        if staged['status']=='duplicate':
            row.update(status='duplicate',file=staged.get('existing_file'))
        elif staged['status']!='new':
            row.update(message=staged.get('message') or 'PDF could not be parsed by existing importer.',resumable=False)
        else:
            stage='confirm'
            finish(row,confirm(staged['id']),staged['id'])
    except Exception as exc:
        row['message']=describe(exc,stage,bool(staged))
        if not isinstance(exc,ValueError):
            row.update(stage=stage,staged=bool(staged),resumable=True,
                       mutation_possible=stage=='confirm' and (not isinstance(exc,s.ApiError) or getattr(exc,'status',None)!=412))
            if staged: row['staged_id']=staged.get('id')
            if isinstance(exc,s.ApiError):
                row['error_code']=exc.code; row['http_status']=exc.status
    finally:
        # Remove only our disposable upload copies after a known terminal result.
        # A FAILED item keeps its staged copy on purpose: that is what resume files.
        if staged and row['status'] in ('added','duplicate'):
            try:
                with contextlib.redirect_stdout(io.StringIO()): s.import_discard(staged['id'])
            except Exception: pass
    results.append(row)
print(json.dumps({'projectPath':str(root),'results':results,'added':sum(r['status']=='added' for r in results),'duplicates':sum(r['status']=='duplicate' for r in results),'failed':sum(r['status']=='error' for r in results),'warnings':warnings,'staged':[stage_row(item) for item in staged_items()]}))
`;

type BridgeOptions={projectPath?:string;python?:string};
function projectRoot(options:BridgeOptions){
 const projectPath=resolve(options.projectPath||process.env.CHATGPT_INVOICES_PROJECT||join(homedir(),'Creations/invoices'));
 if(!existsSync(join(projectPath,'app/server.py'))||!existsSync(join(projectPath,'tools/organize.py')))throw new Error('Invoice project import pipeline not found; set CHATGPT_INVOICES_PROJECT or projectPath.');
 return projectPath;
}
async function runBridge(payload:{projectPath:string;mode:'import'|'resume'|'list';paths:string[];ids?:string[]},options:BridgeOptions):Promise<InvoiceImportReport>{
 const env=resolveImportEnv();
 if(!env.pdftotext)throw toolMissing();
 const child=Bun.spawn([options.python||process.env.PYTHON||'python3','-c',BRIDGE],{cwd:payload.projectPath,env:{...process.env,PATH:env.PATH},stdin:new Blob([JSON.stringify(payload)]),stdout:'pipe',stderr:'pipe'});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 if(code!==0)throw new Error('Invoice import bridge failed; verify Python and the existing invoice project dependencies.'+(stderr.trim()?' ('+stderr.trim().split('\n').slice(-1)[0].slice(0,200)+')':''));
 let report:any;
 try{report=JSON.parse(stdout);}catch{throw new Error('Invoice importer returned an invalid report.');}
 // The bridge speaks the python project's snake_case; the CLI surface stays camelCase.
 report.results=(report.results||[]).map((row:any)=>{
  const {error_code,http_status,staged_id,mutation_possible,...rest}=row;
  return {...rest,...(error_code?{errorCode:error_code}:{}),...(http_status?{httpStatus:http_status}:{}),...(staged_id?{stagedId:staged_id}:{}),...(mutation_possible!==undefined?{mutationPossible:mutation_possible}:{})};
 });
 return report as InvoiceImportReport;
}

/** File downloaded invoice PDFs through the existing invoice project (parse → stage → confirm). */
export async function importInvoices(paths:string[],options:BridgeOptions={}):Promise<InvoiceImportReport>{
 if(!Array.isArray(paths)||paths.some(p=>typeof p!=='string'||!p))throw new Error('Provide explicit downloaded PDF paths.');
 const projectPath=projectRoot(options);
 if(!paths.length)return {projectPath,results:[],added:0,duplicates:0,failed:0,warnings:[]};
 return runBridge({projectPath,mode:'import',paths:paths.map(p=>resolve(p))},options);
}

/** What is waiting in the invoice project's staging inbox — a read, never a mutation. */
export async function listStagedInvoices(options:BridgeOptions={}):Promise<StagedInvoice[]>{
 const projectPath=projectRoot(options);
 return (await runBridge({projectPath,mode:'list',paths:[]},options)).staged||[];
}

/**
 * Finish a filing that failed after the download: confirm what is staged, then (re)file the given
 * local PDFs. Offline by construction — it never reaches the site. Filing twice is impossible:
 * the existing importer keys duplicates on provider + invoice number, so a second resume reports
 * `duplicate`, never a second ledger row.
 */
export async function resumeInvoiceFiling(options:BridgeOptions&{paths?:string[];ids?:string[]}={}):Promise<InvoiceImportReport>{
 const paths=options.paths||[];
 if(paths.some(p=>typeof p!=='string'||!p))throw new Error('Provide explicit downloaded PDF paths.');
 const projectPath=projectRoot(options);
 return runBridge({projectPath,mode:'resume',paths:paths.map(p=>resolve(p)),...(options.ids?{ids:options.ids}:{})},options);
}
