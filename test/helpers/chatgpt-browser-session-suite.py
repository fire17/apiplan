import ast
import asyncio
import sys


def load_probe(path):
    tree=ast.parse(open(path).read())
    errors=[node for node in tree.body if isinstance(node,ast.ClassDef) and node.name in ('SessionReadError','SessionReadTimeout','SessionIdentityMismatch')]
    worker=next(node for node in tree.body if isinstance(node,ast.ClassDef) and node.name=='Worker')
    wanted={'read_session','close_session_tab','recover_session','session'}
    methods=[node for node in worker.body if isinstance(node,(ast.FunctionDef,ast.AsyncFunctionDef)) and node.name in wanted]
    probe=ast.ClassDef(name='Probe',bases=[],keywords=[],decorator_list=[],body=methods)
    namespace={'asyncio':asyncio}
    exec(compile(ast.fix_missing_locations(ast.Module(body=errors+[probe],type_ignores=[])),path,'exec'),namespace)
    return namespace


class Tab:
    def __init__(self,name):self.name=name;self.closed=False
    async def close(self):self.closed=True


class Browser:
    def __init__(self,candidate):self.candidate=candidate;self.gets=[]
    async def get(self,url,new_tab=False):self.gets.append((url,new_tab));return self.candidate


async def recovery_suite(namespace):
    Probe=namespace['Probe']
    old,candidate,main=Tab('old'),Tab('candidate'),Tab('main')
    probe=Probe();probe.api_tab=old;probe.session_tab=old;probe.tab=main;probe.tabs={'main':main};probe.options={'baseURL':'https://chatgpt.com','userId':'expected'};probe.browser=Browser(candidate);probe.session_lock=asyncio.Lock();calls=[]
    async def evaluate(_expression,tab):
        calls.append(('evaluate',tab.name))
        if tab is old:return {'__apiplanSessionError':'timeout'}
        return {'authenticated':True,'user':{'id':'expected'}}
    async def wait_document(tab):calls.append(('wait_document',tab.name))
    probe.evaluate=evaluate;probe.wait_document=wait_document
    first,second=await asyncio.gather(probe.session(),probe.session())
    assert first['sessionRecovered'] is True and first['user']['id']=='expected'
    assert second['user']['id']=='expected' and 'sessionRecovered' not in second
    assert probe.api_tab is old and probe.session_tab is candidate and probe.tab is main and probe.tabs=={'main':main}
    assert probe.browser.gets==[('https://chatgpt.com',True)]
    assert not old.closed and not candidate.closed and not main.closed
    assert calls.count(('evaluate','old'))==1


async def mismatch_suite(namespace):
    Probe=namespace['Probe'];Mismatch=namespace['SessionIdentityMismatch']
    old,candidate,main=Tab('old'),Tab('candidate'),Tab('main')
    probe=Probe();probe.api_tab=old;probe.session_tab=old;probe.tab=main;probe.tabs={'main':main};probe.options={'baseURL':'https://chatgpt.com','userId':'expected'};probe.browser=Browser(candidate);probe.session_lock=asyncio.Lock()
    async def evaluate(_expression,tab):
        if tab is old:return {'__apiplanSessionError':'failed'}
        return {'authenticated':True,'user':{'id':'different'}}
    async def wait_document(_tab):pass
    probe.evaluate=evaluate;probe.wait_document=wait_document
    try:await probe.session()
    except Mismatch as error:assert 'does not match the selected account' in str(error)
    else:raise AssertionError('mismatched recovered identity was accepted')
    assert probe.api_tab is old and probe.session_tab is old and probe.tab is main and probe.tabs=={'main':main}
    assert candidate.closed and not old.closed and not main.closed


async def concurrent_bulk_suite(namespace):
    Probe=namespace['Probe']
    bulk,stale,candidate,main=Tab('bulk'),Tab('stale-session'),Tab('candidate'),Tab('main')
    probe=Probe();probe.api_tab=bulk;probe.session_tab=stale;probe.tab=main;probe.tabs={'main':main};probe.options={'baseURL':'https://chatgpt.com','userId':'expected'};probe.browser=Browser(candidate);probe.session_lock=asyncio.Lock();bulk_done=asyncio.Event()
    async def evaluate(_expression,tab):
        if tab is stale:return {'__apiplanSessionError':'timeout'}
        if tab is candidate:return {'authenticated':True,'user':{'id':'expected'}}
        if tab is bulk:
            await bulk_done.wait();return {'chunk':'complete'}
        raise AssertionError('main tab was touched')
    async def wait_document(_tab):pass
    probe.evaluate=evaluate;probe.wait_document=wait_document
    bulk_read=asyncio.create_task(probe.evaluate('bulk archive read',probe.api_tab))
    recovered=await probe.session()
    assert recovered['sessionRecovered'] is True and probe.api_tab is bulk and probe.session_tab is candidate
    assert stale.closed and not bulk.closed and not main.closed
    bulk_done.set();assert await bulk_read=={'chunk':'complete'}


async def page_abort_suite(namespace):
    Probe=namespace['Probe'];Timeout=namespace['SessionReadTimeout']
    probe=Probe();seen=[]
    async def evaluate(expression,_tab):seen.append(expression);return {'__apiplanSessionError':'timeout'}
    probe.evaluate=evaluate
    try:await probe.read_session(Tab('api'))
    except Timeout as error:assert str(error)=='Authentication session read timed out.'
    else:raise AssertionError('page fetch timeout was accepted')
    expression=seen[0]
    assert 'new AbortController()' in expression and 'signal:controller.signal' in expression
    assert 'setTimeout(()=>controller.abort(),5000)' in expression and 'finally{clearTimeout(timer);}' in expression


async def main():
    namespace=load_probe(sys.argv[1])
    await page_abort_suite(namespace)
    await recovery_suite(namespace)
    await mismatch_suite(namespace)
    await concurrent_bulk_suite(namespace)


asyncio.run(main())
