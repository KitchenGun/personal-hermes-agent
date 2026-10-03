"""Stable bootstrap entrypoint. Installed separately from updateable release files."""
import contextlib
import hashlib
import importlib
import inspect
import json
import os
from pathlib import Path
import re
import runpy
import sqlite3
import stat
import subprocess
import sys
import tempfile
import time
import types
import uuid

sys.dont_write_bytecode=True
BOOTSTRAP=Path(__file__).resolve().parent
sys.path.insert(0,str(BOOTSTRAP))
import guard

class RecoveryRequired(Exception):pass

def read_file(path,maximum=1024*1024):
    fd=os.open(str(path),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        before=os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_uid!=os.getuid() or before.st_nlink!=1 or before.st_mode & 0o022 or before.st_size>maximum:
            raise RecoveryRequired('LOCAL_FILE_IDENTITY_REFUSED')
        raw=stream.read(maximum+1);after=os.fstat(stream.fileno())
        signature=lambda value:(value.st_dev,value.st_ino,value.st_mode,value.st_uid,value.st_size,value.st_mtime_ns,value.st_ctime_ns)
        if len(raw)>maximum or signature(before)!=signature(after) or signature(after)!=signature(path.lstat()):
            raise RecoveryRequired('LOCAL_FILE_CHANGED_OR_BOUND')
    return raw

def read_json(path,maximum=1024*1024):
    return json.loads(read_file(path,maximum))


def anchored_configuration():
    hashes=read_json(BOOTSTRAP/'anchor.json')
    expected={'launcher.py','guard.py','auth_adapter.py','dotenv_bundle.py','system_python.py','auth_contract.json','policy.json','askpass.py'}
    if not isinstance(hashes,dict) or set(hashes)!=expected:raise RecoveryRequired('BOOTSTRAP_ANCHOR_SCHEMA')
    for name,digest in hashes.items():
        path=BOOTSTRAP/name
        if path.is_symlink() or hashlib.sha256(read_file(path)).hexdigest()!=digest:raise RecoveryRequired('BOOTSTRAP_ANCHOR_CHANGED')
    from system_python import verify_system_python
    auth=read_json(BOOTSTRAP/'auth_contract.json')
    verify_system_python(auth['system_python_pin'])
    policy=read_json(BOOTSTRAP/'policy.json')
    if policy.get('authority_epoch')!=guard.EPOCH:raise RecoveryRequired('POLICY_EPOCH_REFUSED')
    return policy,auth

def retained_recovery_release(root):
    """Anchored schema reader runs BEFORE importing any candidate code."""
    database=Path(root)/'control.sqlite3'
    if not database.exists():return None
    if database.is_symlink():raise RecoveryRequired('RECOVERY_LEDGER_SYMLINK')
    connection=sqlite3.connect('file:'+str(database)+'?mode=ro',uri=True,timeout=10)
    try:
        if connection.execute('PRAGMA user_version').fetchone()[0]!=1:raise RecoveryRequired('RECOVERY_SCHEMA_UNSUPPORTED')
        rows=connection.execute("SELECT r.intent_json FROM targets t JOIN requests r ON r.request_id=t.active_job WHERE t.target='worker'").fetchall()
        if len(rows)>1:raise RecoveryRequired('RECOVERY_JOURNAL_AMBIGUOUS')
        if not rows:return None
        raw=rows[0][0]
        if len(raw)>65536:raise RecoveryRequired('RECOVERY_JOURNAL_BOUND')
        value=json.loads(raw).get('old',{}).get('release')
        if value is None:raise RecoveryRequired('RECOVERY_RELEASE_MISSING')
        return value
    finally:connection.close()

def package(policy,target,release):
    if target not in guard.SOURCE_FILES or not isinstance(release,dict) or set(release)!={'sha','manifest_sha256','package'}:
        raise RecoveryRequired('RELEASE_SCHEMA_REFUSED')
    sha=release['sha']
    if not isinstance(sha,str) or not re.fullmatch(r'[0-9a-f]{40}',sha) or release['package']!=target+'-'+sha:
        raise RecoveryRequired('RELEASE_PATH_REFUSED')
    directory=Path(policy['root'])/'releases'/target/sha
    for path in [directory]+list(directory.parents):
        if path.is_symlink():raise RecoveryRequired('RELEASE_SYMLINK_REFUSED')
    raw=read_file(directory/'manifest.json',65536)
    if len(raw)>65536 or hashlib.sha256(raw).hexdigest()!=release['manifest_sha256']:
        raise RecoveryRequired('RELEASE_MANIFEST_CHANGED')
    sources={name:read_file(directory/name,guard.MAX_SOURCE) for name in guard.SOURCE_FILES[target]}
    if any((directory/name).is_symlink() for name in ['manifest.json']+list(sources)):
        raise RecoveryRequired('RELEASE_SYMLINK_REFUSED')
    guard.validate_manifest(raw,target,sources)
    if set(x.name for x in directory.iterdir())!=set(sources)|{'manifest.json'}:
        raise RecoveryRequired('RELEASE_EXTRA_FILES_REFUSED')
    return directory

def existing_auth(auth,timeout=40):
    """Run the already-verified loader in its private phone env; token stays in pipes/memory."""
    runner='''import json,sys
sys.path.insert(0,sys.argv[1])
from auth_adapter import load_token
from dotenv_bundle import SOURCES
contract=json.load(sys.stdin)
contract['_bundled_dotenv_sources']=SOURCES
value=load_token(contract)
print(json.dumps({'token':value}))
'''
    result=subprocess.run(auth['python_argv']+['-B','-c',runner,str(BOOTSTRAP)],
        input=json.dumps(auth).encode(),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=timeout)
    if result.returncode or len(result.stdout)>8192:raise RecoveryRequired('AUTH_REUSE_FAILED')
    value=json.loads(result.stdout)
    token=value.get('token')
    if not isinstance(token,str) or not token or len(token)>4096 or any(ord(x)<33 or ord(x)>126 for x in token):
        raise RecoveryRequired('AUTH_RETURN_INVALID')
    return token

def unit_facts(policy,target):
    service=policy['services'][target]
    properties=('InvocationID','ExecMainPID','ExecMainStartTimestampMonotonic')
    result=subprocess.run(['/usr/bin/systemctl','--user','show',service]+['--property='+x for x in properties],
        stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=10)
    if result.returncode or len(result.stdout)>4096:raise RecoveryRequired('SERVICE_IDENTITY_UNAVAILABLE')
    value=dict(line.split('=',1) for line in result.stdout.decode('ascii').splitlines() if '=' in line)
    invocation=value.get('InvocationID','')
    if not re.fullmatch('[0-9a-f]{32}',invocation) or invocation!=os.environ.get('INVOCATION_ID'):
        raise RecoveryRequired('SERVICE_INVOCATION_MISMATCH')
    pid=int(value['ExecMainPID']);started=int(value['ExecMainStartTimestampMonotonic'])
    if pid!=os.getpid() or started<=0:raise RecoveryRequired('SERVICE_PROCESS_MISMATCH')
    unit=Path(policy['unit_dir'])/service
    if unit.is_symlink():raise RecoveryRequired('SERVICE_UNIT_SYMLINK')
    roles=('worker','updater') if target=='worker' else ('probe',)
    units={policy['services'][role]:read_file(Path(policy['unit_dir'])/policy['services'][role],32768).decode() for role in roles}
    return {'unit_identity':guard.digest(units),'invocation_id':invocation,'pid':pid,'started_at':started}

def atomic_receipt(path,value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    fd,temp=tempfile.mkstemp(prefix='.receipt-',dir=str(path.parent))
    try:
        with os.fdopen(fd,'w') as stream:
            json.dump(value,stream,sort_keys=True);stream.flush();os.fsync(stream.fileno())
        os.replace(temp,str(path))
    finally:
        if os.path.exists(temp):os.unlink(temp)

def idle_recovery_request(policy,store,host,clock=time.time):
    """Bounded recovery of positive idle failure only; never overrides active work or manual stop."""
    state=store.target_state('worker')
    if state.get('active_job') or state.get('quarantined') or store.jobs():return None
    observed=host.snapshot('worker')
    if observed.get('active_state')!='failed' or not observed.get('settled'):return None
    path=Path(policy['root'])/'idle-recovery.json'
    record=read_json(path) if path.exists() else {'generation':observed['pointer_generation'],'times':[]}
    now=clock()
    times=[value for value in record.get('times',[]) if type(value) in (int,float) and now-3600<value<=now]
    if record.get('generation')!=observed['pointer_generation']:times=[]
    if len(times)>=3:return None
    identifier='idle_'+uuid.uuid4().hex
    snapshot={key:observed[key] for key in ('release','pointer_owner','pointer_generation','unit_identity','invocation_id','pid','started_at')}
    request={'id':identifier,'operation':'deploy.restart_service','profile':'worker-v1','target':'worker',
             'authority_epoch':guard.EPOCH,'internal_recovery':snapshot}
    atomic_receipt(path,{'generation':observed['pointer_generation'],'times':times+[now]})
    store.accept(identifier,guard.digest(request),'internal-idle:'+identifier,request)
    return identifier

def internal_recovery_valid(job,store,host):
    request=job['request']
    expected={'id','operation','profile','target','authority_epoch','internal_recovery'}
    if (set(request)!=expected or request['id']!=job['request_id'] or job['comment_id']!='internal-idle:'+job['request_id']
        or request['operation']!='deploy.restart_service' or request['profile']!='worker-v1'
        or request['target']!='worker' or request['authority_epoch']!=guard.EPOCH or guard.digest(request)!=job['digest']):return False
    state=store.target_state('worker')
    if state.get('active_job') or state.get('quarantined'):return False
    observed=host.snapshot('worker');snapshot=request['internal_recovery']
    keys={'release','pointer_owner','pointer_generation','unit_identity','invocation_id','pid','started_at'}
    return (isinstance(snapshot,dict) and set(snapshot)==keys and observed.get('active_state')=='failed'
            and observed.get('settled') is True and all(observed.get(key)==snapshot[key] for key in keys))

def bootstrap_ready(policy):
    try:
        value=read_json(Path(policy['root'])/'bootstrap-install.json',65536)
        return value.get('schema')==1 and value.get('phase')=='ready'
    except Exception:return False

def updater_tick(context, auth, engine_module, store, host_factory, github_factory, auth_reader=existing_auth):
    # Accepted durable transactions have priority and do not re-enter admission.
    running=[job for job in store.jobs() if job['state']!='QUEUED']
    if running:
        engine_module.Engine(store,host_factory(None),health_timeout=120).run(running[0]['request_id'])
    if not bootstrap_ready(context.policy):
        return {'transport':'bootstrap_pending','recovery_ran':bool(running)}
    if not store.jobs():
        try:idle_recovery_request(context.policy,store,host_factory(None))
        except Exception:pass
    if not running:
        internal=[job for job in store.jobs() if job['state']=='QUEUED' and str(job['comment_id']).startswith('internal-idle:')]
        if internal:
            job=internal[0];host=host_factory(None)
            if internal_recovery_valid(job,store,host):
                engine_module.Engine(store,host,health_timeout=120).run(job['request_id'])
                running=[job]  # At most one operation in this timer invocation.
            else:store.finish(job['request_id'],'BLOCKED',{'reason':'IDLE_RECOVERY_PRECONDITION_CHANGED'})
    try:
        context.token=auth_reader(auth)
        github=github_factory(context.token)
        bot_id=github.preflight()
    except Exception:
        return {'transport':'retry_pending','recovery_ran':bool(running)}
    if not running:
        queued=[job for job in store.jobs() if job['state']=='QUEUED']
        if queued:
            job=queued[0]
            try:
                comment=github.comment(int(job['comment_id']))
            except Exception:
                return {'transport':'retry_pending','recovery_ran':False}
            try:normalized=guard.parse_comment(comment,context.policy,time.time())
            except guard.Refused:normalized=None
            if normalized is None or normalized!=job['request'] or guard.digest(normalized)!=job['digest']:
                store.finish(job['request_id'],'BLOCKED',{'reason':'SOURCE_REQUEST_CHANGED_OR_EXPIRED'})
            else:
                engine_module.Engine(store,host_factory(github),health_timeout=120).run(job['request_id'])
    try:
        from worker import deliver_results
        deliver_results(store,github,bot_id)
    except Exception:
        return {'transport':'result_reconciliation_pending','recovery_ran':bool(running)}
    return {'transport':'ready','recovery_ran':bool(running)}

def main(argv=None):
    argv=sys.argv[1:] if argv is None else argv
    policy,auth=anchored_configuration()
    if len(argv)==3 and argv[0]=='check-updater':
        release={'sha':argv[1],'manifest_sha256':argv[2],'package':'worker-'+argv[1]}
        directory=package(policy,'worker',release)
        sys.path.insert(1,str(directory))
        captured=open(os.devnull,'w')
        with captured,contextlib.redirect_stdout(captured),contextlib.redirect_stderr(captured):
            updater=importlib.import_module('updater')
            for name in ('worker','store','runtime','github_transport'):importlib.import_module(name)
            value=updater.self_check()
            store_module=importlib.import_module('store')
            runtime_module=importlib.import_module('runtime')
            transport=importlib.import_module('github_transport')
            for cls,args in ((updater.Engine,(None,None)),(store_module.Store,('/unused',)),
                             (runtime_module.Host,(policy,None,None)),(transport.GitHub,('',policy)),(transport.Sources,(None,policy))):
                if not callable(cls):raise RecoveryRequired('CANDIDATE_INTERFACE_MISSING')
                inspect.signature(cls).bind(*args)
            with tempfile.TemporaryDirectory(prefix='deploy-candidate-check-') as scratch:
                candidate_store=store_module.Store(str(Path(scratch)/'fixture.sqlite3'))
                try:
                    candidate_engine=updater.Engine(candidate_store,object())
                    if not callable(getattr(candidate_engine,'run',None)) or candidate_engine.run_pending()!=[]:
                        raise RecoveryRequired('CANDIDATE_EMPTY_TICK_FAILED')
                    if candidate_store.db.execute('PRAGMA user_version').fetchone()[0]!=1:
                        raise RecoveryRequired('CANDIDATE_SCHEMA_CHANGED')
                finally:candidate_store.close()
        if value!={'ok':True,'store_schema':1,'engine_api':1}:raise RecoveryRequired('CANDIDATE_UPDATER_NOT_READY')
        print(json.dumps({'ok':True,'release':release},sort_keys=True));return
    if len(argv)!=2 or argv[0]!='run' or argv[1] not in ('worker','updater','probe'):
        raise RecoveryRequired('LAUNCH_MODE_REFUSED')
    role=argv[1];target='worker' if role=='updater' else role
    pointer=read_json(Path(policy['root'])/'active'/(target+'.json'))
    release=retained_recovery_release(policy['root']) if role=='updater' else None
    release=release or pointer['release']
    directory=package(policy,target,release)
    sys.path.insert(1,str(directory))
    context=types.ModuleType('_deploy_context');context.policy=policy;context.release=release;context.role=role
    context.token=None
    cached_unit_facts={}
    def heartbeat(status='healthy'):
        if status not in ('healthy','unhealthy'):raise RecoveryRequired('HEALTH_STATUS_REFUSED')
        challenge=read_json(Path(policy['root'])/'challenges'/(target+'.json'))
        if challenge['release']!=release or challenge['pointer_generation']!=pointer['generation']:
            raise RecoveryRequired('HEALTH_CHALLENGE_MISMATCH')
        if not cached_unit_facts:cached_unit_facts.update(unit_facts(policy,target))
        receipt=dict(cached_unit_facts,release=release,observed_at=time.time(),status=status,attempt_id=challenge['attempt_id'],pointer_generation=pointer['generation'])
        atomic_receipt(Path(policy['root'])/'receipts'/(target+'.json'),receipt)
    context.heartbeat=heartbeat
    context.effects_enabled=lambda:bootstrap_ready(policy)
    sys.modules['_deploy_context']=context
    if role=='worker':context.token=existing_auth(auth)
    module=importlib.import_module('worker' if role=='worker' else 'updater' if role=='updater' else 'probe')
    if role=='updater':
        from store import Store
        from runtime import Host
        from github_transport import GitHub,Sources
        store=Store(str(Path(policy['root'])/'control.sqlite3'))
        deadline=time.monotonic()+540
        def github_factory(token):return GitHub(token,policy,deadline=deadline)
        def bounded_command(argv,**kwargs):
            remaining=deadline-time.monotonic()
            if remaining<=0:raise TimeoutError('control deadline')
            limit=3 if argv[:1]==['/usr/bin/systemctl'] else 30
            kwargs['timeout']=min(kwargs.get('timeout',limit),limit,remaining)
            return subprocess.run(argv,**kwargs)
        def host_factory(github):
            host=Host(policy,Sources(github or GitHub('',policy,deadline=deadline),policy),store,runner=bounded_command)
            original_stage=host.stage
            def staged_with_recovery_reserve(job):
                value=original_stage(job)
                if deadline-time.monotonic()<360:raise RecoveryRequired('STAGING_BUDGET_RETRY_REQUIRED')
                return value
            host.stage=staged_with_recovery_reserve
            return host
        def auth_reader(value):
            remaining=deadline-time.monotonic()
            if remaining<=0:raise TimeoutError('control deadline')
            return existing_auth(value,timeout=min(40,remaining))
        result=updater_tick(context,auth,module,store,host_factory,github_factory,auth_reader)
        if result['transport']!='ready':print('CONTROL_TRANSPORT_RETRY_PENDING')
        store.close()
    else:module.main()

if __name__=='__main__':
    try:main()
    except Exception:
        print('MANUAL_RECOVERY_REQUIRED: CONTROL_LAUNCH_FAILED',file=sys.stderr)
        raise SystemExit(2)
