"""Request admission and GitHub result delivery. Operations execute in the independent updater."""
import fcntl
import json
from pathlib import Path
import subprocess
import time
import threading
import guard
from github_transport import GitHub,RemoteError
from store import Store,Conflict,TERMINAL

WORKER_VERSION = 2
FAIL_STARTUP_HEALTH = False  # A reviewed isolated bad-health release may exercise rollback.
RESULT_PREFIX = 'DEPLOY_CONTROL_RESULT_V1 '

def result_body(job):
    status=job['state']
    result={'state':status,'operation':job['operation'],'target':job['target'],'result':job['result']}
    if job['operation']=='deploy.update_self' and status=='SUCCEEDED':result['SELF_UPDATE']='PASS'
    if job['operation']=='deploy.update_self' and status=='ROLLED_BACK':result['AUTO_ROLLBACK']='PASS'
    if status=='MANUAL_RECOVERY_REQUIRED':result['MANUAL_RECOVERY_REQUIRED']='YES'
    body=RESULT_PREFIX+job['request_id']+'\n'+json.dumps(result,sort_keys=True,separators=(',',':'))
    if len(body.encode())>16384:
        body=RESULT_PREFIX+job['request_id']+'\n'+json.dumps({'state':status,'operation':job['operation'],'result':'DETAILS_RETAINED_IN_LOCAL_JOURNAL'},sort_keys=True)
    return body

def _deliver_results(store,github,bot_id):
    for job in store.jobs(include_terminal=True):
        if job['state'] in TERMINAL:
            marker=RESULT_PREFIX+job['request_id']+'\n'
            store.enqueue_outbox('terminal:'+job['request_id'],job['request_id'],result_body(job),marker)
    pending=store.outbox_pending()
    if not pending:return
    comments=github.comments()
    for item in pending[:10]:
        matches=[c for c in comments if c.get('user',{}).get('id')==bot_id and c.get('body','').startswith(item['marker'])]
        if matches:
            if item['state']=='PENDING':store.outbox_uncertain(item['item_key'])
            store.outbox_delivered(item['item_key'],str(matches[-1]['id']));continue
        if item['state']=='UNCERTAIN':continue
        store.outbox_uncertain(item['item_key'])
        result=github.post(item['body'])
        store.outbox_delivered(item['item_key'],str(result['id']))

def deliver_results(store,github,bot_id):
    with open(store.path+'.outbox.lock','a+b') as lock:
        try:fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:return
        _deliver_results(store,github,bot_id)


def admit_cycle(store,github,policy,now):
    admitted=False
    for comment in github.comments():
        try:
            request=guard.parse_comment(comment,policy,now)
            if request is None:continue
            job,created=store.accept(request['id'],guard.digest(request),comment['id'],request)
            admitted=admitted or created
        except (guard.Refused,Conflict):
            continue
    return admitted

def main():
    import _deploy_context as context
    if FAIL_STARTUP_HEALTH:
        context.heartbeat('unhealthy')
        raise SystemExit(42)
    policy=context.policy;root=Path(policy['root'])
    with open(str(root/'request-worker.lock'),'a+b') as lock:
        fcntl.flock(lock.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        store=Store(str(root/'control.sqlite3'))
        github=GitHub(context.token,policy);bot_id=None;delay=15;heartbeat_started=False
        while True:
            try:
                if bot_id is None:bot_id=github.preflight()
                admitted=admit_cycle(store,github,policy,time.time())
                if context.effects_enabled() and (admitted or store.jobs()):
                    try:
                        subprocess.run(['/usr/bin/systemctl','--user','start','--no-block',policy['services']['updater']],
                            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=10)
                    except (OSError,subprocess.TimeoutExpired):pass  # Independent timer also wakes pending work.
                deliver_results(store,github,bot_id)
                context.heartbeat('healthy')
                if not heartbeat_started:
                    def pulse():
                        while True:
                            time.sleep(5)
                            try:context.heartbeat('healthy')
                            except Exception:pass
                    threading.Thread(target=pulse,daemon=True).start()
                    heartbeat_started=True
                delay=15
            except RemoteError:
                delay=min(300,delay*2)
            time.sleep(delay)
