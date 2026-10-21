# KARMA Department Chain

KARMA와 학생 사설 코인의 실제 발행량·주소별 잔액은 EVM 스마트 계약에 저장합니다. 모든 발행, 양도, 주문 예약·취소·체결, 게임 이용료 예약·확정·환불은 서명된 트랜잭션으로 확정됩니다. 중앙 DB의 해시만 블록체인에 적는 방식이 아닙니다.

## 네트워크와 신뢰 범위

- Besu **26.10.0**, Docker 이미지 digest 고정, **QBFT 검증 노드 4개**.
- Chain ID **2902026**, 블록 간격 1초, 가스 가격 0.
- 서버 경로 `/home/ccc/pjt/karma_chain`. Docker 내부망 `karma-chain`만 사용하며 RPC와 P2P 포트를 LAN/인터넷에 공개하지 않습니다.
- 현재 네 노드는 모두 **192.168.12.200 한 대**에서 운영합니다. 노드 한 프로세스 장애에는 합의를 계속할 수 있지만, 물리 서버·디스크 장애에 대한 분산 구성은 아닙니다.
- 100번의 HollaEx 허니팟에는 연결하거나 데이터를 복사하지 않습니다. 100번 카르마 서버는 기존 인증된 서비스 API를 통해서만 게임 이용료를 요청합니다.
- 공개 이더리움망·현금 입출금·개인 외부 지갑은 연결하지 않습니다. 학생은 기존 승인된 카르마 계정으로 로그인합니다.

개인 주소는 사용자 UUID를 바탕으로 만든 **수탁 계정 식별 주소**입니다. 사용자별 외부 서명키를 발급한 지갑이 아닙니다. 서버가 정산 권한을 가지며 기존 계정 인증·역할·보상·주문 정책을 검사합니다. 계약은 operator 서명, 잔액 부족, 발행 상한, 순서·중복 정산을 다시 검사합니다. 일반 ERC-20 지갑에서 직접 transfer/transferFrom하여 거래소 인덱스를 우회하는 경로는 제한합니다.

`KarmaSettlement` 소유자는 별도 오프라인 `owner.key`로 operator를 교체하거나 일시 중단할 수 있습니다. 운영 앱에는 `operator.key`만 마운트합니다. owner 키는 앱·Git·백업 로그에 포함하지 않습니다. 서버 관리자와 정산 서비스는 신뢰 주체이며, 이 구성을 탈중앙 공개망으로 설명하지 않습니다.

## 계약

`chain/contracts/KarmaSettlement.sol`은 OpenZeppelin Contracts 5.4.0의 ERC20, Ownable2Step을 사용합니다. Solidity 0.8.30, London EVM 대상으로 컴파일합니다.

- KARMA: decimals 2. 정수 100 = 1 KARMA. 학과의 승인된 지급은 추가 발행할 수 있습니다.
- 사설 코인: decimals 0. 발행 시 별도 ERC-20 계약을 만들며 최초 발행량을 계약의 불변 상한으로 고정합니다.
- 예약 금액은 주문 또는 경기 전용 주소에 보관합니다. 체결의 양쪽 코인·차액 반환은 같은 트랜잭션에서 원자적으로 이동합니다.
- 각 batch는 유일한 ID·순서·내용 digest를 갖습니다. 동일 서명 거래 재전송은 다시 차감하지 않습니다.
- 코인 계약의 ERC-20 `Transfer` 이벤트와 정산 계약의 `Settled` 이벤트가 블록에 남습니다. 이메일·비밀번호·실명 메모는 체인에 넣지 않습니다.

거래소의 **블록체인 · 공동 금고** 화면은 실제 블록 번호, 검증자 수, 내 주소, KARMA 계약, 공동 금고 주소·잔액 및 거래 영수증을 보여 줍니다.

## 게임 1코인의 흐름

1. 대기실·장비 설정·사격 연습은 무료입니다.
2. 방 시작 요건 충족 후 참가자마다 100 정수 단위를 경기 예약 주소로 이체합니다.
3. 시작 확정 시 예약 주소에서 **학과 공동 금고** 주소로 이동합니다.
4. 시작 실패·시작 중 취소는 예약 주소 또는 공동 금고에서 원래 참가자에게 반환합니다.

공동 금고는 관리자 개인 잔액과 별도입니다. 소각하지 않으며 자동 배분도 없습니다. 학과 활동 보상은 현재 별도 추가 발행 정책입니다. 게임 이용료 1 KARMA와 블록체인 가스 수수료 0은 서로 다른 항목입니다.

## 중단·재시작 복구

`chain_ledger.py`는 SQLite 트랜잭션에서 계산한 변경을 임시로 검증하고, 정확한 SQL 변경 계획 및 **이미 서명한 원본 거래**를 `exchange.sqlite.chain-pending.json`에 fsync하여 기록합니다. 그 다음 블록체인 거래를 보내고 성공 영수증을 확인한 뒤 SQLite 인덱스를 반영합니다.

- RPC 응답 유실·정산 시간 초과: 같은 원본 서명 거래의 해시를 조회/재전송합니다.
- 체인 확정 뒤 앱 중단: 재시작하면 저장된 SQL 계획을 한 번만 반영합니다.
- DB 반영 뒤 intent 삭제 전 중단: `chain_commits` 중복 방지 표식으로 재반영하지 않습니다.
- 검증 노드 합의 실패·오래된 블록·체인 ID/초기 블록/계약 코드 불일치: 코인 처리를 거절합니다. 로컬 잔액으로 자동 대체하지 않습니다.
- 잔액 조회는 체인의 동일 블록에서 주소별 토큰 잔액을 읽고 SQLite 인덱스와 비교합니다. 차이가 나면 오류로 처리합니다.

단일 운영 DB와 체인 operator를 공유하는 다른 프로그램에서 SQL 잔액을 직접 수정하거나 임의 거래를 보내지 마세요. 계정 이름 같은 메타데이터는 SQLite에만 저장합니다.

## 새 네트워크·배포·기존 잔액 이관

아래는 운영자용 절차입니다. 이미 존재하는 네트워크 경로에 bootstrap을 다시 실행하면 중단됩니다. 기존 블록체인 데이터를 초기화하지 않습니다.

```sh
sudo python3 chain/bootstrap.py /home/ccc/pjt/karma_chain
cd /home/ccc/pjt/karma_chain
sudo docker compose up -d
```

200번 KT88는 방화벽→IPS→edge를 통과하는 라우팅을 위해 기존 Docker 서비스 설정 `kt88-network.conf`에 `net.bridge.bridge-nf-call-iptables=0`을 사용합니다. Docker의 새 내부망 생성으로 이 값이 1로 바뀌면 웹 경로가 Docker 격리 규칙에 차단될 수 있습니다. 새 망 생성 뒤에는 해당 호스트의 기존 설치 정책과 값을 확인해 복원하고, 정상 HTTPS 200·WAF 403·IPS 테스트 표식 차단을 모두 검증하세요. 다른 호스트에 이 설정을 무조건 적용하지 않습니다.

계약 빌드: `cd chain && npm ci --ignore-scripts && npm run build`. Python 런타임은 `requirements.txt`의 고정 버전을 사용합니다. `deploy_chain.py deploy --directory <보호된 키 폴더> --rpc http://validator1:8545`가 owner/operator 키를 서버에서 생성하고 계약을 배포합니다. 재실행 시 기존 배포 거래를 재사용하며 키를 출력하지 않습니다.

운영 전환 순서:

1. 게임 시작·거래를 잠시 중지하여 기존 원장 쓰기를 멈춥니다. SQLite의 일관된 backup과 서비스 파일·이미지 백업을 보관합니다.
2. 별도 계약과 가상 사용자로 통합 검사를 수행합니다. 운영 잔액으로 테스트 주문을 만들지 않습니다.
3. `deploy_chain.py migrate --directory <키 폴더> --database <기존 DB>`를 실행합니다. 기존 전체 잔액, 공동 금고, 주문/경기 예약 주소를 그대로 체인에 발행합니다. 기존 지급·거래 기록은 보존하고 스냅샷 이관 거래와 연결합니다.
4. `deploy_chain.py audit ...`로 각 지갑·발행량·정산 순서가 일치하는지 확인합니다.
5. `chain.json`과 operator 키만 exchange의 보호된 secrets 폴더에 설치합니다. `compose.yaml`의 CHAIN 설정과 내부 네트워크로 새 앱을 실행합니다.
6. 기존 계정의 최초 지급은 재실행하지 않습니다. 관리자 100만 지급 후 실제 사용한 금액이 있으면 현재 잔액 그대로 이관합니다.

이미 체인에 확정된 운영 거래가 있다면 옛 SQLite 앱으로 되돌리지 마세요. 최신 체인과 pending 계획을 기준으로 인덱스를 복구해야 합니다.

## 검증 및 백업

```sh
python -m unittest test_ledger test_http test_admin_funding
CHAIN_TEST_RPC=http://validator1:8545 python -m unittest test_chain_integration
```

통합 검사는 별도 계약에서 체결·취소·발행 상한·이용료·환불·중복·동시 잔액 초과·RPC 중단·체인 확정 후 프로세스 중단·DB 변조·기존 잔액 이관을 확인합니다. `test_chain_quorum.py`는 **운영 이관 전에만** 검증 노드 중단·복구를 시험하는 도구입니다.

백업 대상은 각 validator의 data 디렉터리, genesis/static peers, 검증자 키, owner/operator 키, exchange SQLite+pending 계획+chain 설정입니다. 체인 노드 데이터를 복사할 때 해당 노드를 중지하고 다른 세 노드는 유지합니다. 최초 별도 오프라인 전체 백업은 쓰기를 정지한 상태에서 수행하세요. 복원한 체인 높이와 DB 정산 높이가 다르면 서비스를 열지 않습니다.

학과 규모의 기능 검증을 수행하며, 실제 160명 동시 접속·장시간 거래 부하나 외부 기관의 스마트 계약 감사가 완료됐다는 의미는 아닙니다.

2026-10-21 운영 이관은 블록 753의 `0xcb69fc906812c4d68cf23962317dc9dea178c6eefee8896c7a9ee756d517d5c9`에서 확정됐습니다. 당시 KARMA 총발행량 1,000,004, 공동 금고 6, 관리자 잔액 999,998을 그대로 보존했고 체인/인덱스 대조가 통과했습니다. 이후 잔액은 활동과 게임에 따라 변경됩니다. 실제 QBFT 시험에서 검증자 1개 중단 시 블록 진행, 2개 중단 시 미차감 대기, 복구 후 정확히 한 번 정산을 확인했습니다. 합의 복구는 라운드 시간 초과 때문에 즉시 완료되지 않을 수 있습니다.

공식 참고: [Besu QBFT](https://docs.besu-eth.org/private-networks/tutorials/qbft), [무료 가스 설정](https://docs.besu-eth.org/private-networks/how-to/configure/free-gas), [OpenZeppelin ERC-20](https://docs.openzeppelin.com/contracts/5.x/erc20).
