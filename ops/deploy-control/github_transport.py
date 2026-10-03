"""Bounded GitHub control transport and exact-SHA source reads; no arbitrary URLs."""
import hashlib
import json
import os
import re
from pathlib import Path
import subprocess
import signal
import sys
import time
import urllib.error
import urllib.request

class RemoteError(Exception):
    pass
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise RemoteError('GITHUB_REDIRECT_REFUSED')

HTTP_HELPER = r"""import json,sys,urllib.request,urllib.error
value=json.load(sys.stdin)
class RefuseRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):raise RuntimeError('redirect')
request=urllib.request.Request('https://api.github.com'+value['path'],data=None if value['data'] is None else json.dumps(value['data']).encode(),headers={'Authorization':'Bearer '+value['token'],'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'fixed-deploy-control-v1','Content-Type':'application/json'})
try:
 with urllib.request.build_opener(RefuseRedirect).open(request,timeout=10) as response:data=response.read(2097153)
 if len(data)>2097152:raise RuntimeError('bound')
 json.loads(data)
 sys.stdout.buffer.write(data)
except Exception:sys.exit(2)
"""

class GitHub:
    def __init__(self,token,policy,deadline=None):self.token=token;self.policy=policy;self.deadline=deadline
    def remaining(self,maximum):
        value=maximum if self.deadline is None else min(maximum,self.deadline-time.monotonic())
        if value<=0:raise RemoteError('CONTROL_BUDGET_EXHAUSTED')
        return value
    def api(self,path,data=None):
        control=self.policy['control']
        prefix='/repos/'+control['repo']+'/issues/'+str(control['issue'])+'/comments'
        if data is not None and path!=prefix:raise RemoteError('WRITE_PATH_REFUSED')
        metadata={'/repos/'+value['repo'] for value in self.policy['repos'].values()}|{'/repos/'+control['repo'],'/user'}
        issue='/repos/'+control['repo']+'/issues/'+str(control['issue'])
        comment='/repos/'+control['repo']+'/issues/comments/'
        allowed=(path in metadata or path in (issue,prefix) or re.fullmatch(re.escape(prefix)+r'\?per_page=100&page=[0-9]{1,3}',path) or re.fullmatch(re.escape(comment)+r'[0-9]+',path))
        if not allowed:raise RemoteError('API_PATH_REFUSED')
        # A separate bounded process enforces total DNS/TLS/body time, not only socket inactivity.
        try:
            response=subprocess.run(['/usr/bin/python3','-I','-S','-B','-c',HTTP_HELPER],
                input=json.dumps({'token':self.token,'path':path,'data':data}).encode(),
                stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=self.remaining(15))
            if response.returncode or len(response.stdout)>2*1024*1024:raise RemoteError('GITHUB_REQUEST_FAILED')
            return json.loads(response.stdout)
        except (subprocess.TimeoutExpired,OSError,ValueError):raise RemoteError('GITHUB_REQUEST_FAILED') from None
    def comments(self):
        control=self.policy['control'];result=[]
        for page in range(1,21):
            values=self.api('/repos/%s/issues/%s/comments?per_page=100&page=%d'%(control['repo'],control['issue'],page))
            if not isinstance(values,list):raise RemoteError('COMMENTS_SHAPE_INVALID')
            result.extend(values)
            if len(values)<100:return result
        raise RemoteError('COMMENTS_BOUND_REACHED')
    def comment(self,comment_id):
        if type(comment_id) is not int or comment_id<=0:raise RemoteError('COMMENT_ID_INVALID')
        control=self.policy['control'];value=self.api('/repos/%s/issues/comments/%d'%(control['repo'],comment_id))
        expected='https://api.github.com/repos/%s/issues/%s'%(control['repo'],control['issue'])
        if value.get('issue_url')!=expected:raise RemoteError('COMMENT_ISSUE_MISMATCH')
        return value
    def post(self,body):
        c=self.policy['control']
        return self.api('/repos/%s/issues/%s/comments'%(c['repo'],c['issue']),{'body':body})
    def preflight(self):
        c=self.policy['control'];repo=self.api('/repos/'+c['repo'])
        if repo.get('id')!=c['repo_id'] or repo.get('private') is not True:raise RemoteError('CONTROL_IDENTITY_MISMATCH')
        issue=self.api('/repos/%s/issues/%s'%(c['repo'],c['issue']))
        if issue.get('state')!='open' or issue.get('pull_request'):raise RemoteError('CONTROL_ISSUE_MISMATCH')
        for definition in self.policy['repos'].values():
            value=self.api('/repos/'+definition['repo'])
            if value.get('id')!=definition['id'] or value.get('default_branch')!=definition['branch'] or value.get('private') is not definition['private']:
                raise RemoteError('REPO_IDENTITY_MISMATCH')
        value=self.api('/user')
        if type(value.get('id')) is not int:raise RemoteError('AUTH_IDENTITY_INVALID')
        return value['id']

class Sources:
    def __init__(self,github,policy):self.github=github;self.policy=policy
    def git(self,args):
        env={key:value for key,value in os.environ.items() if not key.startswith('GIT_')}
        env.update({'PATH':'/usr/bin:/bin','LC_ALL':'C','GIT_TERMINAL_PROMPT':'0','GIT_CONFIG_NOSYSTEM':'1',
            'GIT_CONFIG_GLOBAL':'/dev/null','GIT_ASKPASS':self.policy['askpass'],
            'DEPLOY_GITHUB_TOKEN':self.github.token,'GIT_ALLOW_PROTOCOL':'https','GIT_LFS_SKIP_SMUDGE':'1'})
        try:
            process=subprocess.Popen(['/usr/bin/git','-c','credential.helper=','-c','core.hooksPath=/dev/null']+args,
                env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
            try:
                stdout,stderr=process.communicate(timeout=self.github.remaining(90 if 'fetch' in args else 5))
            except (subprocess.TimeoutExpired,RemoteError):
                try:os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError:pass
                process.communicate()
                raise RemoteError('GIT_OPERATION_UNKNOWN') from None
            result=subprocess.CompletedProcess(process.args,process.returncode,stdout,stderr)
        except OSError:raise RemoteError('GIT_OPERATION_UNKNOWN') from None
        if result.returncode:raise RemoteError('GIT_OPERATION_REFUSED')
        if len(result.stdout)>3*1024*1024:raise RemoteError('GIT_RESPONSE_BOUND')
        return result.stdout
    def verify(self,alias,sha):
        if alias not in self.policy['repos']:raise RemoteError('REPO_ALIAS_REFUSED')
        definition=self.policy['repos'][alias]
        value=self.github.api('/repos/'+definition['repo'])
        if value.get('id')!=definition['id'] or value.get('default_branch')!=definition['branch']:raise RemoteError('SOURCE_IDENTITY_MISMATCH')
        cache=Path(self.policy['root'])/'cache'/(alias+'.git')
        cache.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        if cache.is_symlink():raise RemoteError('CACHE_SYMLINK_REFUSED')
        if not cache.exists():self.git(['init','--bare',str(cache)])
        branch=definition['branch']
        self.git(['--git-dir='+str(cache),'fetch','--no-tags','--no-recurse-submodules',
            'https://github.com/'+definition['repo']+'.git','+refs/heads/'+branch+':refs/heads/approved'])
        actual=self.git(['--git-dir='+str(cache),'rev-parse',sha+'^{commit}']).decode().strip()
        if actual!=sha:raise RemoteError('COMMIT_IDENTITY_MISMATCH')
        self.git(['--git-dir='+str(cache),'merge-base','--is-ancestor',sha,'refs/heads/approved'])
        return cache
    def blob(self,cache,sha,path,maximum):
        tree=self.git(['--git-dir='+str(cache),'ls-tree',sha,'--',path]).decode().strip()
        if not tree.startswith('100644 blob '):raise RemoteError('SOURCE_FILE_MODE_REFUSED')
        size=self.git(['--git-dir='+str(cache),'cat-file','-s',sha+':'+path]).decode().strip()
        if not size.isdigit() or not 0<int(size)<=maximum:raise RemoteError('SOURCE_SIZE_REFUSED')
        value=self.git(['--git-dir='+str(cache),'cat-file','blob',sha+':'+path])
        if len(value)!=int(size):raise RemoteError('SOURCE_SIZE_CHANGED')
        return value
