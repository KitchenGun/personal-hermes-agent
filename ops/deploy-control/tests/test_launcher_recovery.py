import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock,patch
import launcher
from store import Store

class RecoveryAdmissionTests(unittest.TestCase):
    def setUp(self):
        gate=patch.object(launcher,'bootstrap_ready',return_value=True);gate.start();self.addCleanup(gate.stop)
    def test_running_intent_recovers_before_auth_failure_and_without_new_admission(self):
        store=Mock();store.jobs.return_value=[{'state':'RUNNING','request_id':'accepted_old'}]
        engine=Mock();engine.Engine.return_value.run=Mock()
        events=[]
        engine.Engine.return_value.run.side_effect=lambda rid:events.append('recovery')
        def unavailable(auth):events.append('auth');raise RuntimeError('offline')
        with patch.object(launcher.guard,'parse_comment',side_effect=AssertionError('must not re-admit')):
            result=launcher.updater_tick(types.SimpleNamespace(policy={}),{},engine,store,lambda g:Mock(),Mock(),unavailable)
        self.assertEqual(events,['recovery','auth'])
        self.assertEqual(result['transport'],'retry_pending')
        store.finish.assert_not_called()
    def test_edited_or_expired_queued_request_blocks_without_effect(self):
        store=Mock();store.jobs.return_value=[{'state':'QUEUED','request_id':'new_request','comment_id':1,'request':{},'digest':'x'}]
        github=Mock();github.preflight.return_value=1
        engine=Mock()
        with patch.object(launcher.guard,'parse_comment',side_effect=launcher.guard.Refused('EDITED_REQUEST_REFUSED')),patch('worker.deliver_results'):
            launcher.updater_tick(types.SimpleNamespace(policy={}),{},engine,store,lambda g:Mock(),lambda t:github,lambda a:'synthetic')
        engine.Engine.assert_not_called()
        store.finish.assert_called_once_with('new_request','BLOCKED',{'reason':'SOURCE_REQUEST_CHANGED_OR_EXPIRED'})
    def test_queued_api_failure_leaves_request_queued(self):
        store=Mock();store.jobs.return_value=[{'state':'QUEUED','request_id':'new_request','comment_id':1}]
        github=Mock();github.comment.side_effect=RuntimeError('offline')
        engine=Mock()
        result=launcher.updater_tick(types.SimpleNamespace(policy={}),{},engine,store,lambda g:Mock(),lambda t:github,lambda a:'synthetic')
        self.assertEqual(result['transport'],'retry_pending');store.finish.assert_not_called();engine.Engine.assert_not_called()
    def test_bootstrap_activation_gate_holds_preposted_request_without_blocking_recovery(self):
        store=Mock();store.jobs.return_value=[{'state':'QUEUED','request_id':'preposted','comment_id':1}]
        engine=Mock();auth=Mock()
        with patch.object(launcher,'bootstrap_ready',return_value=False):
            result=launcher.updater_tick(types.SimpleNamespace(policy={}),{},engine,store,Mock(),Mock(),auth)
        self.assertEqual(result['transport'],'bootstrap_pending');engine.Engine.assert_not_called();auth.assert_not_called()
        store.jobs.return_value=[{'state':'RUNNING','request_id':'accepted'}]
        with patch.object(launcher,'bootstrap_ready',return_value=False):
            result=launcher.updater_tick(types.SimpleNamespace(policy={}),{},engine,store,Mock(),Mock(),auth)
        engine.Engine.return_value.run.assert_called_once_with('accepted')
        self.assertTrue(result['recovery_ran'])

    def test_anchored_schema_selects_retained_manifest_before_candidate_import(self):
        with tempfile.TemporaryDirectory() as root:
            store=Store(str(Path(root)/'control.sqlite3'))
            request={'operation':'deploy.update_self','target':'worker'}
            store.accept('request_01','digest',1,request)
            old={'sha':'a'*40,'manifest_sha256':'b'*64,'package':'worker-'+'a'*40}
            store.prepare('request_01',{'old':{'release':old}})
            self.assertEqual(launcher.retained_recovery_release(root),old)
            store.close()
    def test_candidate_package_identity_cannot_escape_fixed_root(self):
        with self.assertRaises(launcher.RecoveryRequired):
            launcher.package({'root':'/unused'},'worker',{'sha':'../bad','manifest_sha256':'x','package':'evil'})
