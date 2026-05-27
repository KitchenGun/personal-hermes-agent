# AGENTS.md

## VM 접속
- 기본 SSH target: `ubuntu@168.107.10.142`
- WSL key: `/home/kang/.ssh/oracle_hermes_vm_ed25519`
- 접속 명령: `ssh -i /home/kang/.ssh/oracle_hermes_vm_ed25519 ubuntu@168.107.10.142`
- 터널 서비스: `oracle-hermes-pc-ssh-tunnel.service`, `oracle-hermes-vm-dashboard-tunnel.service`

## Git 규칙
- 이 프로젝트의 커밋 제목/본문과 push 관련 보고는 항상 한국어로 작성한다.
- VM runtime 변경 전에 `git status --short`, `git diff --stat`를 확인하고 unrelated dirty change는 보존한다.
- 기본 브랜치 직접 push는 사용자가 명시한 경우에만 수행한다.
