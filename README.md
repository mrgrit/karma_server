# Karma LAN 중앙 서버

같은 LAN에서 실행하는 Karma290 클라이언트의 방 관리, 메시지 전달, 계급·경험치·출전 장비 저장, 무기 습득 소유권을 담당합니다. Node.js 20 이상과 기본 모듈만 사용합니다. `npm install`은 필요하지 않습니다.

현재 원본 게임 클라이언트는 **2인 대전**을 지원합니다. 서버의 방 배분과 메시지 전달은 최대 20개 방, 방당 8명까지 모의 클라이언트로 검사합니다. 이 검사는 원본 클라이언트의 4대4 게임 동작을 의미하지 않습니다.

## 실행과 검사

```sh
cd /home/ccc/pjt/karma_server
node server.test.mjs
KARMA_HOST=192.168.12.100 node server.mjs
curl http://192.168.12.100:29021/health
```

설정은 환경변수입니다.

| 이름 | 기본값 | 용도 |
| --- | --- | --- |
| `KARMA_HOST` | `0.0.0.0` | 게임 TCP 수신 주소 |
| `KARMA_PORT` | `29020` | 게임 TCP 포트 |
| `KARMA_HEALTH_HOST` | `KARMA_HOST` | 상태 HTTP 수신 주소 |
| `KARMA_HEALTH_PORT` | `29021` | 상태 HTTP 포트 |
| `KARMA_DATA_DIR` | 서버 폴더의 `data` | 저장 데이터 디렉터리 |

`data/profiles.json`은 플레이어 ID, 이름, 토큰 해시, XP, 킬·데스, 중복 보상 방지 기록과 캐릭터별 출전 장비를 보관합니다. 변경은 임시 파일을 동기화한 후 원래 파일로 교체합니다. 잘못된 기존 DB를 발견하면 초기화하지 않고 실행을 중단합니다. 토큰 원문은 DB나 로그에 저장하지 않습니다.

단일 Node 프로세스가 이 파일을 소유합니다. 복수 서버 프로세스에서 같은 DB 파일을 공유하지 않습니다. 서버를 정지한 뒤 `data` 디렉터리를 복사해 백업할 수 있습니다. 방과 진행 중인 드롭은 메모리에 있으며 서버 재시작이나 한 플레이어의 연결 종료 시 대전이 끝납니다. 저장된 XP와 장비 선택은 유지됩니다.

`karma-server.service`는 사용자 systemd 예제입니다. 실제 Node 경로를 확인하고 `~/.config/systemd/user/karma-server.service`에 배치한 뒤 사용합니다.

```sh
systemctl --user daemon-reload
systemctl --user enable --now karma-server.service
systemctl --user status karma-server.service
journalctl --user -u karma-server.service -n 50
```

## 프로토콜 2

TCP 한 줄마다 JSON 객체 하나를 전달합니다. 한 메시지 최대 64 KiB, 연결 입력 버퍼 최대 128 KiB, 연결당 초당 최대 500개 메시지입니다. 게임의 기존 protocol 1 메시지는 `game.message` 내부에 보관합니다.

입장:

```json
{"type":"hello","version":2,"op":"create","playerId":"saved-player-id","token":"saved-token","name":"Player","clientMaxPlayers":2,"maxPlayers":2,"config":{"age":0,"map":0,"character":{"index":0,"camp":0},"inventory":[50,9,1,6,48,24,18],"selectedWeapon":9,"settings":{"build":"karma290-lan1"}}}
```

참가는 `op:"join", code:"123456"`을 사용합니다. 새 플레이어는 `playerId`와 `token`을 생략할 수 있습니다. 기존 ID에는 이전에 받은 토큰이 필요합니다. `op:"profile"`은 방을 만들지 않고 `welcome`으로 토큰과 프로필을 받은 뒤 연결을 끝냅니다. 프로필 조회에는 `config`가 필요 없습니다.

서버 이벤트:

| `type` | 내용 |
| --- | --- |
| `welcome` | `token`, `profile`, `room:{roomId,code,maxPlayers}`, `role`, `slot`. 프로필 조회의 `room`은 `null` |
| `waiting` | `roomId`, `code`, `maxPlayers`, 현재 `players` |
| `peer-ready` | 입장 완료. `role`, `slot`, 방 정보, 검증된 자신의 `config`, `remoteHello`, 전체 상대 목록 `peers`, `profile` |
| `game` | 기존 게임 `message`와 연결에서 결정한 `senderId`, `slot` |
| `profile` | 변경된 중앙 `profile` |
| `death-confirmed` | 검증 및 중복 처리 결과인 `receipt` |
| `drop` | 서버 드롭 ID와 정확한 `weapon`, `magazine`, `reserve`, 위치를 담은 `drop` |
| `pickup-grant` | 승인된 `grant`; 같은 요청 재전송은 `replay:true`로 같은 grant ID 반환 |
| `pickup-denied` | `requestId`, `reason` |
| `drop-removed` | `dropId`, 사유. 원본 지면 아이템 한도 40개 초과 시 오래된 드롭 제거 |
| `proof-rejected` | 관측된 발사·명중 ID와 맞지 않는 피해 증명. XP에 사용하지 않음 |
| `room-ended` | 연결 종료 또는 서버 종료로 대전 종료 |
| `error` | `code`, `message` 후 해당 연결 종료 |

정원이 모두 들어오면 `peer-ready`를 보냅니다. 별도 ready ACK는 필요 없습니다. 일반 게임 송신은 `{"type":"game","message":{...}}`입니다. 선택적인 `targetId`가 있으면 같은 방의 해당 상대에게만 전달합니다. 기존 2인 게임은 생략해도 됩니다. `ping`에는 `pong`으로 응답합니다.

2인 클라이언트는 `clientMaxPlayers:2`를 사용하며 8인 방 입장이 거절됩니다. 8인 프로토콜 모의 검사는 `clientMaxPlayers:8,maxPlayers:8`로 생성하고 7명을 참가시킵니다.

## 경험치와 장비

원본 캐릭터 능력치 1500~1650에 로컬 계급 보너스 0/100/200/300/400을 더합니다. 계급 XP 기준은 0/100/300/600/1000입니다. 장비 비용은 제공된 게임의 정보 이미지에서 읽은 값이며, MP38은 555점입니다. 출전 슬롯·역할·중화기 조합 규칙은 `loadouts.json`에 원본 자료와 구분해 기록한 이번 수정본의 규칙입니다. 캐릭터의 `inventoryBonus`는 표시용 차이값이며 한도에 다시 더하지 않습니다.

서버는 초기 장비와 초기 선택 무기, 점수 한도를 검증하고 저장합니다. 출전 장비는 7슬롯입니다. 경기 중 새 무기는 점수 한도 안에서 소지목록에 추가될 수 있습니다. 같은 무기를 주우면 장탄·예비탄을 합산하지 않고 떨어진 무기의 수치로 교체합니다. 0발도 그대로 유지합니다. 경기 중 습득한 무기는 다음 부활의 출전 장비를 변경하지 않습니다.

XP는 피해를 받은 클라이언트의 원본 HP 감소 증명과 서버가 앞서 전달한 같은 발사·명중 ID가 일치하고, 해당 감소가 치명상이었을 때만 발생합니다. 킬은 25 XP, 그 죽음의 피해자는 5 XP입니다. 자살·환경 사망·피해 증명 없는 사망은 0 XP입니다. 자동 경기 완료 보상은 없습니다.

피해자가 먼저 보냅니다:

```json
{"type":"damage-proof","proof":{"id":12,"victimLife":1,"attackerId":"other-player-id","attackerLife":1,"weapon":9,"before":30,"after":-5}}
```

서버는 `victimId`를 송신 연결에서 결정합니다. 숫자/문자열 발사 ID는 동일 문자열로 정규화합니다. 총알은 기존 `hit.id`, 폭발물은 그 투사체를 생성한 원래 `shot.id`를 사용합니다. 정확한 원본 발사 ID를 모르면 피해·사망 화면은 처리하되 검증 XP는 지급하지 않습니다.

이어 기존 `death` 게임 메시지에 아래 필드를 추가합니다. `weapon`은 피해를 준 무기이고 `drop.selectedWeapon`은 죽은 사람이 들고 있던 무기이므로 서로 다를 수 있습니다.

```json
{"type":"game","message":{"type":"death","version":1,"life":1,"seq":20,"killer":"remote","weapon":9,"damageId":12,"hpAfter":-5,"drop":{"selectedWeapon":6,"magazine":0,"reserve":7,"pos":[100,0,100],"sector":4}}}
```

사망 생명 키를 한 번만 확정하고 프로필에 반영합니다. 재전송으로 XP가 중복되지 않습니다. 서버는 게임의 충돌·사격 물리를 재현하지 않습니다. 원본 엔진의 명중 보고와 피해자 원본 HP 결과를 대조하는 현재 LAN 검증 방식입니다.

## 원본 근접 습득 연결

클라이언트가 원본 거리·시야 판정을 통과해 보냅니다:

```json
{"type":"pickup-claim","dropId":"drop-...","requestId":"pickup-17","life":2}
```

서버는 마지막으로 받은 플레이어 위치·생명·체력, 현재 소지목록과 계급 예산으로 검사합니다. 최초 한 명만 승인합니다. grant에는 `id,matchId,dropId,requestId,playerId,life,weapon,magazine,reserve,replaceSlot,replacedWeapon`이 있습니다. `replaceSlot`은 **논리 소지목록의 인덱스**이며 원본 키목록의 물리 주소가 아닙니다.

승인을 받기 전 원본 기본탄약 지급을 보류하고, 승인 후 게임 스레드에서 원본 습득 함수를 호출한 다음 정확한 장탄·예비탄을 덮어씁니다. 적용한 grant ID는 재접속을 포함해 대전이 끝날 때까지 기억해야 합니다. `death-confirmed`는 XP 처리용이고, 원본 K/D는 기존 `game/death` 경로를 사용해 두 번 계산하지 않습니다.

## 테스트

`server.test.mjs`는 게임이나 UI를 띄우지 않습니다. 임시 DB와 localhost의 임시 포트만 사용합니다.

- 2인 입장, 설정 교환, 메시지 전달, 토큰 인증
- 원본 점수와 출전 제한, 피해·사망 검증, XP 25/5와 중복 방지
- 한 명만 드롭 습득, 잔탄 0/7 보존, 재전송 처리
- 프로필 조회, 서버 재시작 후 XP 유지, 상태 HTTP에 개인정보 제외
- 20개 방 × 8개 모의 클라이언트 = 160개 연결
- 상태 메시지 1600개를 같은 방의 상대들에게 총 11200회 전달하고 방 간 혼입 검사

이는 방 관리·전달 기능 검사이며 장시간 부하, 실제 160명 플레이, 4대4 원본 게임 검증 결과는 아닙니다.
