import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,rmSync,existsSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {importInvoices,listStagedInvoices,resolveImportEnv,resumeInvoiceFiling} from '../src/chatgpt/invoices.ts';
const source=process.env.CHATGPT_INVOICES_PROJECT||join(homedir(),'Creations/invoices');
const integration=existsSync(join(source,'app/server.py'))&&existsSync(join(source,'app/model.py'))&&!!Bun.which('pdftotext')?test:test.skip;
function pdf(invoice='TEST-001'){
 const lines=['OpenAI OpCo','Invoice number '+invoice,'Date of issue September 15, 2026','Date due September 15, 2026','Amount due $200.00','fixture@example.org'];
 const stream='BT /F1 12 Tf 50 750 Td '+lines.map((line,i)=>(i?'0 -20 Td ':'')+'('+line+') Tj').join('\n')+' ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
 let text='%PDF-1.4\n';const offsets=[0];for(let i=0;i<objects.length;i++){offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${objects[i]}\nendobj\n`;}
 const xref=Buffer.byteLength(text);text+=`xref\n0 6\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;return text;
}
async function fixture(fn:(root:string)=>Promise<void>){const root=mkdtempSync(join(tmpdir(),'chatgpt-invoice-'));try{mkdirSync(join(root,'app'));mkdirSync(join(root,'tools'));for(const file of ['app/server.py','app/model.py','app/auth.py','tools/organize.py'])if(existsSync(join(source,file)))copyFileSync(join(source,file),join(root,file));writeFileSync(join(root,'README.md'),'# Test invoices\n<!-- INDEX:START -->\n<!-- INDEX:END -->\n');await fn(root);}finally{rmSync(root,{recursive:true,force:true});}}
integration('reuses real importer names/ledger, preserves original, deduplicates provider+invoice number',()=>fixture(async root=>{const path=join(root,'download.pdf');writeFileSync(path,pdf());const first=await importInvoices([path],{projectPath:root});expect(first.failed).toBe(0);expect(first.added).toBe(1);expect(first.results[0].file).toBe('openai/2026.09.15-fixture-200usd-openai-invoice-paid-TEST-001.pdf');expect(readFileSync(path,'utf8')).toBe(pdf());const repeat=await importInvoices([path],{projectPath:root});expect(repeat.duplicates).toBe(1);expect(readFileSync(join(root,'invoices.csv'),'utf8').split('TEST-001').length-1).toBe(2);expect(readFileSync(join(root,'tracking.csv'),'utf8')).toContain('TEST-001');}));
integration('concurrent imports use existing flock and optimistic conflict retry',()=>fixture(async root=>{const path=join(root,'download.pdf');writeFileSync(path,pdf('LOCK-001'));const results=await Promise.all([importInvoices([path],{projectPath:root}),importInvoices([path],{projectPath:root})]);expect(results.reduce((n,r)=>n+r.added,0)).toBe(1);expect(results.reduce((n,r)=>n+r.duplicates,0)).toBe(1);expect(results.reduce((n,r)=>n+r.failed,0)).toBe(0);}));
integration('invalid downloads fail individually and do not create ledger',()=>fixture(async root=>{const path=join(root,'bad.pdf');writeFileSync(path,'<html>sign in</html>');const r=await importInvoices([path,join(root,'missing.pdf')],{projectPath:root});expect(r.failed).toBe(2);expect(existsSync(join(root,'invoices.csv'))).toBe(false);expect(readFileSync(path,'utf8')).toBe('<html>sign in</html>');}));
// The 2026-09-15 18:30 failure: the daemon's launchd PATH (/usr/bin:/bin:/usr/sbin:/sbin) has no
// Homebrew, so the importer answered every upload with ApiError(503,"tool_missing") and filing died
// after the download. The child now searches the standard tool directories too.
test('the importer child resolves poppler even under a minimal daemon PATH',()=>{
 const daemon=resolveImportEnv({PATH:'/usr/bin:/bin:/usr/sbin:/sbin'});
 expect(daemon.PATH.split(':')).toContain('/opt/homebrew/bin');
 expect(daemon.PATH.split(':')).toContain('/usr/local/bin');
 expect(resolveImportEnv({}).PATH.split(':')).toContain('/opt/homebrew/bin');
 if(Bun.which('pdftotext'))expect(daemon.pdftotext).toBeTruthy();
});
integration('a filing failure keeps the PDF staged, inspectable and resumable, and resume files it exactly once',()=>fixture(async root=>{
 const path=join(root,'download.pdf');writeFileSync(path,pdf('RESUME-001'));
 mkdirSync(join(root,'tracking.csv'));                       // commit fails: tracking cannot be written
 const failed=await importInvoices([path],{projectPath:root});
 expect(failed.failed).toBe(1);
 const row=failed.results[0];
 expect(row.stage).toBe('confirm');
 expect(row.staged).toBe(true);
 expect(row.resumable).toBe(true);
 expect(row.stagedId).toBeTruthy();
 expect(row.message).toContain('resume filing');
 expect(readFileSync(path,'utf8')).toBe(pdf('RESUME-001'));   // the download is never consumed
 expect(existsSync(join(root,'invoices.csv'))).toBe(false);   // and the ledger never moved
 const staged=await listStagedInvoices({projectPath:root});
 expect(staged.map(item=>item.invoice_no)).toEqual(['RESUME-001']);
 expect(readdirSync(join(root,'app/.inbox')).some(name=>name.endsWith('.pdf'))).toBe(true);
 rmSync(join(root,'tracking.csv'),{recursive:true});
 const resumed=await resumeInvoiceFiling({projectPath:root});
 expect(resumed.added).toBe(1);
 expect(resumed.failed).toBe(0);
 expect(resumed.results[0].file).toBe('openai/2026.09.15-fixture-200usd-openai-invoice-paid-RESUME-001.pdf');
 expect(await listStagedInvoices({projectPath:root})).toEqual([]);
 const again=await resumeInvoiceFiling({projectPath:root,paths:[path]});
 expect(again.added).toBe(0);
 expect(again.duplicates).toBe(1);                            // provider + invoice number still dedupes
 expect(readFileSync(join(root,'invoices.csv'),'utf8').split('\n').filter(line=>line.includes(',RESUME-001,')).length).toBe(1); // exactly one ledger row
}));
integration('resume with nothing staged is a no-op that touches no ledger',()=>fixture(async root=>{
 const empty=await resumeInvoiceFiling({projectPath:root});
 expect(empty).toMatchObject({added:0,duplicates:0,failed:0});
 expect(empty.results).toEqual([]);
 expect(existsSync(join(root,'invoices.csv'))).toBe(false);
}));
test('missing import pipeline gives an actionable error',async()=>{await expect(importInvoices(['/not/a/pdf'],{projectPath:'/does-not-exist/chatgpt-invoices'})).rejects.toThrow('pipeline not found');});
test('explicit path validation prevents implicit scans',async()=>{await expect(importInvoices([''])).rejects.toThrow('explicit downloaded PDF paths');});
