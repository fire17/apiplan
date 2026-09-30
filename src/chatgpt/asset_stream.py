"""Bounded CDP frames for website assets; authentication never leaves the page."""
import asyncio
import base64
import hashlib
import json
import os
import tempfile
import uuid
from pathlib import Path

async def download(worker, args):
    path = args['path']
    if not path.startswith('/backend-api/estuary/content?'):
        raise ValueError('Binary downloads require the observed ChatGPT asset route.')
    limit = args.get('maxBytes', 512*1024*1024)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 0 < limit <= 512*1024*1024:
        raise ValueError('Asset download size limit must be a positive integer no larger than 512 MiB.')
    directory = Path(args['directory'])
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    token = uuid.uuid4().hex
    spec = json.dumps({'path': path, 'workspace': args.get('workspace'), 'token': token})
    tab = worker.api_tab
    info = await worker.evaluate("""(async()=>{
      const a=SPEC,authController=new AbortController(),authTimer=setTimeout(()=>authController.abort(),5000);let s;
      try{s=await(await fetch('/api/auth/session',{credentials:'include',cache:'no-store',signal:authController.signal})).json();}
      catch(error){throw new Error(error?.name==='AbortError'?'Authentication session read timed out.':'Authentication session read failed.');}
      finally{clearTimeout(authTimer);}
      if(!s.accessToken)throw new Error('Sign in to ChatGPT in this browser first.');
      const h={authorization:'Bearer '+s.accessToken};if(a.workspace)h['chatgpt-account-id']=a.workspace;
      const controller=new AbortController(),headerTimer=setTimeout(()=>controller.abort(),30000);let r;
      try{r=await fetch(a.path,{headers:h,credentials:'include',signal:controller.signal});}
      catch(error){if(error?.name==='AbortError')throw new Error('Browser asset read timed out before response headers.');throw error;}
      finally{clearTimeout(headerTimer);}
      const info={status:r.status,userId:s.user?.id,contentType:r.headers.get('content-type')||'',retryAfter:r.headers.get('retry-after')};
      if(!r.ok){info.body=(await r.text()).slice(0,300);return info;}
      (window.__apiplanAssets??={})[a.token]={reader:r.body.getReader(),controller,pending:null};return info;
    })()""".replace('SPEC', spec), tab)
    if not 200 <= info['status'] < 300:
        return info
    fd = None
    filename = None
    size = 0
    digest = hashlib.sha256()
    completed = False
    try:
        fd, filename = tempfile.mkstemp(prefix='asset-', suffix='.part', dir=directory)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as output:
            fd = None
            async with asyncio.timeout(590):
                while True:
                    chunk = await worker.evaluate("""(async()=>{
                      const entry=window.__apiplanAssets[TOKEN];if(!entry)throw new Error('Asset stream expired.');
                      let value=entry.pending;
                      if(!value){const result=await entry.reader.read();if(result.done)return {done:true};value=result.value;}
                      const part=value.subarray(0,262144);entry.pending=value.length>part.length?value.subarray(part.length):null;
                      let binary='';for(let i=0;i<part.length;i+=16384)binary+=String.fromCharCode(...part.subarray(i,i+16384));
                      return {done:false,base64:btoa(binary)};
                    })()""".replace('TOKEN', json.dumps(token)), tab)
                    if chunk.get('done'):
                        break
                    encoded = chunk.get('base64')
                    if not isinstance(encoded, str) or len(encoded) > 349528:
                        raise ValueError('Asset stream frame exceeds the encoded 256 KiB limit.')
                    data = base64.b64decode(encoded, validate=True)
                    if not data:
                        raise ValueError('Asset stream returned an empty frame.')
                    if len(data) > 262144:
                        raise ValueError('Asset stream frame exceeds the 256 KiB limit.')
                    size += len(data)
                    if size > limit:
                        raise ValueError('Asset exceeds the configured download size limit.')
                    output.write(data)
                    digest.update(data)
                output.flush()
                os.fsync(output.fileno())
        if not size:
            raise ValueError('Asset stream returned no bytes.')
        completed = True
        return {**info, 'path': filename, 'size': size, 'sha256': digest.hexdigest()}
    finally:
        if fd is not None:
            try:
                os.close(fd)
            except OSError:
                pass
        if filename and not completed:
            Path(filename).unlink(missing_ok=True)
        try:
            await asyncio.wait_for(worker.evaluate("""(()=>{const e=window.__apiplanAssets?.[TOKEN];if(e){e.controller.abort();delete window.__apiplanAssets[TOKEN];}return true;})()""".replace('TOKEN', json.dumps(token)), tab), 3)
        except Exception:
            pass
