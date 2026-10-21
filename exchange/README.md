# 학과 코인 거래소

200번 서버의 학과 LAN 서비스입니다. 100번 `exchange.kt66.lab` 허니팟은 그대로 유지합니다. 카르마 계정의 승인·사용 중지 상태를 확인하며, **Besu QBFT 블록체인의 ERC-20 계약**에서 지갑·발행량·코인 이동을 확정합니다. SQLite는 주문장·계정 정보·검색 인덱스 및 재시작 복구 기록을 보관합니다. [블록체인 구성·이관·복구](CHAIN.md)를 참고하세요.

## 운영 주소

- 거래소: `https://exchange.ycdc.internal` → `192.168.12.200`
- 소스·Compose: `/home/ccc/pjt/karma_exchange`
- 컨테이너: `karma_exchange-exchange-1`, 내부 8080. 호스트에 직접 공개하지 않습니다.
- KT88 엔드포인트 ID 4, 내부 공개, upstream `http://karma-exchange:8080`.
- 학과 DNS 또는 각 PC의 hosts에 `192.168.12.200 exchange.ycdc.internal`이 필요합니다. KT88 내부 CA를 검증하며 브라우저의 인증서 경고 처리는 관리자가 별도로 확인합니다.

## 정책과 사용

- KARMA는 100 정수 단위가 1코인입니다. 최초 지갑 생성 시 일반 계정 3코인, 관리자 1,000,000코인을 한 번만 지급합니다. 기존 카르마 계정도 같습니다.
- 일반 사용자: 지갑·내역, 다른 지갑에 양도, 계정당 사설 코인 최대 5개 고정 발행, 사설 코인/KARMA 지정가 주문·취소.
- 관리자: **활동 보상**에서 학생들과 1인당 지급량·사유를 선택합니다. 원장 검사로 발행량과 지갑/예약/게임 수입의 합계를 확인합니다. 지급 대상은 지갑을 한 번 생성한 계정입니다.
- 매칭은 유리한 가격, 동일 가격이면 접수 순서입니다. 상대 주문 가격으로 체결하고 차액을 반환합니다. 미체결 금액은 예약되어 양도나 게임에 쓸 수 없습니다. 자기 주문과 교차하는 주문은 거절합니다.
- 중앙 서버 대전 시작마다 참가자당 1코인. 입장/로컬 연습은 무료. 시작 실패·시작 중 참가자 변경은 반환하며 시작 후 자진 퇴장은 반환하지 않습니다. 팀전 다음 라운드는 추가 차감하지 않습니다.
- 이용료는 **학과 공동 금고**로 이체됩니다. 관리자 개인 지갑과 별도이며 소각하지 않습니다. 시작 실패 시 금고 또는 예약 지갑에서 반환합니다. 활동 보상은 기존 정책대로 추가 발행하며, 공동 금고에서 자동 지급하지 않습니다.
- KARMA와 사설 코인은 각각 실제 ERC-20 계약이며, 학과 서버가 지갑과 정산 서명을 관리합니다. 이더리움 공개망·외부 개인 지갑·현금 입출금과 연결되지 않습니다. 사설 코인으로 이용료를 바로 낼 수 없으며 체결로 KARMA를 확보해야 합니다.

## 배포

Python 3.12와 버전을 고정한 Web3.py 의존성을 사용합니다. `compose.yaml`은 KT88의 `real-ycdc_apps`, `real-ycdc_outbound` 및 별도 내부 `karma-chain` 네트워크에 연결합니다. `data/`, `secrets/` 소유권은 컨테이너 UID 10001, 디렉터리 700, 비밀 파일 600입니다. `secrets/service-key`는 게임 서버만 공유하는 48바이트 이상의 랜덤 키, `secrets/game-ca.pem`은 100번 계정 서버의 공개 CA입니다. 블록체인 식별 정보는 `chain.json`, 정산 서명키는 `chain-operator.key`입니다. 키와 데이터는 Git에 넣지 않습니다.

게임 서버 환경 변수:

```ini
KARMA_EXCHANGE_URL=https://exchange.ycdc.internal
KARMA_EXCHANGE_ADDRESS=192.168.12.200
KARMA_EXCHANGE_CA=/home/ccc/pjt/karma_server/secrets/exchange-ca.pem
KARMA_EXCHANGE_KEY_FILE=/home/ccc/pjt/karma_server/secrets/exchange-key
```

주소 재정의는 접속 IP만 지정하며 TLS 호스트 검증을 유지합니다. 이용료 처리 중인 경기 ID는 게임 서버 `data/exchange-pending.json`에 기록됩니다. 시작 확정 전 중단된 결제는 재시작 때 반환을 재시도합니다. 거래소가 응답하지 않으면 대전 시작을 거절하고 대기실을 유지합니다.

## 검사와 백업

```sh
cd exchange
python3 -m unittest test_ledger test_http test_admin_funding
cd ..
node exchange-client.test.mjs
```

테스트는 임시 DB와 테스트 전용 TLS 인증서를 사용합니다. `test-fixtures/localhost.key`는 테스트 전용이며 Docker 이미지와 운영 인증에 포함하지 않습니다. 실제 사용자에게 테스트 주문/보상을 넣지 않습니다.

원장이 실행 중일 때는 SQLite `Connection.backup()`을 사용해 일관된 백업을 만드세요. `exchange.sqlite` 파일만 복사하면 WAL에 남은 거래를 놓칠 수 있습니다. 키 파일과 게임 계정 데이터도 별도로 보호해 백업합니다. 복구 시 거래소를 중지한 뒤 백업 파일로 교체하고 원장 검사를 실행합니다.

운영 규모는 학과 LAN 기준입니다. 실제 160명이 동시에 거래/게임하는 장시간 부하 검증은 아직 수행하지 않았습니다.

`migrate_admin_million.py`는 블록체인 전환 전 사용한 기존 원장 이관 도구입니다. **블록체인 전환 후 직접 실행하지 마세요.** 이후 보상·발행·이체는 거래소의 블록체인 경로로 처리합니다. 기존 관리자 증액·일반 계정 최초 지급 내역은 이관 때 보존되며 다시 지급하지 않습니다.
