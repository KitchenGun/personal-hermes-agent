import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import Mock,patch
import guard
import github_transport as transport
import worker
import launcher
from store import Store

POLICY={'control':{'repo':'example/control','repo_id':1,'issue':2,'author':41},'repos':{'Hermes':{'repo':'example/hermes','id':2,'branch':'main','private':False},'KIS':{'repo':'example/kis','id':3,'branch':'master','private':True}},'root':'/unused','askpass':'/fixed/askpass.py'}
NOW=guard.datetime.datetime(2026,10,3,tzinfo=guard.datetime.timezone.utc).timestamp()

def comment(value):return {'id':12,'user':{'id':41},'created_at':'2026-10-03T00:00:00Z','updated_at':'2026-10-03T00:00:00Z','body':guard.PREFIX+json.dumps(value)}
def request():return {'id':'request_01','operation':'deploy.update_self','repo':'Hermes','sha':'a'*40,'profile':'worker-v1'}
def manifest():
    source={name:b'VALUE = 1\n' for name in guard.SOURCE_FILES['worker']}
    value={'schema':1,'authority_epoch':guard.EPOCH,'target':'worker','files':{name:{'sha256':hashlib.sha256(data).hexdigest(),'size':len(data)} for name,data in source.items()},'unit_settings':{'restart_seconds':5,'stop_timeout_seconds':15}}
    return value,source

class GuardTests(unittest.TestCase):
    def test_exact_request_normalizes_fixed_target(self):
        result=guard.parse_comment(comment(request()),POLICY,NOW)
        self.assertEqual(result['target'],'worker');self.assertEqual(result['authority_epoch'],guard.EPOCH)
    def test_arbitrary_command_path_service_and_url_refused(self):
        for key in ('command','path','service','url','env'):
            value=request();value[key]='untrusted'
            with self.assertRaises(guard.Refused):guard.parse_comment(comment(value),POLICY,NOW)
    def test_other_author_edited_expired_and_short_sha_refused(self):
        bad=comment(request());bad['user']['id']=42
        with self.assertRaises(guard.Refused):guard.parse_comment(bad,POLICY,NOW)
        bad=comment(request());bad['updated_at']='2026-10-03T00:00:01Z'
        with self.assertRaises(guard.Refused):guard.parse_comment(bad,POLICY,NOW)
        with self.assertRaises(guard.Refused):guard.parse_comment(comment(request()),POLICY,NOW+3601)
        value=request();value['sha']='abcdef'
        with self.assertRaises(guard.Refused):guard.parse_comment(comment(value),POLICY,NOW)
    def test_manifest_cannot_expand_authority_files_or_units(self):
        for field,value in (('authority_epoch','new-authority'),('shell','rm'),('schema',True)):
            body,files=manifest();body[field]=value
            with self.assertRaises(guard.Refused):guard.validate_manifest(json.dumps(body),'worker',files)
        body,files=manifest();body['unit_settings']['User']='root'
        with self.assertRaises(guard.Refused):guard.validate_manifest(json.dumps(body),'worker',files)
        body,files=manifest();files['guard.py']=b'changed'
        with self.assertRaises(guard.Refused):guard.validate_manifest(json.dumps(body),'worker',files)
    def test_changed_file_hash_refused(self):
        body,files=manifest();files['worker.py']+=b'#changed'
        with self.assertRaises(guard.Refused):guard.validate_manifest(json.dumps(body),'worker',files)
    def test_good_manifest_passes(self):
        body,files=manifest();self.assertEqual(guard.validate_manifest(json.dumps(body),'worker',files),body)

class TransportTests(unittest.TestCase):
    def test_expired_budget_never_starts_http_child(self):
        github=transport.GitHub('private-token',POLICY,deadline=time.monotonic()-1)
        with patch.object(transport.subprocess,'run') as run:
            with self.assertRaises(transport.RemoteError):github.api('/user')
        run.assert_not_called()
    def test_http_token_only_in_private_input_not_argv(self):
        github=transport.GitHub('private-token',POLICY,deadline=time.monotonic()+5)
        with patch.object(transport.subprocess,'run',return_value=Mock(returncode=0,stdout=b'{"id":41}')) as run:
            self.assertEqual(github.api('/user'),{'id':41})
        self.assertNotIn('private-token',repr(run.call_args.args))
        self.assertLessEqual(run.call_args.kwargs['timeout'],5)
        self.assertEqual(run.call_args.args[0][1:4],['-I','-S','-B'])
    def test_unrelated_repo_and_write_endpoint_refused(self):
        github=transport.GitHub('private',POLICY)
        with patch.object(transport.subprocess,'run') as run:
            for path,data in (('/repos/other/private',None),('/repos/example/control/issues/1/comments',{'body':'x'})):
                with self.assertRaises(transport.RemoteError):github.api(path,data)
        run.assert_not_called()
    def test_git_timeout_kills_only_own_process_group(self):
        github=transport.GitHub('private',POLICY)
        process=Mock(pid=1234,args=['git']);process.communicate.side_effect=[subprocess.TimeoutExpired('git',1),(b'',b'')]
        with patch.object(transport.subprocess,'Popen',return_value=process),patch.object(transport.os,'killpg') as kill:
            with self.assertRaises(transport.RemoteError):transport.Sources(github,POLICY).git(['fetch'])
        kill.assert_called_once_with(1234,transport.signal.SIGKILL)

class IdleRecoveryTests(unittest.TestCase):
    def test_only_idle_positive_failure_is_eligible(self):
        with tempfile.TemporaryDirectory() as root:
            store=Store(str(Path(root)/'control.sqlite3'));host=Mock()
            base={'release':{'sha':'a'*40},'pointer_owner':'seed','pointer_generation':'b'*32,'unit_identity':'unit','invocation_id':'old','pid':12,'started_at':1,'settled':True}
            for state in ('active','inactive','activating'):
                host.snapshot.return_value=dict(base,active_state=state)
                self.assertIsNone(launcher.idle_recovery_request({'root':root},store,host))
            host.snapshot.return_value=dict(base,active_state='failed')
            identifier=launcher.idle_recovery_request({'root':root},store,host)
            self.assertTrue(identifier.startswith('idle_'))
            self.assertTrue(launcher.internal_recovery_valid(store.get(identifier),store,host))
            self.assertIsNone(launcher.idle_recovery_request({'root':root},store,host))
            store.close()
    def test_quarantine_never_idle_restarted(self):
        store=Mock();store.target_state.return_value={'quarantined':1};host=Mock()
        self.assertIsNone(launcher.idle_recovery_request({'root':'/unused'},store,host));host.snapshot.assert_not_called()
