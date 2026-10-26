# Karma LAN 중앙 서버

**3.9.0:** 중위~대장과 검증 실전 경험 요건, 충분한 표본을 이용한 주간 승급 기준 조정, 24시간 변경 예고 및 획득 계급 보존을 제공합니다. 대시보드에서 관찰 현황과 기준을 확인할 수 있습니다. [운영·검증 상세](RELEASE-3.9.0.md).

같은 LAN에서 실행하는 Karma290 클라이언트의 계정, 방 관리, 메시지 전달, 계급·경험치·전적·출전 장비 저장, 무기 습득 소유권을 담당합니다. Node.js 20 이상이 필요합니다. 이메일 전송 라이브러리 Nodemailer 버전을 lockfile에 고정하며 그 밖의 서버 기능은 Node 기본 모듈을 사용합니다.

클라이언트 v0.6.2는 **1:1, 4:4 팀전, 2~8인 개인 데스매치**와 **Mass of Winter·Factory·Rescue**를 지원합니다. 계급별 캐릭터 해금, 돌격·저격·중화기 병과와 XP 6,000 쌍포 조합은 서버에서 검증합니다. [병과 규칙](CLASS_BALANCE.md)을 참고하세요. 원본 게임 8개 동시 검사는 한 Windows PC에서, 물리 PC 간 대전은 두 PC로 확인했습니다. 서버의 최대 20개 방 × 8명 검사는 모의 통신 부하이며 실제 160명 플레이 검증은 아닙니다.

200번 서버에 학과 거래소를 운영합니다. 대전 시작 시 참가자별 1 KARMA를 차감하고 시작 실패 시 반환하며, 대기실·로컬 연습은 무료입니다. 정상 시작 수입의 80%는 공동 금고 활동 재원, 20%는 예비금으로 남습니다. 활동 보상과 신규 체험 100 KARMA를 금고에서 지급하고, 미션 게시판·학생 서비스 장터·코인 순환 대시보드를 제공합니다. 기존 잔액과 최초 지급 기록은 보존합니다. 예산·양도·사설 코인 발행·거래 및 배포 설정은 [거래소 운영 문서](exchange/README.md)에 있습니다. 100번의 기존 HollaEx 허니팟은 유지합니다.

대기실은 **방 이름**과 참가자의 **준비 상태**를 표시합니다. 입장 시 미준비이며 장비 변경 시 준비를 해제합니다. 모드별 최소 인원·팀 조건을 충족하고 현재 참가자 모두가 준비했을 때 방장만 시작할 수 있습니다. 이용료 확인 중 준비나 참가자가 바뀌면 시작을 취소하고 환불합니다. 진행 중 개인전의 빈자리 참가는 별도 흐름으로 유지합니다.

코인 정산은 200번 서버의 **Besu QBFT 블록체인**에서 확정합니다. 게임 이용료는 관리자 개인 계정이 아닌 **학과 공동 금고**로 이동합니다. 발행·양도·주문 예약과 체결·게임 이용료·환불까지 실제 ERC-20 잔액을 변경하며, 거래소에서 거래 영수증을 확인할 수 있습니다. 운영 범위와 키·백업·복구 절차는 [블록체인 문서](exchange/CHAIN.md)에 있습니다.

방장은 개인전 1~30킬, 팀전 1~10승, 전체 경기 1~30분을 선택합니다. 목표 점수 또는 시간에 도달하면 결과를 저장하고 클라이언트에서 퇴장할 때까지 보여 줍니다. Shift Point는 이번 경기의 확정 경험치입니다. [3.6.0 변경 내용](RELEASE-3.6.0.md)

## 실행과 검사

```sh
cd /home/ccc/pjt/karma_server
npm ci --omit=dev
npm test
EMAIL_VERIFICATION=off KARMA_HOST=192.168.12.100 node server.mjs
```

실제 배포는 `TLS_CERT`와 `TLS_KEY`를 설정해 TCP29020과 웹29021 모두 TLS로 실행합니다. 클라이언트에는 공개 인증서만 배포하고 CA 검증을 유지합니다. `rejectUnauthorized:false`를 사용하지 않습니다. 인증서에 `192.168.12.100` IP SAN이 있으면 `curl --cacert data/certs/server-cert.pem https://192.168.12.100:29021/health`로 확인할 수 있습니다.

설정은 환경변수입니다.

| 이름 | 기본값 | 용도 |
| --- | --- | --- |
| `KARMA_HOST` | `0.0.0.0` | 게임 TCP 수신 주소 |
| `KARMA_PORT` | `29020` | 게임 TCP 포트 |
| `KARMA_HEALTH_HOST` | `KARMA_HOST` | 상태 HTTP 수신 주소 |
| `KARMA_HEALTH_PORT` | `29021` | 상태 HTTP 포트 |
| `KARMA_DATA_DIR` | 서버 폴더의 `data` | 저장 데이터 디렉터리 |
| `EMAIL_VERIFICATION` | `required` | 현재 배포는 사용자 요청에 따라 `off`. 나중에 `required`로 변경 |
| `TLS_CERT`, `TLS_KEY` | 없음 | PEM 인증서/개인키 파일의 절대 경로. 반드시 함께 설정 |
| `SMTP_HOST`, `SMTP_FROM` | 없음 | 메일 서버 및 발신 주소. 인증 필수 모드에서 필요 |
| `SMTP_PORT`, `SMTP_SECURE` | `587`, false | 587 STARTTLS 또는 465 TLS |
| `SMTP_USER`, `SMTP_PASS` | 없음 | 메일 서버 인증 정보 |
| `SMTP_SERVERNAME` | 없음 | SMTP_HOST가 IP인 경우 검증할 인증서 호스트명 |

`data/profiles.json`은 플레이어 ID, 이름, XP, 킬·데스·승패, 경기 결과, 중복 보상 방지 기록과 캐릭터별 출전 장비를 보관합니다. `data/auth.json`은 계정, 개별 salt를 사용한 scrypt 비밀번호 해시, 로그인 세션 토큰의 해시·만료시각을 보관합니다. 변경은 임시 파일을 동기화한 후 원래 파일로 교체합니다. 잘못된 기존 DB를 초기화하지 않습니다. 비밀번호·인증번호·토큰 원문은 DB나 로그에 저장하지 않습니다.

단일 Node 서버 프로세스가 이 파일을 소유합니다. 복수 서버 프로세스에서 같은 DB 파일을 공유하지 않습니다. 관리 CLI로 계정을 추가하거나 중지할 수 있으며 실행 중 서버는 변경을 다시 읽습니다. 서버를 정지한 뒤 `data` 디렉터리를 복사해 백업할 수 있습니다. 방과 진행 중인 드롭은 메모리에 있으며 서버 재시작 시 대전이 끝납니다. 1:1은 상대 이탈 시 종료합니다. 개인전은 2명 이상 남으면, 팀전은 양쪽에 인원이 남으면 계속됩니다. 저장된 XP와 장비 선택은 유지됩니다.

`karma-server.service`는 사용자 systemd 예제입니다. 실제 Node 경로를 확인하고 `~/.config/systemd/user/karma-server.service`에 배치한 뒤 사용합니다.

```sh
systemctl --user daemon-reload
systemctl --user enable --now karma-server.service
systemctl --user status karma-server.service
journalctl --user -u karma-server.service -n 50
```

## 회원가입·로그인

현재 LAN 배포는 `EMAIL_VERIFICATION=off`이며 이메일·비밀번호·이름으로 가입을 신청합니다. 신규 계정은 **관리자 승인 대기**로 저장되고, 승인 전에는 로그인·게임 접속·거래소 이용이 차단됩니다. 이메일은 `emailVerified:false`로 기록합니다.

관리자는 대시보드의 **사용자 관리 → 가입 승인**으로 계정을 승인합니다. 승인 대기자는 목록 위에 표시되며 승인자·시각과 활동 기록을 남깁니다. 기존 계정은 계속 사용할 수 있습니다. 승인 여부와 사용 중지는 별도 상태이며, 사용 중지 해제로 가입 승인을 우회할 수 없습니다. 이메일 인증을 나중에 켜도 인증 완료 후 관리자 승인이 필요합니다. 체험 코인은 승인 후 첫 지갑 생성 때 한 번 지급됩니다.

나중에 `EMAIL_VERIFICATION=required`와 SMTP 설정을 적용하면 인증번호를 실제 메일로 보냅니다. 코드 유효기간 10분, 재전송 간격 60초, 코드 입력 최대 5회이며 이메일/IP별 요청 제한이 있습니다. SMTP가 없거나 전송이 실패하면 가입은 503 오류로 중단합니다. 메일 전송은 TLS 인증서를 확인하며 STARTTLS 또는 TLS를 사용합니다.

비밀번호는 8~128자, 이름은 공백 제거 후 1~32자입니다. 이메일은 공백 제거 후 소문자로 정규화합니다. 로그인 세션은 12시간입니다.

| 요청 | 본문 / 응답 |
| --- | --- |
| `GET /api/auth-config` | `{emailVerificationRequired,registrationAvailable,registrationApprovalRequired:true}` |
| `POST /auth/register/request` | `{email,password,name}`. 인증 off: `{ok:true,requiresVerification:false,approvalRequired:true,approvalStatus:'pending',message}`. 인증 required: `{ok:true,requiresVerification:true,expiresIn:600,resendAfter:60}` |
| `POST /auth/register/verify` | `{email,code}` → `{ok:true,requiresVerification:false,approvalRequired:true,approvalStatus:'pending',message}` |
| `POST /auth/login` | `{email,password}` → `{ok:true,authToken,expiresAt,profile}` |
| `POST /auth/logout` | `Authorization: Bearer <authToken>` → `{ok:true}` |

인증 오류는 `{ok:false,error:{code,message}}`와 적절한 HTTP400/401/403/409/429/503 상태로 반환합니다. 클라이언트는 가입·로그인 응답의 토큰을 보관하고 이후 HTTPS API 및 게임 접속에 사용합니다.

관리자 최초 생성은 서버 PC의 관리 CLI에서 수행합니다. 비밀번호를 명령 인자에 넣지 않습니다. TTY에서는 `Password (hidden):` 입력의 화면 표시를 끄며 Enter 한 번으로 완료됩니다. 파이프 입력도 첫 줄을 읽습니다. 자동화가 필요한 경우 `KARMA_ADMIN_PASSWORD` 환경변수를 지원하지만 파일이나 저장소에 기록하지 않습니다.

```sh
node admin.mjs create-admin administrator@example.com
node admin.mjs list
node admin.mjs disable user@example.com
node admin.mjs enable user@example.com
node admin.mjs reset-pass user@example.com
```

`create-admin`은 관리자 요청으로 직접 승인한 계정을 생성합니다. `reset-pass`는 해당 사용자의 기존 로그인 세션을 폐기합니다. 사용 중지된 사용자의 진행 중 연결은 최대 5초 안에 닫힙니다.

## 웹 대시보드와 사용자 관리

서버의 `/`는 `public` 디렉터리의 한국어 웹 화면을 제공합니다. 상태 `/health`와 가입 설정 `/api/auth-config`를 제외한 아래 API는 `Authorization: Bearer <authToken>`이 필요합니다.

| API | 응답 / 권한 |
| --- | --- |
| `GET /api/me` | `profile`, 본인 `activity`, `catalog:{characters,weapons,ranks,slots}` |
| `GET /api/leaderboard` | XP·킬 기준 상위 200명 `players`. 이메일·인증 정보 제외 |
| `GET /api/dashboard` | `summary`, 현재 `rooms`, 최근 `activity` |
| `GET /api/admin/users` | 관리자만. 계정별 전적·장비와 이메일·가입 승인·사용 중지 상태 |
| `PATCH /api/admin/users/:id` | 관리자만. 승인 요청은 `{approvalStatus:'approved'}` 단독. 기록 수정은 `disabled,xp,kills,deaths,wins,losses,draws,matches,loadouts` 중 변경 필드 |

현재 대전 중인 사용자의 전적·장비 수정은 종료 후 가능합니다. 사용 중지는 즉시 연결에 반영합니다. 경기 수는 승·패·무 합계와 일치해야 하며, 장비 수정은 원본 비용과 슬롯·계급 한도를 다시 검증합니다. 관리자 변경에는 관리자 ID, 대상 ID, 변경 필드의 감사 기록을 남깁니다. 토큰이나 비밀번호 값은 기록하지 않습니다.

1대1 기본 경기 종료 조건은 **10킬 또는 10분**입니다. 시간 종료 시 킬이 같은 경우 무승부입니다. 시작 이후 연결 종료는 기권패이며 시작 전 대기는 전적에 포함하지 않습니다. 결과는 경기 ID당 한 번만 저장하고 `match-ended`로 클라이언트에 알립니다. 정상 서버 종료는 기권 전적으로 처리하지 않습니다.

4:4 팀전은 참가 슬롯을 번갈아 두 팀에 배정하고 양끝에서 시작합니다. 한 팀 전멸 또는 3분 제한으로 라운드가 끝나고 5초 후 모두 함께 부활합니다. 생존자가 많은 팀이 시간 종료 라운드의 승자이며 같으면 무승부입니다. 라운드 중 부활과 아군 피해를 거절합니다. 5라운드 선승 또는 전체 10분으로 경기를 마치고, 전체 시간 종료는 라운드 승수 다음 팀 킬 합계로 비교합니다.

개인전은 2~8명이며 죽은 뒤 10초 이전의 새 생명을 거절합니다. 같은 생명에서 HP만 올려 사망을 취소하는 것도 거절합니다. 10킬 또는 10분에 개인별 순위를 결정합니다. 1:1의 부활 대기는 약 4.5초입니다.

## 프로토콜 2

TCP 한 줄마다 JSON 객체 하나를 전달합니다. 한 메시지 최대 64 KiB, 연결 입력 버퍼 최대 128 KiB, 연결당 초당 최대 500개 메시지입니다. 게임의 기존 protocol 1 메시지는 `game.message` 내부에 보관합니다.

입장:

```json
{"type":"hello","version":2,"op":"create","authToken":"login-response-token","clientMaxPlayers":8,"maxPlayers":8,"mode":"tdm","manualStart":true,"config":{"age":0,"map":0,"character":{"index":0,"camp":0},"inventory":[50,9,1,6,48,24,18],"selectedWeapon":9,"settings":{"build":"karma290-central5"}}}
```

참가는 `op:"join", code:"123456"`을 사용합니다. 모든 접속에 로그인 `authToken`이 필수이며 플레이어 ID와 이름은 인증 계정에서 결정합니다. 클라이언트가 보낸 `playerId/name`으로 다른 사용자를 가장할 수 없습니다. `op:"profile"`은 방을 만들지 않고 `welcome`으로 프로필을 받은 뒤 연결을 끝냅니다. 프로필 조회에는 `config`가 필요 없습니다.

서버 이벤트:

| `type` | 내용 |
| --- | --- |
| `welcome` | `profile`, `room:{roomId,code,maxPlayers}`, `role`, `slot`. 프로필 조회의 `room`은 `null` |
| `waiting` | 방 정보, 현재 `players`, `hostId`, `members` 이름/슬롯/팀, `manualStart`, `canStart`, `startReason` |
| `start-denied` | 시작 거절 `message`와 현재 `lobby`. 연결 유지 |
| `peer-ready` | 입장 완료. `role`, `slot`, 방 정보, 검증된 자신의 `config`, `remoteHello`, 전체 상대 목록 `peers`, `profile` |
| `game` | 기존 게임 `message`와 연결에서 결정한 `senderId`, `slot` |
| `round-ended` | 팀전 라운드 종료, 승리 팀, 팀 라운드 승수 및 다음 시작 시각 |
| `round-start` | 다음 라운드 번호와 서버가 지정한 각 참가자의 새 생명 번호 |
| `peer-left` | 이탈 참가자 ID. 남은 인원으로 대전이 가능하면 계속 |
| `profile` | 변경된 중앙 `profile` |
| `death-confirmed` | 검증 및 중복 처리 결과인 `receipt` |
| `drop` | 서버 드롭 ID와 정확한 `weapon`, `magazine`, `reserve`, 위치를 담은 `drop` |
| `pickup-grant` | 승인된 `grant`; 같은 요청 재전송은 `replay:true`로 같은 grant ID 반환 |
| `pickup-denied` | `requestId`, `reason` |
| `drop-removed` | `dropId`, 사유. 원본 지면 아이템 한도 40개 초과 시 오래된 드롭 제거 |
| `proof-rejected` | 관측된 발사·명중 ID와 맞지 않는 피해 증명. XP에 사용하지 않음 |
| `room-ended` | 연결 종료 또는 서버 종료로 대전 종료 |
| `match-ended` | 확정된 `result:{id,reason,players,winnerIds,scores,draw,startedAt,endedAt}`. 대전 종료 후 원본 게임도 종료 |
| `error` | `code`, `message` 후 해당 연결 종료 |

v0.3.1 클라이언트는 `manualStart:true`로 방을 만듭니다. 방장은 `{"type":"start-match","roomId":"현재 방 ID"}`를 보내 시작합니다. 두 명 이상이어야 하며 팀전은 짝수 인원만 가능합니다. 최대 인원이 차도 자동 시작하지 않습니다. 시작 전 방장 이탈 시 남은 첫 참가자에게 권한을 넘기고 팀을 다시 배정합니다. 시작 승인 시 실제 참가자에게 `peer-ready`를 보냅니다. 구버전의 `manualStart` 없는 방은 정원이 찼을 때 자동 시작합니다. 별도 ready ACK는 필요 없습니다. 일반 게임 송신은 `{"type":"game","message":{...}}`입니다. 선택적인 `targetId`가 있으면 같은 방의 해당 상대에게만 전달합니다. 기존 2인 게임은 생략해도 됩니다. `ping`에는 `pong`으로 응답합니다.

구버전 `clientMaxPlayers:2` 클라이언트는 8인 방 입장이 거절됩니다. 최신 클라이언트는 `clientMaxPlayers:8`을 사용하며, 각 명중 메시지의 `targetId`로 피해자를 지정합니다. 게임 상태는 같은 방의 전체 상대에게 전달합니다.

## 경험치와 장비

원본 캐릭터 능력치 1500~1650에 로컬 계급 보너스 0/100/200/300/400을 더합니다. 계급 XP 기준은 0/1000/3000/6000/10000입니다. 기존 누적 XP와 획득 보상은 유지하고 계급·캐릭터·쌍포 해금 조건만 10배로 높였습니다. 장비 비용은 제공된 게임의 정보 이미지에서 읽은 값이며, MP38은 555점입니다. 출전 슬롯·역할·중화기 조합 규칙은 `loadouts.json`에 원본 자료와 구분해 기록한 이번 수정본의 규칙입니다. 캐릭터의 `inventoryBonus`는 표시용 차이값이며 한도에 다시 더하지 않습니다.

서버는 초기 장비와 초기 선택 무기, 점수 한도를 검증하고 저장합니다. 출전 장비는 7슬롯입니다. 경기 중 새 무기는 점수 한도 안에서 소지목록에 추가될 수 있습니다. 이미 가진 같은 무기는 획득을 거절하며 G로 버린 뒤 E로 주워야 합니다. 자동 획득과 자동 교체는 없습니다. 0발도 그대로 유지합니다. 경기 중 습득한 무기는 다음 부활의 출전 장비를 변경하지 않습니다.

XP는 피해를 받은 클라이언트의 원본 HP 감소 증명과 서버가 앞서 전달한 같은 발사·명중 ID가 일치하고, 해당 감소가 치명상이었을 때만 발생합니다. 킬은 25 XP, 그 죽음의 피해자는 5 XP입니다. 자살·환경 사망·피해 증명 없는 사망은 0 XP입니다. 자동 경기 완료 보상은 없습니다.

피해자가 먼저 보냅니다:

```json
{"type":"damage-proof","proof":{"id":"victim:1:17","shotId":12,"victimLife":1,"attackerId":"other-player-id","attackerLife":1,"weapon":9,"before":30,"after":-5}}
```

서버는 `victimId`를 송신 연결에서 결정합니다. `proof.id`는 피해자·생명·피해 이벤트 번호로 구성한 고유 피해 ID입니다. `proof.shotId`는 총알의 기존 `hit.id` 또는 폭발물의 원래 `shot.id`이며 공격자 ID·발사 생명과 함께 원본 발사 증명을 찾습니다. 두 공격자가 각각 발사1을 사용하거나 한 투사체가 여러 번 피해를 줘도 충돌하지 않습니다. 숫자/문자열 발사 ID는 동일 문자열로 정규화합니다. `shotId`가 없는 이전 테스트 메시지는 `id`를 발사 ID로 사용하는 호환 경로가 있습니다. 정확한 원본 발사 ID를 모르면 피해·사망 화면은 처리하되 검증 XP는 지급하지 않습니다.

이어 기존 `death` 게임 메시지에 아래 필드를 추가합니다. `weapon`은 피해를 준 무기이고 `drop.selectedWeapon`은 죽은 사람이 들고 있던 무기이므로 서로 다를 수 있습니다.

```json
{"type":"game","message":{"type":"death","version":1,"life":1,"seq":20,"killer":"remote","weapon":9,"damageId":"victim:1:17","hpAfter":-5,"drop":{"selectedWeapon":6,"magazine":0,"reserve":7,"pos":[100,0,100],"sector":4}}}
```

사망 생명 키를 한 번만 확정하고 프로필에 반영합니다. 재전송으로 XP가 중복되지 않습니다. 서버는 게임의 충돌·사격 물리를 재현하지 않습니다. 원본 엔진의 명중 보고와 피해자 원본 HP 결과를 대조하는 현재 LAN 검증 방식입니다.

## 수동 버리기·줍기 연결

클라이언트가 원본 거리·시야 판정을 통과한 후보에 E를 눌렀을 때만 보냅니다:

```json
{"type":"pickup-claim","dropId":"drop-...","requestId":"pickup-17","life":2}
```

서버는 마지막으로 받은 플레이어 위치·생명·체력, 현재 소지목록과 계급 예산으로 검사합니다. 최초 한 명만 승인합니다. grant에는 `id,matchId,dropId,requestId,playerId,life,weapon,magazine,reserve,replaceSlot,replacedWeapon`이 있습니다. `replaceSlot`은 **논리 소지목록의 인덱스**이며 원본 키목록의 물리 주소가 아닙니다.

승인을 받기 전 원본 기본탄약 지급을 보류하고, 승인 후 게임 스레드에서 원본 습득 함수를 호출한 다음 정확한 장탄·예비탄을 덮어씁니다. 적용한 grant ID는 재접속을 포함해 대전이 끝날 때까지 기억해야 합니다. `death-confirmed`는 XP 처리용이고, 원본 K/D는 기존 `game/death` 경로를 사용해 두 번 계산하지 않습니다.

## 테스트

`npm test`는 게임이나 UI를 띄우지 않습니다. 임시 DB와 localhost의 임시 포트만 사용합니다. 메일 코드 검사는 테스트 전송 어댑터를 사용하며 실제 메일을 보내지 않습니다.

- 2~8인 입장, 설정 교환, 메시지 전달, 토큰 인증
- 슬롯 7 대상 공격, 이탈 후 경기 지속, 개인전 10초 부활 제한
- 4:4 아군 피해 차단, 라운드 중 부활 차단, 전멸/다음 라운드/네 명의 팀 승리
- 원본 점수와 출전 제한, 피해·사망 검증, XP 25/5와 중복 방지
- 한 명만 드롭 습득, 잔탄 0/7 보존, 재전송 처리
- 프로필 조회, 서버 재시작 후 XP 유지, 상태 HTTP에 개인정보 제외
- 인증 off 가입·로그인, 인증 required 코드·만료·입력 제한, 비밀번호 해시와 세션 폐기
- 관리자 권한·계정 중지·감사 기록, 순위 개인정보 제외, 경기 종료 및 승패 중복 방지
- 20개 방 × 8개 모의 클라이언트 = 160개 연결
- 상태 메시지 1600개를 같은 방의 상대들에게 총 11200회 전달하고 방 간 혼입 검사

이 서버 검사만으로 장시간 부하나 실제 160명 플레이를 보장하지 않습니다. 원본 게임 8개 및 두 PC 연결 검증 범위는 [클라이언트 검증 기록](https://github.com/mrgrit/karma/blob/main/VALIDATION.md)을 참고하세요.

## v3.2.0 방 목록과 개인전 중간 참가

승인된 계정의 `GET /api/rooms`는 방 코드·방장·맵·방식·현재/최대 인원·진행 상태·참가 가능 여부를 반환합니다. 참가 요청은 코드와 `roomId`를 함께 보내므로 같은 코드를 다시 쓴 다른 방에 잘못 들어가지 않습니다. 일반 계정에 미검증 전장은 노출하지 않습니다.

`karma290-central5` 개인전은 빈자리 중간 참가를 허용하고 한 명만 남아도 제한시간/킬 목표까지 유지합니다. 팀전·1:1·구버전의 진행 중 방은 중간 참가를 막습니다. 서버는 결제 중인 자리도 정원에 포함하고, 계정별 경기당 한 번만 결제하며 실패·취소·인증 만료 시 반환합니다. 재접속은 새 생명번호와 기존 점수를 사용합니다. 새 참가자에게 현재 위치·캐릭터·점수·남은 바닥 무기를 동기화하고 과거 발사 이벤트는 재생하지 않습니다.

G는 `drop-claim`에 `requestId,life,weapon,magazine,reserve`를 보냅니다. 서버는 마지막 상태의 선택 무기·소유·탄약을 대조한 뒤 `drop-grant`에 새 소지목록과 선택 무기, 정확한 탄약의 바닥 무기를 돌려줍니다. 승인 전에 소유를 제거하지 않습니다. 마지막 총기를 버리면 칼을 선택하며 칼·관측장비는 버리지 못합니다. E는 예산·병과 조합·거리·생명·소유 중복을 검사합니다. 실패 사유와 근처 무기의 점수·탄약은 게임 오른쪽 안내에 표시합니다.
