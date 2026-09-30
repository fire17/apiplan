#!/usr/bin/env python3
"""nodriver worker. Private stdin/stdout RPC; website authentication only.

An attached daily browser is never owned, stopped, or reconfigured. Only a
managed profile can switch headed/headless. No token is returned to the caller.
"""
import asyncio, base64, json, os, re, sys, traceback
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse
import nodriver as uc
from nodriver import cdp

OUT = sys.stdout
sys.stdout = sys.stderr  # library diagnostics cannot corrupt the RPC stream

class SessionReadError(RuntimeError):
    pass

class SessionReadTimeout(SessionReadError):
    pass

class SessionIdentityMismatch(SessionReadError):
    pass

def emit(value):
    OUT.write(json.dumps(value, ensure_ascii=True) + '\n'); OUT.flush()

def operation_lock(worker, op, args):
    """Serialization for one RPC message, or None when the message is independent.

    Independent backend reads and diagnostic screenshots stay unserialized so a
    stuck UI operation can never hide them. Everything that reads or drives a
    surface document shares one lock per surface: `snapshot` republishes
    `window.__apiplanRefs.epoch`, so an `evaluate` pinned to an earlier epoch must
    not be able to run between another caller's snapshot and its own.
    """
    if op in ('init', 'mode', 'reload', 'close'):
        return worker.lock
    if op in ('request', 'status', 'session', 'network', 'screenshot'):
        return None
    return worker.surface_locks.setdefault((args or {}).get('surface', 'main'), asyncio.Lock())

async def snapshot_evaluate(worker, tab, expression):
    """Snapshot a surface and evaluate `expression` against that exact snapshot.

    `expression` is the source of a function that receives the snapshot identity
    it must pin itself to: {epoch, url, messages:[{id, domTurnId, role}]}. Both
    steps run inside one dispatch, so one surface lock hold covers them; sending
    them as two RPC messages reopens the epoch/URL race this closes.
    """
    if not isinstance(expression, str) or not expression.strip():
        raise ValueError('A snapshot evaluation requires an expression.')
    snapshot = await worker.snapshot(tab)
    messages = [{'id': m.get('id'), 'domTurnId': m.get('domTurnId'), 'role': m.get('role')}
                for m in (snapshot.get('messages') or [])]
    spec = json.dumps({'epoch': snapshot.get('epoch'), 'url': snapshot.get('url'), 'messages': messages}, ensure_ascii=True)
    return {'snapshot': snapshot, 'value': await worker.evaluate('(' + expression + ')(' + spec + ')', tab)}

class Worker:
    def __init__(self):
        self.browser = None
        self.tab = None
        self.api_tab = None
        self.session_tab = None
        self.options = {}
        self.owned = False
        self.network = {}
        self.request_data = {}
        self.message_first_observed = {}
        self.lock = asyncio.Lock()
        self.session_lock = asyncio.Lock()
        self.surface_locks = {}
        self.tabs = {}

    def prepare_managed_profile(self, profile):
        profile = Path(profile)
        profile.mkdir(mode=0o700, parents=True, exist_ok=True)
        lock = profile / 'SingletonLock'
        if not os.path.lexists(lock):
            return
        if not lock.is_symlink():
            raise RuntimeError('Managed browser profile has an unrecognized lock; inspect it before retrying.')
        match = re.search(r'-(\d+)$', os.readlink(lock))
        if not match:
            raise RuntimeError('Managed browser profile has an unrecognized lock; inspect it before retrying.')
        try:
            os.kill(int(match.group(1)), 0)
        except ProcessLookupError:
            pass
        except PermissionError:
            raise RuntimeError('Managed browser profile is already in use by another process.')
        else:
            raise RuntimeError('Managed browser profile is already in use by another process.')
        for name in ('SingletonLock', 'SingletonCookie', 'SingletonSocket'):
            artifact = profile / name
            if artifact.is_symlink():
                artifact.unlink(missing_ok=True)

    async def close_owned_browser(self, browser=None):
        browser = browser or self.browser
        if not browser:
            return
        process = getattr(browser, '_process', None)
        try:
            await asyncio.wait_for(browser.send(cdp.browser.close()), 3)
        except Exception:
            pass
        if process and process.returncode is None:
            try:
                await asyncio.wait_for(process.wait(), 3)
            except asyncio.TimeoutError:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(process.wait(), 2)
                except asyncio.TimeoutError:
                    try:
                        process.kill()
                    except ProcessLookupError:
                        pass
                    await asyncio.wait_for(process.wait(), 2)
        try:
            await asyncio.wait_for(browser.aclose(), 2)
        except Exception:
            pass

    async def evaluate(self, expression, tab=None):
        result, error = await (tab or self.tab).send(cdp.runtime.evaluate(
            expression, await_promise=True, return_by_value=True, user_gesture=True))
        if error:
            raise RuntimeError(error.exception.description if error.exception else error.text)
        return result.value

    async def observe(self, event):
        url = event.response.url
        if urlparse(url).netloc != urlparse(self.options['baseURL']).netloc or not (urlparse(url).path.startswith(('/backend-api/','/public-api/gizmos/')) or urlparse(url).path.rstrip('/') in ('/gpts','/gpts/mine','/gpts.data','/gpts/mine.data')):
            return
        key = event.request_id.to_json()
        self.network[key] = {**self.network.get(key,{}),'id':key,'url':url,'status':event.response.status,'mime':event.response.mime_type}
        if len(self.network) > 1500:
            self.network.pop(next(iter(self.network)))

    async def observe_request(self,event):
        url=event.request.url
        if urlparse(url).netloc!=urlparse(self.options['baseURL']).netloc or not (urlparse(url).path.startswith(('/backend-api/','/public-api/gizmos/')) or urlparse(url).path.rstrip('/') in ('/gpts','/gpts/mine','/gpts.data','/gpts/mine.data')):return
        key=event.request_id.to_json()
        self.network[key]={'id':key,'url':url,'method':event.request.method}
        if event.request.post_data:self.request_data[key]=event.request.post_data
        if len(self.request_data)>1000:self.request_data.pop(next(iter(self.request_data)))

    async def init(self, args):
        if self.browser:
            return await self.status()
        self.options = args
        if args.get('cdpURL') and args.get('transportMode')!='managed':
            u = urlparse(args['cdpURL'])
            if u.hostname not in ('localhost','127.0.0.1','::1'):
                raise ValueError('Only loopback browser connections are accepted.')
            self.browser = await uc.start(host=u.hostname, port=u.port or 9222)
            self.owned = False
        else:
            self.owned = True
            self.prepare_managed_profile(args['profilePath'])
            config = uc.Config(user_data_dir=args['profilePath'],
                headless=args.get('headless',True), browser_executable_path=args.get('browserPath'),
                browser_args=['--window-size=1400,950'], sandbox=True)
            self.browser = uc.Browser(config)
            try:
                await self.browser.start()
            except Exception:
                await self.close_owned_browser()
                self.browser = None
                self.owned = False
                raise
        try:
            # Always create a dedicated tab. Do not navigate the user's original tab.
            self.tab = await self.browser.get(args.get('restoreURL') or args['baseURL'],new_tab=True)
            self.tabs['main'] = self.tab
            self.tab.add_handler(cdp.network.ResponseReceived,self.observe)
            self.tab.add_handler(cdp.network.RequestWillBeSent,self.observe_request)
            await self.tab.send(cdp.network.enable())
            # Download policy is configured only for an explicit download operation.
            await self.wait_document()
            self.api_tab = await self.browser.get(args['baseURL'],new_tab=True)
            for _ in range(120):
                try:
                    if await self.evaluate("location.protocol.startsWith('http') && document.readyState !== 'loading'", self.api_tab):break
                except Exception:pass
                await asyncio.sleep(.25)
            self.session_tab = self.api_tab
        except Exception:
            if self.owned:
                await self.close_owned_browser()
                self.browser=None;self.tab=None;self.api_tab=None;self.session_tab=None;self.tabs={};self.owned=False
            raise
        return await self.status()

    async def wait_document(self, tab=None):
        for _ in range(120):
            try:
                if await self.evaluate("location.protocol.startsWith('http') && document.readyState !== 'loading'",tab):
                    return
            except Exception:
                pass
            await asyncio.sleep(.25)
        raise RuntimeError('Browser navigation has not completed. Inspect the visible browser.')

    async def status(self):
        if not self.browser:return {'running':False}
        page = await self.evaluate('({url:location.href,title:document.title,ready:document.readyState})')
        return {'running':True,'owned':self.owned,'headless':self.options.get('headless',False) if self.owned else False,**page}

    def surface_tab(self, a):
        name=a.get('surface','main')
        tab=self.tabs.get(name)
        if tab is None:raise ValueError('Unknown browser surface.')
        return tab

    async def read_session(self, tab):
        # Bound both the website fetch and the CDP await. A page-side abort cannot
        # release a CDP command when the tab itself has stopped responding.
        try:
            result=await asyncio.wait_for(self.evaluate("""(async()=>{
              const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
              try{
                const r=await fetch('/api/auth/session',{credentials:'include',cache:'no-store',signal:controller.signal});
                if(!r.ok)return {authenticated:false,status:r.status};
                const s=await r.json();
                return {authenticated:!!s.accessToken,user:s.user||null,expires:s.expires||null};
              }catch(error){
                return {__apiplanSessionError:error?.name==='AbortError'?'timeout':'failed'};
              }finally{clearTimeout(timer);}
            })()""",tab),7)
        except asyncio.TimeoutError as error:
            raise SessionReadTimeout('Authentication session read timed out.') from error
        if not isinstance(result,dict):
            raise SessionReadError('Authentication session read returned an invalid response.')
        if result.get('__apiplanSessionError')=='timeout':
            raise SessionReadTimeout('Authentication session read timed out.')
        if result.get('__apiplanSessionError'):
            raise SessionReadError('Authentication session read failed.')
        return result

    async def close_session_tab(self, tab):
        if not tab:return
        try:await asyncio.wait_for(tab.close(),2)
        except Exception:pass

    async def recover_session(self):
        candidate=None
        try:
            try:candidate=await asyncio.wait_for(self.browser.get(self.options['baseURL'],new_tab=True),8)
            except asyncio.TimeoutError as error:raise SessionReadTimeout('Authentication session recovery timed out.') from error
            try:await asyncio.wait_for(self.wait_document(candidate),8)
            except asyncio.TimeoutError as error:raise SessionReadTimeout('Authentication session recovery timed out.') from error
            result=await self.read_session(candidate)
            expected=self.options.get('userId')
            observed=(result.get('user') or {}).get('id') if result.get('authenticated') else None
            if expected and observed!=expected:
                raise SessionIdentityMismatch('Recovered browser session identity does not match the selected account; the existing session tab was preserved.')
        except Exception:
            await self.close_session_tab(candidate)
            raise
        stale=getattr(self,'session_tab',None) or self.api_tab
        self.session_tab=candidate
        # api_tab also owns in-page state for active archive/media streams. It is
        # deliberately preserved when auth recovery moves to an independent tab.
        if stale is not self.api_tab:await self.close_session_tab(stale)
        return {**result,'sessionRecovered':True}

    async def session(self):
        # Authentication remains inside dedicated browser tabs. Recovery creates
        # another dedicated tab and never navigates or submits through the main UI.
        lock=getattr(self,'session_lock',None)
        if lock is None:
            lock=asyncio.Lock();self.session_lock=lock
        async with lock:
            try:return await self.read_session(getattr(self,'session_tab',None) or self.api_tab)
            except SessionReadError as initial:
                try:return await asyncio.wait_for(self.recover_session(),25)
                except SessionIdentityMismatch:raise
                except Exception as recovery:
                    if isinstance(initial,SessionReadTimeout) or isinstance(recovery,(SessionReadTimeout,asyncio.TimeoutError)):
                        raise SessionReadTimeout('Authentication session read timed out; the dedicated session tab could not be recovered.') from recovery
                    raise SessionReadError('Authentication session read failed; the dedicated session tab could not be recovered.') from recovery

    async def request(self, a):
        if a.get('binary'):
            import asset_stream, importlib
            return await importlib.reload(asset_stream).download(self, a)
        path=a['path']
        public_get = urlparse(path).path in ('/public-api/gizmos/discovery','/public-api/gizmos/discovery_anon','/public-api/gizmos/discovery/recent','/public-api/gizmos/discovery/mine','/public-api/gizmos/discovery/trending') and a.get('method','GET').upper()=='GET' and 'body' not in a
        if (not path.startswith('/backend-api/') and not public_get) or path.startswith('//') or urlparse(path).scheme or urlparse(path).netloc:
            raise ValueError('Requests must target a ChatGPT backend path or an observed public catalog GET.')
        spec=json.dumps(a)
        return await self.evaluate("""(async()=>{
          const a=SPEC;
          const authController=new AbortController(),authTimer=setTimeout(()=>authController.abort(),5000);let s;
          try{s=await (await fetch('/api/auth/session',{credentials:'include',cache:'no-store',signal:authController.signal})).json();}
          catch(error){throw new Error(error?.name==='AbortError'?'Authentication session read timed out.':'Authentication session read failed.');}
          finally{clearTimeout(authTimer);}
          if(!s.accessToken)throw new Error('Sign in to ChatGPT in this browser first.');
          const h={'authorization':'Bearer '+s.accessToken};
          if(a.workspace)h['chatgpt-account-id']=a.workspace;
          if(a.body!==undefined)h['content-type']='application/json';
          const requestController=new AbortController(),requestTimer=setTimeout(()=>requestController.abort(),30000);
          try{
            const r=await fetch(a.path,{method:a.method||'GET',headers:h,credentials:'include',signal:requestController.signal,
              body:a.body===undefined?undefined:JSON.stringify(a.body)}),type=r.headers.get('content-type')||'';
            if(a.binary){const bytes=new Uint8Array(await r.arrayBuffer());let b='';for(let i=0;i<bytes.length;i+=16384)b+=String.fromCharCode(...bytes.subarray(i,i+16384));return {userId:s.user?.id,status:r.status,contentType:type,retryAfter:r.headers.get('retry-after'),base64:btoa(b)};}
            const text=await r.text();let body;try{body=JSON.parse(text)}catch{body=text;}
            return {userId:s.user?.id,status:r.status,contentType:type,retryAfter:r.headers.get('retry-after'),body};
          }catch(error){if(error?.name==='AbortError')throw new Error((a.method||'GET').toUpperCase()==='GET'?'Browser backend read timed out.':'Browser backend write timed out after dispatch; inspect its outcome before retrying.');throw error;
          }finally{clearTimeout(requestTimer);}
        })()""".replace('SPEC',spec),self.api_tab)

    def observe_message_times(self, snapshot, now=None):
        observed=getattr(self,'message_first_observed',None)
        if observed is None:observed={};self.message_first_observed=observed
        instant=now or datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
        scope=str(snapshot.get('url') or '')
        for message in snapshot.get('messages',[]):
            stable=message.get('domTurnId') or message.get('id')
            if not stable:continue
            key=scope+'\0'+str(stable)
            if key not in observed:observed[key]=instant
            message['firstObservedAt']=observed[key]
        while len(observed)>5000:observed.pop(next(iter(observed)))
        return snapshot

    def generation_observer(self, tab, create=False):
        observers = getattr(self, 'generation_observers', None)
        if observers is None:
            observers = {}; self.generation_observers = observers
        if id(tab) in observers:
            return observers[id(tab)]
        if not create:
            return None
        if not any(tab is owned for owned in self.tabs.values()):
            raise ValueError('Generation observation requires a worker-owned surface.')
        import runpy
        observer_type = runpy.run_path(str(Path(__file__).with_name('generation_observer.py')))['GenerationObserver']
        downloads = self.options.get('downloads')
        metadata = str(Path(downloads).parent / 'generation-observations') if downloads else None
        observer = observer_type(tab, cdp, metadata)
        observers[id(tab)] = observer
        return observer

    async def ensure_rendering(self, tab):
        # Only tabs created and tracked by this worker may receive target emulation.
        owned = [getattr(self, 'tab', None), getattr(self, 'api_tab', None), getattr(self, 'session_tab', None), *getattr(self, 'tabs', {}).values()]
        if tab is None or not any(tab is candidate for candidate in owned):
            return {'enabled': False, 'reason': 'not worker-owned'}
        cached = getattr(self, 'rendering_tabs', None)
        if cached is None:
            cached = {}; self.rendering_tabs = cached
        key = id(tab)
        if key in cached:
            return cached[key]
        try:
            await tab.send(cdp.emulation.set_focus_emulation_enabled(True))
            observed = await self.evaluate("({visibilityState:document.visibilityState,hidden:document.hidden,focused:document.hasFocus()})", tab)
        except Exception as error:
            raise RuntimeError("Owned tab rendering emulation is unavailable; no rendering guarantee was established.") from error
        result = {'enabled': True, 'via': 'target focus emulation', **observed}
        if observed.get('visibilityState') != 'visible' or observed.get('hidden') is not False:
            raise RuntimeError('Owned tab did not verify visible rendering after focus emulation.')
        cached[key] = result
        return result

    async def snapshot(self, tab=None):
        tab = tab or self.tab
        rendering = await self.ensure_rendering(tab)
        result=await self.evaluate(r"""(()=>{
          const candidates=[...document.querySelectorAll('button,a,input,textarea,select,summary,details,[tabindex]:not([tabindex="-1"]),[aria-haspopup],[onclick],[role="link"],[role="treeitem"],[role="searchbox"],[role="spinbutton"],[role="listbox"],[role="button"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="slider"],[role="combobox"],[role="option"],[role="tab"],[role="switch"],[role="checkbox"],[role="radio"],[contenteditable="true"]')];
          const state=e=>{const r=e.getBoundingClientRect(),cs=getComputedStyle(e),ariaHidden=!!e.closest('[aria-hidden=true]'),hoverRequired=!!e.closest('[data-testid^="conversation-turn-"]')&&!!e.checkVisibility&&!e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});const visible=!!e.getClientRects().length&&cs.visibility!=='hidden'&&cs.display!=='none'&&(hoverRequired||!e.checkVisibility||e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));const inViewport=r.right>0&&r.bottom>0&&r.x<innerWidth&&r.y<innerHeight;const hit=inViewport?document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,r.x+r.width/2)),Math.max(0,Math.min(innerHeight-1,r.y+r.height/2))):null;const hitTarget=!!hit&&(e===hit||e.contains(hit));return {visible,ariaHidden,hoverRequired,inViewport,hitTarget,available:visible&&(!ariaHidden||(e.tabIndex>=0&&hitTarget))};};
          const states=new Map(candidates.map(e=>[e,state(e)])),controls=candidates.filter(e=>states.get(e).available),hidden=candidates.filter(e=>!states.get(e).available);
          const name=e=>e.getAttribute('aria-label')||(e.getAttribute('aria-labelledby')||'').split(/\s+/).map(id=>(document.getElementById(id)?.innerText||document.getElementById(id)?.textContent||'')).join(' ').trim()||[...(e.labels||[])].map(l=>l.innerText).join(' ')||e.getAttribute('title')||e.innerText||e.textContent||e.getAttribute('placeholder')||'';
          const turns=[...document.querySelectorAll('[data-testid^="conversation-turn-"]')],explicitMessages=[...document.querySelectorAll('[data-message-author-role]')];
          const thinking=[],thinkingRefs=[];const thoughtLabel=value=>/^(?:show thinking|pro thinking|stopped thinking|thinking(?:(?:…|\.\.\.)| for \d+(?:\.\d+)?(?:ms|s|m|h)(?: \d+(?:\.\d+)?(?:ms|s|m|h))*)?|thought(?: for \d+(?:\.\d+)?(?:ms|s|m|h)(?: \d+(?:\.\d+)?(?:ms|s|m|h))*)?|working(?:…|\.\.\.)?|worked for \d+(?:\.\d+)?(?:ms|s|m|h)(?: \d+(?:\.\d+)?(?:ms|s|m|h))*)$/i.test((value||'').trim());
          turns.forEach((turn,turnIndex)=>{
            const message=turn.querySelector('[data-message-author-role]'),previous=turns[turnIndex-1],rolelessAssistant=!message&&!!previous&&explicitMessages.some(node=>node.closest('[data-testid^="conversation-turn-"]')===previous&&node.getAttribute('data-message-author-role')==='user');if(message?.getAttribute('data-message-author-role')!=='assistant'&&!rolelessAssistant)return;
            const roots=[];const remember=root=>{if(!root||!turn.contains(root)||roots.includes(root))return;const nested=roots.findIndex(other=>other.contains?.(root)||root.contains?.(other));if(nested<0)roots.push(root);else if(roots[nested].contains?.(root))roots[nested]=root;};
            const clickableAncestor=label=>{for(let node=label;node&&node!==turn;node=node.parentElement){if(node!==label&&node.contains?.(message))break;const role=node.getAttribute?.('role');if(['BUTTON','SUMMARY','DETAILS'].includes(node.tagName)||role==='button'||node.getAttribute?.('aria-expanded')!==null||getComputedStyle(node).cursor==='pointer')return node;}return label;};
            for(const root of turn.querySelectorAll('details,[data-testid*="thinking" i]')){const trigger=root.querySelector('summary,button,[role="button"]');if((root.getAttribute('data-testid')||'').toLowerCase().includes('thinking')||thoughtLabel(name(trigger)))remember(root);}
            for(const trigger of turn.querySelectorAll('summary,button,[role="button"]'))if(thoughtLabel(name(trigger))){const controlled=document.getElementById(trigger.getAttribute('aria-controls')||'');remember(controlled||trigger.closest('details,[data-testid*="thinking" i]')||trigger);}
            for(const label of turn.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],span,div'))if(thoughtLabel(name(label))){const controlled=document.getElementById(label.getAttribute('aria-controls')||'');remember(controlled||label.closest('details,[data-testid*="thinking" i],button,[role="button"]')||clickableAncestor(label));}
            const turnId=turn.getAttribute('data-testid')||message?.getAttribute('data-message-id')||'turn-'+turnIndex;
            roots.forEach((root,index)=>{const triggers=thoughtLabel(name(root))?[root]:root.matches('summary,button,[role="button"]')?[root]:[...root.querySelectorAll('summary,button,[role="button"],h1,h2,h3,h4,h5,h6,[role="heading"],span,div')],trigger=triggers.find(e=>thoughtLabel(name(e))),title=(trigger?name(trigger):'').trim();if(!title)return;const lines=root===trigger?[]:(root.innerText||root.textContent||'').toWellFormed().split('\n');if(lines[0]?.trim()===title)lines.shift();const observedText=lines.join('\n').trim(),explicit=trigger?.getAttribute('aria-expanded')??root.getAttribute('aria-expanded'),expandable=root.tagName==='DETAILS'||explicit!==null,expanded=root.tagName==='DETAILS'?!!root.open:explicit!==null?explicit==='true':!!observedText,text=expanded?observedText:'';const nodeId=root.id||root.getAttribute('data-testid')||trigger?.getAttribute('aria-controls')||String(index),id=turnId+':thinking:'+nodeId,status=root.getAttribute('data-status')||trigger?.getAttribute('data-status')||(root.getAttribute('aria-busy')==='true'?'active':!expandable&&!observedText?'not-expandable':undefined);thinking.push({id,title,text,expanded,...(status?{status}:{})});thinkingRefs.push({id,title,turn,trigger,ref:controls.indexOf(trigger)});});
          });
          const messages=[],seenMessages=new Set();
          turns.forEach((turn,index)=>{const turnId=turn.getAttribute('data-testid')||'turn-'+index,direct=explicitMessages.filter(node=>node.closest('[data-testid^="conversation-turn-"]')===turn);if(direct.length){for(const node of direct){seenMessages.add(node);messages.push({id:node.getAttribute('data-message-id'),domTurnId:turnId,role:node.getAttribute('data-message-author-role'),text:(node.innerText||node.textContent||'').toWellFormed()});}return;}const previous=turns[index-1],previousUser=previous&&explicitMessages.some(node=>node.closest('[data-testid^="conversation-turn-"]')===previous&&node.getAttribute('data-message-author-role')==='user'),raw=(turn.innerText||turn.textContent||'').toWellFormed().trim(),lines=raw.split('\n').map(line=>line.trim()).filter(Boolean),answerLines=lines.filter(line=>!thoughtLabel(line)&&!/^(?:sources?|show sources)$/i.test(line)),text=answerLines.join('\n').trim();if(previousUser&&text)messages.push({id:'dom:'+turnId,domTurnId:turnId,role:'assistant',text,identitySource:'dom-turn',source:'site-visible roleless assistant turn'});});
          for(const node of explicitMessages)if(!seenMessages.has(node))messages.push({id:node.getAttribute('data-message-id'),role:node.getAttribute('data-message-author-role'),text:(node.innerText||node.textContent||'').toWellFormed()});
          const noticeRoots=[],rememberNotice=root=>{if(root&&!root.closest('[data-testid^="conversation-turn-"]')&&!root.closest('[data-message-author-role]')&&!noticeRoots.includes(root))noticeRoots.push(root);};
          for(const root of document.querySelectorAll('[role="alert"],[role="alertdialog"],[data-testid*="usage-limit" i]'))rememberNotice(root);
          const workExhausted=value=>/^(?:you(?:'ve| have) reached (?:your )?work (?:usage )?limit|work (?:usage )?(?:limit reached|is exhausted)|you have no work (?:usage )?left)$/i.test((value||'').trim());
          for(const heading of document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))if(!heading.closest('[data-message-author-role]')&&workExhausted(name(heading)))rememberNotice(heading.closest('[role="alertdialog"],[role="dialog"],[role="alert"],section')||heading);
          const notices=noticeRoots.filter(root=>{const cs=getComputedStyle(root);return !!root.getClientRects().length&&cs.visibility!=='hidden'&&cs.display!=='none';}).map((root,index)=>({id:root.id||root.getAttribute('data-testid')||root.getAttribute('role')+'-'+index,role:root.getAttribute('role'),text:(root.innerText||root.textContent||'').toWellFormed().slice(0,1200)})).filter(notice=>notice.text.trim());
          const epoch=globalThis.crypto?.randomUUID?.()||String(Date.now())+Math.random(); window.__apiplanRefs={epoch,controls};window.__apiplanThinking={epoch,items:thinkingRefs};
          return {epoch,url:location.href,title:document.title,text:document.body?.innerText||'',
            controls:controls.map((e,i)=>({ref:i,tag:e.tagName.toLowerCase(),type:e.type||null,role:e.getAttribute('role'),
              name:name(e),tabIndexValue:e.tabIndex,tabIndex:e.getAttribute('tabindex'),hasPopup:e.getAttribute('aria-haspopup'),...states.get(e),
              messageId:e.closest('[data-message-id]')?.getAttribute('data-message-id')||e.closest('[data-testid^="conversation-turn-"]')?.querySelector('[data-message-id]')?.getAttribute('data-message-id'),turnId:e.closest('[data-testid^="conversation-turn-"]')?.getAttribute('data-testid'),valueMin:e.getAttribute('aria-valuemin'),valueMax:e.getAttribute('aria-valuemax'),valueNow:e.getAttribute('aria-valuenow'),valueText:e.getAttribute('aria-valuetext'),id:e.id,href:e.getAttribute('href'),testId:e.getAttribute('data-testid'),disabled:e.disabled||e.getAttribute('aria-disabled')==='true',
              checked:e.getAttribute('aria-checked')??e.checked,selected:e.getAttribute('aria-selected'),context:Array.from(e.parentElement?.innerText||'').slice(0,600).join(''),
              expanded:e.getAttribute('aria-expanded'),value:e.type==='password'?'[redacted]':(e.isContentEditable?(e.innerText||e.textContent||''):e.value),rect:(()=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};})()})),
            hiddenControls:hidden.map(e=>({tag:e.tagName.toLowerCase(),role:e.getAttribute('role'),name:name(e),id:e.id,testId:e.getAttribute('data-testid'),disabled:e.disabled||e.getAttribute('aria-disabled')==='true',...states.get(e)})),
            coverage:{candidateCount:candidates.length,availableCount:controls.length,hiddenCount:hidden.length,complete:false,reason:'DOM-discoverable actionable controls only; unmounted and gesture-only controls require further observation.'},
            messages,
            thinking,
            notices,
            media:[...document.querySelectorAll('main img,main video,main audio,main a[download]')].map(e=>({tag:e.tagName.toLowerCase(),src:e.currentSrc||e.src||e.href,alt:e.alt||e.innerText||'',type:e.type||''}))};
        })()""",tab)
        result['rendering'] = rendering
        return self.observe_message_times(result)

    async def expand_thinking(self, a):
        tab=self.surface_tab(a);spec=json.dumps({'id':a.get('id'),'epoch':a.get('epoch')})
        target=await self.evaluate(r"""(()=>{const a=SPEC,r=window.__apiplanThinking,refs=window.__apiplanRefs;if(!r||!refs||r.epoch!==a.epoch||refs.epoch!==a.epoch)throw Error('Stale thinking reference. Get a new snapshot.');const matches=r.items.filter(x=>x.id===a.id);if(matches.length!==1)throw Error('Thinking reference must identify exactly one region.');const item=matches[0],assistants=[...document.querySelectorAll('[data-testid^="conversation-turn-"]')].filter(turn=>turn.querySelector('[data-message-author-role="assistant"]'));if(item.turn!==assistants.at(-1))throw Error('Thinking expansion is restricted to the current assistant turn.');const trigger=item.trigger;if(!trigger?.isConnected)throw Error('Thinking control is unavailable; get a new snapshot.');const details=trigger.closest('details'),explicit=trigger.getAttribute('aria-expanded'),expanded=details?!!details.open:explicit==='true';if(expanded)return {already:true};if(!details&&explicit!=='false')throw Error('Thinking control does not expose a collapsed state; no click performed.');if(trigger.disabled||trigger.getAttribute('aria-disabled')==='true'||!trigger.getClientRects().length||getComputedStyle(trigger).visibility==='hidden')throw Error('Thinking control is unavailable; no click performed.');trigger.scrollIntoView({block:'center'});const rect=trigger.getBoundingClientRect(),x=rect.x+Math.min(32,rect.width/2),y=rect.y+rect.height/2,hit=document.elementFromPoint(x,y);if(!hit||!(hit===trigger||trigger.contains(hit)||hit.contains(trigger)))throw Error('Thinking control is obscured; no click performed.');return {x,y};})()""".replace('SPEC',spec),tab)
        if target.get('already'):return {'id':a.get('id'),'expanded':True,'changed':False}
        await tab.mouse_move(target['x'],target['y'],steps=1);await asyncio.sleep(.12);await tab.mouse_click(target['x'],target['y'])
        for _ in range(15):
            snap=await self.snapshot(tab);item=next((x for x in snap.get('thinking',[]) if x.get('id')==a.get('id')),None)
            if item and item.get('expanded'):return {'id':item['id'],'expanded':True,'changed':True,'title':item['title'],'text':item['text']}
            await asyncio.sleep(.1)
        raise RuntimeError('Thinking control was clicked but expansion was not confirmed.')

    async def target_expression(self,a):
        if a.get('selector'):
            return '(()=>{const all=document.querySelectorAll('+json.dumps(a['selector'])+');if(all.length!==1)throw Error("Selector must identify exactly one element.");return all[0];})()'
        if 'ref' in a:
            epoch=json.dumps(a.get('epoch'))
            return f"(()=>{{const r=window.__apiplanRefs;if(!r||r.epoch!=={epoch})throw Error('Stale UI reference. Get a new snapshot.');return r.controls[{int(a['ref'])}];}})()"
        name=json.dumps(a.get('name',''))
        return f"(()=>{{const label=e=>e.getAttribute('aria-label')||(e.getAttribute('aria-labelledby')||'').split(/\\s+/).map(id=>(document.getElementById(id)?.innerText||document.getElementById(id)?.textContent||'')).join(' ').trim()||[...(e.labels||[])].map(l=>l.innerText).join(' ')||e.getAttribute('title')||e.innerText||e.textContent||e.getAttribute('placeholder')||'';const all=[...document.querySelectorAll('button,a,input,textarea,select,summary,[role],[tabindex],[aria-haspopup],[onclick],[contenteditable=true]')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden'&&label(e).trim()==={name});if(all.length>1)throw Error('Ambiguous control name; use snapshot ref and epoch.');return all[0];}})()"

    async def action(self,a):
        tab=self.surface_tab(a)
        target=await self.target_expression(a)
        kind=a.get('kind','click')
        if kind=='click':
            rect=await self.evaluate(f"(()=>{{const e={target};if(!e)throw Error('Control not found');if(e.disabled)throw Error('Control disabled');e.scrollIntoView({{block:'center'}});const r=e.getBoundingClientRect();return {{x:r.x+r.width/2,y:r.y+r.height/2}};}})()",tab)
            await tab.mouse_move(rect['x'],rect['y'],steps=1)
            await asyncio.sleep(.12)
            rect=await self.evaluate(f"(()=>{{const e={target};if(!e?.isConnected)throw Error('Control changed while hovering; take a fresh snapshot.');if(e.disabled||e.getAttribute('aria-disabled')==='true')throw Error('Control disabled');if(!e.getClientRects().length||getComputedStyle(e).visibility==='hidden'||(e.checkVisibility&&!e.checkVisibility({{checkOpacity:true,checkVisibilityCSS:true}})))throw Error('Control is not visible after hover; no click performed.');const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);if(!hit||!(hit===e||e.contains(hit)))throw Error('Control is obscured; no click performed.');return {{x,y}};}})()",tab)
            await tab.mouse_click(rect['x'],rect['y'])
        elif kind=='focus':
            await self.evaluate(f"(()=>{{const e={target};if(!e||e.disabled||e.getAttribute('aria-disabled')==='true')throw Error('Control unavailable');e.focus();return document.activeElement===e;}})()",tab)
        elif kind=='hover':
            rect=await self.evaluate(f"(()=>{{const e={target};if(!e)throw Error('Control not found');e.scrollIntoView({{block:'nearest'}});const r=e.getBoundingClientRect();return {{x:r.x+r.width/2,y:r.y+r.height/2}};}})()",tab)
            await tab.mouse_move(rect['x'],rect['y'],steps=1)
        elif kind=='fill':
            await self.evaluate(f"(()=>{{const e={target};if(!e)throw Error('Input not found');e.focus();if(e.isContentEditable){{document.execCommand('selectAll',false,null);}}else{{e.select();}}}})()",tab)
            await tab.send(cdp.input_.insert_text(a.get('text','')))
        elif kind=='select':
            await self.evaluate(f"(()=>{{const e={target};if(!e)throw Error('Select not found');e.value={json.dumps(a['value'])};e.dispatchEvent(new Event('change',{{bubbles:true}}));}})()",tab)
        return {'performed':kind,'url':await self.evaluate('location.href',tab)}

    async def download(self,a):
        tab=self.surface_tab(a)
        folder=Path(a['directory']).resolve();folder.mkdir(parents=True,exist_ok=True,mode=0o700)
        frame=(await tab.send(cdp.page.get_frame_tree())).frame.id_
        done=asyncio.get_running_loop().create_future();selected={}
        async def begin(e):
            if e.frame_id==frame and not selected:
                selected.update(guid=e.guid,name=e.suggested_filename)
        async def progress(e):
            if e.guid==selected.get('guid') and not done.done():
                if e.state=='completed':done.set_result(True)
                elif e.state=='canceled':done.set_exception(RuntimeError('Download was cancelled.'))
        connection=self.browser
        connection.add_handler(cdp.browser.DownloadWillBegin,begin)
        connection.add_handler(cdp.browser.DownloadProgress,progress)
        try:
            await connection.send(cdp.browser.set_download_behavior('allowAndName',download_path=str(folder),events_enabled=True))
            await self.action({**a,'kind':'click'})
            await asyncio.wait_for(done,a.get('timeout',90))
            path=folder/selected['guid']
            if not path.is_file():raise RuntimeError('Download completed without a local file.')
            os.chmod(path,0o600)
            return {'path':str(path),'suggestedName':selected['name'],'bytes':path.stat().st_size}
        finally:
            await connection.send(cdp.browser.set_download_behavior('default',events_enabled=False))
            for cls,fn in [(cdp.browser.DownloadWillBegin,begin),(cdp.browser.DownloadProgress,progress)]:
                if fn in connection.handlers.get(cls,[]):connection.handlers[cls].remove(fn)

    async def dispatch(self, op, a):
        if op=='reload':
            import runpy
            module=runpy.run_path(__file__,run_name='chatgpt_hot_adapter')
            self.__class__=module['Worker']
            for tab in self.tabs.values():
                for event,method in [(cdp.network.ResponseReceived,self.observe),(cdp.network.RequestWillBeSent,self.observe_request)]:
                    handlers=getattr(tab,'handlers',{}).get(event,[])
                    for handler in list(handlers):
                        if getattr(handler,'__self__',None) is self and getattr(handler,'__name__','')==method.__name__:
                            handlers.remove(handler)
                    tab.add_handler(event,method)
            return {'reloaded':True,'statePreserved':True}
        if op=='init':return await self.init(a)
        if op=='status':return await self.status()
        if not self.browser:raise RuntimeError('Browser not started.')
        if op=='session':return await self.session()
        if op.startswith('audio.output.'):
            import audio_output, importlib
            from types import SimpleNamespace
            module=importlib.reload(audio_output)
            tab=self.surface_tab(a)
            async def evaluate_audio(expression):
                return await self.evaluate(expression,tab)
            target=SimpleNamespace(evaluate=evaluate_audio)
            action=op.rsplit('.',1)[-1]
            if action not in ('arm','read','status','stop'):raise ValueError('Unknown audio output operation.')
            return await getattr(module,action)(target,a)
        if op.startswith('audio.'):
            import audio_input, importlib
            module=importlib.reload(audio_input)
            if op=='audio.input':return await module.prepare(self,a)
            if op=='audio.clear':return await module.clear(self)
            if op=='audio.play':return await module.play(self)
            if op=='audio.status':return await module.status(self)
            if op=='audio.outputs':return await module.outputs(self)
        if op=='request':return await self.request(a)
        if op=='snapshot':return await self.snapshot(self.surface_tab(a))
        if op=='snapshot.evaluate':return await snapshot_evaluate(self,self.surface_tab(a),a.get('expression'))
        if op=='thinking.expand':return await self.expand_thinking(a)
        if op=='generation.receipt':
            observer = self.generation_observer(self.surface_tab(a))
            if observer is None:return {'authoritative':False,'reason':'surface was not observing generation requests','additionalRequests':0}
            return observer.receipt(a.get('userIds'), a.get('conversation'), a.get('after',0))
        if op=='surface.open':
            u=urlparse(a['url'])
            if u.scheme!='https' or u.hostname not in ('invoice.stripe.com','billing.stripe.com','chatgpt.com'):
                raise ValueError('Unsupported website surface origin.')
            name=a.get('surface','auxiliary')
            if name in ('main','api'):raise ValueError('Use a dedicated auxiliary surface name.')
            tab=self.tabs.get(name)
            if tab:await tab.get(a['url'])
            else:tab=await self.browser.get(a['url'],new_tab=True);self.tabs[name]=tab
            tab.add_handler(cdp.network.ResponseReceived,self.observe)
            tab.add_handler(cdp.network.RequestWillBeSent,self.observe_request)
            await tab.send(cdp.network.enable())
            if name.startswith('harness-') or a.get('observeGeneration'):
                self.generation_observer(tab, create=True)
            rendering = await self.ensure_rendering(tab) if a.get('keepRendering') else None
            return {'surface':name,'url':a['url'], **({'rendering':rendering} if rendering else {})}
        if op=='surface.activate':
            tab=self.tabs.get(a['surface'])
            if not tab:raise ValueError('Unknown browser surface.')
            await tab.send(cdp.page.bring_to_front());return {'activated':a['surface']}
        if op=='surface.close':
            name=a['surface']
            if name in ('main','api'):raise ValueError('Cannot close reserved surface.')
            tab=self.tabs.pop(name,None)
            if tab:
                getattr(self, 'rendering_tabs', {}).pop(id(tab), None)
                observer = getattr(self, 'generation_observers', {}).pop(id(tab), None)
                if observer:observer.close()
                await tab.close()
            return {'closed':bool(tab)}
        if op=='inspect':
            if a.get('resources'):
                return await self.evaluate("performance.getEntriesByType('resource').slice(-500).map(e=>({path:new URL(e.name).pathname,origin:new URL(e.name).origin,type:e.initiatorType,duration:Math.round(e.duration)}))",self.surface_tab(a))
            if 'point' in a:
                point=a['point'];x=float(point['x']);y=float(point['y'])
                if not (0<=x<=100000 and 0<=y<=100000):raise ValueError('Invalid inspection point.')
                target=f'document.elementFromPoint({x},{y})'
            else:target=await self.target_expression(a)
            return await self.evaluate(f"(()=>{{let e={target},out=[];for(let i=0;e&&i<10;i++,e=e.parentElement){{const r=e.getBoundingClientRect(),cs=getComputedStyle(e);out.push({{tag:e.tagName,id:e.id,testId:e.getAttribute('data-testid'),role:e.getAttribute('role'),tabIndex:e.getAttribute('tabindex'),hasPopup:e.getAttribute('aria-haspopup'),ariaHidden:e.getAttribute('aria-hidden'),ariaLabel:e.getAttribute('aria-label'),text:Array.from(e.innerText||e.textContent||'').slice(0,300).join(''),pointerEvents:cs.pointerEvents,display:cs.display,visibility:cs.visibility,opacity:cs.opacity,rect:{{x:r.x,y:r.y,width:r.width,height:r.height}},messageIds:[...e.querySelectorAll('[data-message-id]')].map(x=>x.getAttribute('data-message-id')).slice(0,5)}});}}return out;}})()",self.surface_tab(a))
        if op=='action':return await self.action(a)
        if op=='download':return await self.download(a)
        if op=='evaluate':return await self.evaluate(a['expression'],self.surface_tab(a))
        if op=='goto':
            url=a['url'];u=urlparse(url)
            if u.netloc!=urlparse(self.options['baseURL']).netloc:raise ValueError('Navigation must stay on ChatGPT.')
            await self.tab.get(url);await self.wait_document();return await self.status()
        if op=='key':
            key=a['key'];mapping={'Enter':13,'Escape':27,'Tab':9,'Backspace':8,'ArrowUp':38,'ArrowDown':40,'ArrowLeft':37,'ArrowRight':39,'Delete':46}
            for kind in ['keyDown','keyUp']:
                await self.surface_tab(a).send(cdp.input_.dispatch_key_event(kind,key=key,code=key,windows_virtual_key_code=mapping.get(key,0),modifiers=a.get('modifiers',0)))
            return {'key':key}
        if op=='text':
            await self.surface_tab(a).send(cdp.input_.insert_text(a['text']));return {'inserted':True}
        if op=='mouse':
            await self.surface_tab(a).mouse_click(float(a['x']),float(a['y']));return {'clicked':True}
        if op=='scroll':
            return await self.evaluate("""(()=>{const a=ARGS;let e=document.elementFromPoint(a.x||700,a.y||500);while(e&&!(e.scrollHeight>e.clientHeight&&/(auto|scroll)/.test(getComputedStyle(e).overflowY)))e=e.parentElement;const target=e||document.scrollingElement;target.scrollBy({left:a.dx||0,top:a.dy||600,behavior:'instant'});return {scrolled:true,top:target.scrollTop,height:target.scrollHeight,viewport:target.clientHeight};})()""".replace('ARGS',json.dumps(a)),self.surface_tab(a))
        if op=='upload':
            element=await self.surface_tab(a).select(a.get('selector','input[type=file]'),timeout=5)
            await element.send_file(*[str(Path(f).resolve(strict=True)) for f in a['files']])
            return {'attached':a['files']}
        if op=='screenshot':
            data=await self.surface_tab(a).send(cdp.page.capture_screenshot(format_='png',capture_beyond_viewport=False))
            return {'base64':data,'mime':'image/png'}
        if op=='viewport':
            await self.surface_tab(a).send(cdp.emulation.set_device_metrics_override(int(a['width']),int(a['height']),1,False));return a
        if op=='network':return list(self.network.values())
        if op=='request.info':
            body=self.request_data.get(a['id'])
            if body is None:
                try:body=await self.surface_tab(a).send(cdp.network.get_request_post_data(cdp.network.RequestId(a['id'])))
                except Exception:pass
            return {**self.network.get(a['id'],{}),'postData':body[0] if isinstance(body,(list,tuple)) else body}
        if op=='response':
            body,encoded=await self.surface_tab(a).send(cdp.network.get_response_body(cdp.network.RequestId(a['id'])))
            return {'body':body,'base64':encoded}
        if op=='permission':
            allowed={'audioCapture','videoCapture'}
            if not set(a['permissions'])<=allowed:raise ValueError('Only requested microphone/camera permissions supported.')
            await self.browser.send(cdp.browser.grant_permissions([cdp.browser.PermissionType(x) for x in a['permissions']],origin=self.options['baseURL']))
            return {'granted':a['permissions']}
        if op=='mode':
            if not self.owned:
                if not a['headless']:return await self.status()
                identity=await self.session()
                if not identity.get('authenticated'):raise RuntimeError('Sign in before moving the website session into a managed browser.')
                source_identity=identity.get('user',{}).get('id')
                if not isinstance(source_identity,str) or not source_identity:
                    raise RuntimeError('Source browser identity could not be verified. Source browser preserved.')
                cookies=await self.api_tab.send(cdp.network.get_cookies([self.options['baseURL']]))
                source_browser,source_tab,source_api,source_session,source_tabs=self.browser,self.tab,self.api_tab,getattr(self,'session_tab',None),self.tabs
                opts={**self.options,'transportMode':'managed','headless':True,'restoreURL':self.options['baseURL']}
                candidate=Worker()
                try:
                    await candidate.init(opts)
                    params=[cdp.network.CookieParam(name=c.name,value=c.value,domain=c.domain,path=c.path,secure=c.secure,http_only=c.http_only,same_site=c.same_site,expires=cdp.network.TimeSinceEpoch(c.expires) if c.expires>0 else None,partition_key=c.partition_key) for c in cookies if c.domain.lstrip('.')=='chatgpt.com' or c.domain.endswith('.chatgpt.com')]
                    await candidate.api_tab.send(cdp.network.set_cookies(params))
                    await candidate.api_tab.get(opts['baseURL'])
                    await candidate.wait_document(candidate.api_tab)
                    await candidate.tab.get(await self.evaluate('location.href'))
                    await candidate.wait_document()
                    target_identity={}
                    for _ in range(80):
                        try:
                            target_identity=await candidate.session()
                        except Exception:
                            target_identity={}
                        if target_identity.get('authenticated') and target_identity.get('user',{}).get('id')==source_identity:
                            break
                        if target_identity.get('authenticated'):
                            raise RuntimeError('Managed browser is signed into a different identity. Source browser preserved.')
                        await asyncio.sleep(.25)
                    else:
                        raise RuntimeError('Managed browser did not establish the source session. Sign in manually; source browser preserved.')
                except Exception:
                    if candidate.browser:await candidate.close_owned_browser()
                    raise
                self.__dict__.update(candidate.__dict__)
                closed=set()
                for t in list(source_tabs.values())+[source_api,source_session]:
                    if t and id(t) not in closed:await t.close();closed.add(id(t))
                return {**await self.status(),'transportMode':'managed','sourceBrowserPreserved':True}

            opts={**self.options,'headless':a['headless'],'restoreURL':await self.evaluate('location.href')}
            await self.close_owned_browser()
            self.browser=None;self.tab=None;self.api_tab=None;self.session_tab=None;self.tabs={}
            return {**await self.init(opts),'transportMode':'managed'}
        if op=='close':
            for observer in getattr(self, 'generation_observers', {}).values():observer.close()
            self.generation_observers = {}
            if self.owned:await self.close_owned_browser()
            else:
                closed=set()
                for tab in [self.tab,self.api_tab,getattr(self,'session_tab',None),*[tab for name,tab in self.tabs.items() if name!='main']]:
                    if tab and id(tab) not in closed:await tab.close();closed.add(id(tab))
            self.browser=None;self.tab=None;self.api_tab=None;self.session_tab=None;self.tabs={}
            return {'closed':True,'dailyBrowserPreserved':not self.owned}
        raise ValueError('Unknown browser operation: '+op)

async def main():
    worker=Worker()
    async def handle(message):
        try:
            # Requests may read independent backend pages while UI work is in flight.
            args=message.get('args',{}) or {}
            lock=operation_lock(worker,message['op'],args)
            if lock is None:
                result=await worker.dispatch(message['op'],args)
            else:
                async with lock:result=await asyncio.wait_for(worker.dispatch(message['op'],args),120)

            emit({'id':message['id'],'result':result})
        except Exception as e:
            emit({'id':message.get('id'),'error':{'message':str(e),'type':type(e).__name__}})
    tasks=set()
    while True:
        line=await asyncio.to_thread(sys.stdin.readline)
        if not line:break
        try:message=json.loads(line)
        except Exception:continue
        task=asyncio.create_task(handle(message));tasks.add(task);task.add_done_callback(tasks.discard)
    for task in tasks:task.cancel()
    if tasks:await asyncio.gather(*tasks,return_exceptions=True)
    # nodriver's process is absent for attached browsers, so this leaves Arc running.
    if worker.browser and worker.owned:worker.browser.stop()

if __name__=='__main__':
    asyncio.run(main())
