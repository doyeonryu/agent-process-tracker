# Agent Process Tracker

[English](README.md) | **한국어**

VS Code 안에서 **Claude Code의 에이전트와 서브에이전트**가 일하는 모습을 실시간으로 보여주는 확장입니다. 누가 누구에게 일을 맡겼는지, 각 에이전트가 지금 무엇을 하고 무엇을 기다리는지, 어떤 결과를 돌려줬는지 한눈에 볼 수 있습니다.

- **에이전트 트리**: 메인 대화가 맨 위에 있고 서브에이전트가 그 아래로 뻗어 나갑니다. 같은 계층의 에이전트는 옆으로 나란히 놓입니다.
- **실시간 상태**: Working(작업 중), Waiting(하위 작업이나 다른 에이전트를 기다리는 중), Needs approval(승인 대기), Done(완료), Failed(실패), Idle(사용자 입력 대기). 한동안 아무 활동이 없는 에이전트에는 경고가 붙습니다.
- **소통 흐름**: 서브에이전트에게 내려가는 지시(Task), 올라오는 결과(Result), 에이전트끼리 주고받는 메시지(Message)를 움직이는 화살표로 보여줍니다. 하단의 대화 로그에는 이 모든 소통이 시간순으로 쌓입니다.
- **에이전트별 사이드바**: 받은 지시(Task), 목적(Goal), 과정(Process: 툴 호출, 하위 에이전트 생성, 메시지, 대기를 담은 타임라인), 결과(Result: 누구에게 보냈는지 포함)를 보여줍니다.
- **확인된 정보와 추정 구분**: 로그에서 직접 읽은 것이 아니라 추정한 정보에는 `inferred` 표시가 붙습니다.

> 현재 상태: 초기 버전(0.1). 지금은 Claude Code만 지원하며, Codex CLI 지원을 준비하고 있습니다.

## 설치

1. [Releases](https://github.com/doyeonryu/agent-process-tracker/releases)에서 `agent-process-tracker-<버전>.vsix`를 내려받습니다.
2. 설치합니다.
   ```sh
   code --install-extension agent-process-tracker-0.1.4.vsix
   ```
   VS Code에서 설치하려면 확장 탭 → `…` → **Install from VSIX…**를 선택합니다.

## 사용법

Claude Code를 쓰는 작업 폴더를 VS Code로 연 다음, 아래 중 하나를 실행합니다.

- 에디터 오른쪽 위 제목 표시줄의 트래커 버튼
- `Ctrl+Alt+A` (macOS는 `Cmd+Alt+A`)
- 명령 팔레트 → **Agent Tracker**
- 어디서든 실행 가능한 명령(Claude Code 슬래시 명령 포함): `code --open-url "vscode://doyeonryu.agent-process-tracker/open"`

패널은 에디터 옆에 열리고, 그 작업 폴더의 가장 최근 Claude Code 세션을 자동으로 따라갑니다. VS Code 창마다 각자의 작업 폴더를 추적합니다. 이전 세션을 보려면 헤더의 세션 드롭다운을 쓰거나 **Agent Tracker: Pick Session…**을 실행하세요. **Follow latest**를 끄면 선택한 세션에 고정됩니다.

| 조작 | |
|---|---|
| `Ctrl` + 스크롤 | 마우스 커서 위치 기준 확대/축소 |
| `Shift` + 스크롤 / 드래그 | 화면 이동 |
| `F` | 전체가 보이게 맞춤 |
| 블록 클릭 | Task → Goal → Process → Result 사이드바 열기 |
| 로그 줄 클릭 | 전문과 출처 펼치기 |
| `Esc` | 선택 해제 |

### WSL

- **Windows VS Code 창 + WSL 터미널에서 Claude Code 실행**: 별도 설정 없이 동작합니다. 확장이 모든 WSL 배포판의 `~/.claude/projects`도 함께 검색하고(`\\wsl.localhost\…` 경유), `e:\work\app`을 WSL의 Claude Code가 쓰는 `/mnt/e/work/app` 폴더와 연결합니다.
- **VS Code를 WSL에 연결해서 사용**(왼쪽 아래에 `WSL: <배포판>` 표시): 확장 탭에서 Agent Tracker의 **Install in WSL**을 한 번 누르면 됩니다.

### 선택 사항: Claude Code에 `/tracker` 슬래시 명령 추가

아래 내용을 `~/.claude/commands/tracker.md`로 저장합니다.

```markdown
Open the Agent Tracker panel by running this shell command, then reply "Opened.":
code --open-url "vscode://doyeonryu.agent-process-tracker/open"
```

## 동작 원리

Claude Code는 세션마다 대화 기록(트랜스크립트)을 남깁니다.

```
~/.claude/projects/<작업 폴더 경로, 영숫자 외 문자는 '-'로 치환>/
  <세션>.jsonl                          메인 대화
  <세션>/subagents/agent-<id>.jsonl     서브에이전트별 대화
  <세션>/subagents/agent-<id>.meta.json 부모의 Agent 호출과 연결하는 정보
```

확장은 이 파일들을 주기적으로 확인해서 새로 추가된 부분만 읽고, 각 줄을 이벤트로 변환합니다.

| 화면 표시 | 출처 | |
|---|---|---|
| Task (서브에이전트 생성) | 부모의 `Agent` 툴 호출: description, 타입, 프롬프트 | 확인 |
| 툴 활동 | 서브에이전트 로그의 `tool_use` 항목 | 확인 |
| Result | `SubagentHandback`, `<task-notification>`, 또는 `Agent` 툴 결과 | 확인 |
| Message | `SendMessage` 툴 호출 | 확인 |
| 하위 작업 대기 | 아직 결과가 오지 않은 `Agent` 호출 | 확인 |
| 실행 중 또는 승인 대기 | *n*초가 지나도 결과가 없는 Bash/Edit/Write 등의 호출 | **추정** |
| 활동 없음 경고 | 에이전트의 마지막 로그 이후 경과 시간 | 확인 |

**개인정보:** 모든 처리는 내 컴퓨터 안에서만 이루어집니다. 확장은 로컬 파일만 읽으며, 네트워크 요청이나 사용 통계 수집을 하지 않습니다.

## 설정

| 설정 | 기본값 | |
|---|---|---|
| `agentTracker.staleSeconds` | `60` | 작업 중인 에이전트가 이 시간(초) 동안 활동이 없으면 경고 |
| `agentTracker.approvalHintSeconds` | `8` | 승인이 필요한 툴의 결과가 이 시간(초) 동안 없으면 "실행 중 또는 승인 대기"로 표시 |
| `agentTracker.claudeConfigDir` | `""` | Claude 설정 폴더 직접 지정 (기본값: `$CLAUDE_CONFIG_DIR` 또는 `~/.claude`) |

## 개발

외부 의존성과 빌드 단계가 없는 순수 Node.js 확장입니다.

```sh
npm test               # 파서와 로그 위치 탐색 테스트 (가짜 데이터만 사용)
npm run package        # @vscode/vsce로 .vsix 빌드
```

- `src/parser.js`: 로그 줄 → 이벤트 변환 (순수 함수, 단위 테스트 포함)
- `src/tail.js`: 메인과 서브에이전트 로그를 새로 추가된 부분만 읽는 모듈
- `src/locate.js`: 작업 폴더 → 로그 폴더 찾기, 세션 목록
- `src/extension.js`: 명령 등록, 웹뷰 패널, 세션 전환
- `media/index.html`: 화면. 브라우저에서 바로 열면 가상의 에이전트로 움직이는 **데모**를 볼 수 있습니다.

이 폴더를 VS Code로 열고 `F5`를 누르면 확장 개발용 VS Code 창(Extension Development Host)이 실행됩니다.

**릴리스 방법:** `package.json`의 `version`을 올리고 `CHANGELOG.md`에 `## x.y.z` 항목을 추가한 뒤 `vx.y.z` 태그를 push합니다. GitHub Actions가 테스트를 돌리고 `.vsix`를 빌드한 다음, 해당 CHANGELOG 내용으로 Release를 만들어 줍니다.

**실제 로그는 절대 커밋하지 마세요.** 대화 내용이 그대로 들어 있습니다. 테스트에는 직접 만든 가짜 데이터만 사용합니다.

## 로드맵

- Codex CLI 세션 지원 (`~/.codex/sessions`)
- Claude Code hooks를 이용한 승인 대기 상태 정확히 표시
- VS Code Marketplace / Open VSX 배포

## 라이선스

[MIT](LICENSE)
