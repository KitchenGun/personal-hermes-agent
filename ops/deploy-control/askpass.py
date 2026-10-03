#!/usr/bin/python3 -ISB
"""Git-only in-memory auth reply for the fixed HTTPS GitHub origin."""
import os
import re
import sys
if len(sys.argv)!=2:raise SystemExit(1)
prompt=sys.argv[1]
if re.fullmatch(r"Username for 'https://github\.com(?::443)?(?:/[^'\s]*)?': ?",prompt):
    print('x-access-token')
elif re.fullmatch(r"Password for 'https://x-access-token@github\.com(?::443)?(?:/[^'\s]*)?': ?",prompt):
    print(os.environ.get('DEPLOY_GITHUB_TOKEN',''))
else:raise SystemExit(1)
