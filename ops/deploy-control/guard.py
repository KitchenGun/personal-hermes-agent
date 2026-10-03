"""Fixed control-plane contract. Bootstrap anchors this module outside updateable releases.

This enforces request/manifest governance for reviewed code under one Unix user;
it is not an OS isolation boundary against malicious same-user Python code.
"""
import datetime
import hashlib
import json
import re

PREFIX = 'DEPLOY_CONTROL_V1\n'
EPOCH = 'deploy-control-v1'
OPERATIONS = frozenset(('deploy.status','deploy.apply','deploy.verify','deploy.rollback',
    'deploy.update_self','deploy.restart_service','deploy.health'))
PROFILES = {'worker-v1':'worker', 'receipt-probe-v1':'probe', 'repo-verify-v1':'verify'}
SOURCE_FILES = {'worker':('worker.py','updater.py','store.py','runtime.py','github_transport.py'),
                'probe':('probe.py',)}
MAX_SOURCE = 512 * 1024

class Refused(Exception):
    pass

def strict_object(pairs):
    result={}
    for key,value in pairs:
        if key in result:raise Refused('DUPLICATE_FIELD')
        result[key]=value
    return result

def digest(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def parse_comment(comment, policy, now):
    body=comment.get('body','')
    if not isinstance(body,str) or not body.startswith(PREFIX):return None
    if len(body.encode('utf-8'))>4096:raise Refused('REQUEST_TOO_LARGE')
    control=policy['control']
    if comment.get('user',{}).get('id')!=control['author']:raise Refused('AUTHOR_REFUSED')
    if comment.get('created_at')!=comment.get('updated_at'):raise Refused('EDITED_REQUEST_REFUSED')
    try:
        created=datetime.datetime.strptime(comment['created_at'],'%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=datetime.timezone.utc).timestamp()
        request=json.loads(body[len(PREFIX):],object_pairs_hook=strict_object)
    except (KeyError,TypeError,ValueError):raise Refused('MALFORMED_REQUEST') from None
    if now-created < -60 or now-created>3600:raise Refused('REQUEST_EXPIRED')
    if not isinstance(request,dict):raise Refused('REQUEST_OBJECT_REQUIRED')
    operation=request.get('operation');profile=request.get('profile')
    if not isinstance(operation,str) or operation not in OPERATIONS or not isinstance(profile,str) or profile not in PROFILES:
        raise Refused('CAPABILITY_REFUSED')
    expected={'id','operation','profile'}
    if operation in ('deploy.apply','deploy.verify','deploy.update_self'):expected|={'repo','sha'}
    if set(request)!=expected:raise Refused('UNEXPECTED_FIELDS')
    if not isinstance(request['id'],str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,64}',request['id']):raise Refused('REQUEST_ID_INVALID')
    target=PROFILES[profile]
    if operation=='deploy.update_self' and target!='worker':raise Refused('SELF_UPDATE_TARGET_REFUSED')
    if operation=='deploy.apply' and target!='probe':raise Refused('DEPLOY_TARGET_REFUSED')
    if target=='verify' and operation!='deploy.verify':raise Refused('VERIFY_PROFILE_READONLY')
    if operation=='deploy.verify' and target!='verify':raise Refused('VERIFY_PROFILE_REQUIRED')
    if 'sha' in expected:
        if not isinstance(request.get('repo'),str) or request['repo'] not in policy['repos'] or not isinstance(request['sha'],str) or not re.fullmatch(r'[0-9a-f]{40}',request['sha']):raise Refused('SOURCE_IDENTITY_INVALID')
        if target in ('worker','probe') and request['repo']!='Hermes':raise Refused('SOURCE_REPO_REFUSED')
    return dict(request,target=target,authority_epoch=EPOCH)

def validate_manifest(raw, target, sources):
    if target not in SOURCE_FILES:raise Refused('PACKAGE_TARGET_REFUSED')
    try: manifest=json.loads(raw,object_pairs_hook=strict_object)
    except (TypeError,ValueError):raise Refused('MANIFEST_MALFORMED') from None
    expected={'schema','authority_epoch','target','files','unit_settings'}
    if not isinstance(manifest,dict) or set(manifest)!=expected or type(manifest['schema']) is not int or manifest['schema']!=1 or manifest['authority_epoch']!=EPOCH or manifest['target']!=target:
        raise Refused('AUTHORITY_ENVELOPE_CHANGED')
    files=manifest['files']
    if not isinstance(files,dict) or set(files)!=set(SOURCE_FILES[target]) or set(sources)!=set(files):raise Refused('PACKAGE_FILES_REFUSED')
    for name in SOURCE_FILES[target]:
        data=sources[name]
        if type(data) is not bytes or not 0<len(data)<=MAX_SOURCE or not isinstance(files[name],dict) or set(files[name])!={'sha256','size'}:
            raise Refused('PACKAGE_SOURCE_INVALID')
        if type(files[name]['size']) is not int or not isinstance(files[name]['sha256'],str):raise Refused('PACKAGE_SOURCE_INVALID')
        if files[name]!={'sha256':hashlib.sha256(data).hexdigest(),'size':len(data)}:raise Refused('PACKAGE_HASH_MISMATCH')
        try:compile(data,name,'exec',dont_inherit=True)
        except (SyntaxError,ValueError):raise Refused('PACKAGE_SYNTAX_REFUSED') from None
    settings=manifest['unit_settings']
    if not isinstance(settings,dict) or set(settings)!={'restart_seconds','stop_timeout_seconds'}:
        raise Refused('UNIT_SETTINGS_REFUSED')
    if any(type(settings[key]) is not int or not 5<=settings[key]<=60 for key in settings):raise Refused('UNIT_SETTINGS_REFUSED')
    return manifest

def release_identity(sha, manifest_raw, target):
    if not re.fullmatch(r'[0-9a-f]{40}',sha) or target not in SOURCE_FILES:raise Refused('RELEASE_IDENTITY_INVALID')
    return {'sha':sha,'manifest_sha256':hashlib.sha256(manifest_raw).hexdigest(),'package':target+'-'+sha}
