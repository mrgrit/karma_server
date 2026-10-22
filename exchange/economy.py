"""Funded community work and escrow. All money moves use Ledger.transaction."""
import json
import uuid
from datetime import datetime, timezone
from common import COIN, WELCOME_GRANT, MAX_AMOUNT, require, integer, user_id, clean_text

DAY = 86400000


def content(value, limit=2000):
    require(isinstance(value, str) and 1 <= len(value.strip()) <= limit and
            not any(ord(c) < 32 and c not in '\n\r\t' for c in value), '설명 또는 제출 내용을 확인하세요.')
    return value.strip()


class CommunityEconomy:
    def audit_community(self, db):
        for mission in db.execute('SELECT * FROM missions'):
            if mission['state'] == 'open':
                expected = (mission['slots']-db.execute("SELECT COUNT(*) FROM mission_claims WHERE mission=? AND state='approved'", (mission['id'],)).fetchone()[0])*mission['reward']
            else:
                expected = db.execute("SELECT COUNT(*) FROM mission_claims WHERE mission=? AND state IN ('claimed','submitted')", (mission['id'],)).fetchone()[0]*mission['reward']
            require(self.balance(db, '@mission:'+mission['id']) == expected, '미션 보상금 보존 검사 실패', 'LEDGER_INVARIANT', 500)
        for job in db.execute('SELECT * FROM service_jobs'):
            expected = 0 if job['state'] in ('paid','refunded') else job['price']
            require(self.balance(db, '@service:'+job['id']) == expected, '서비스 보관금 검사 실패', 'LEDGER_INVARIANT', 500)
        liability = sum(len(json.loads(r['players']))*r['fee'] for r in db.execute("SELECT players,fee FROM games WHERE state='committed'"))
        require(self.balance(db, '@treasury') >= liability, '게임 환불 준비금 검사 실패', 'LEDGER_INVARIANT', 500)

    def initialize_economy(self, db):
        db.executescript('''
          CREATE TABLE IF NOT EXISTS welcome_grants(uid TEXT PRIMARY KEY,state TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS economy_events(id INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,amount INTEGER NOT NULL,actor TEXT NOT NULL,beneficiary TEXT NOT NULL,reference TEXT NOT NULL,tx TEXT NOT NULL,at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS economy_time ON economy_events(at,kind);
          CREATE TABLE IF NOT EXISTS missions(id TEXT PRIMARY KEY,creator TEXT NOT NULL,title TEXT NOT NULL,description TEXT NOT NULL,reward INTEGER NOT NULL,slots INTEGER NOT NULL,deadline INTEGER NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS mission_claims(id TEXT PRIMARY KEY,mission TEXT NOT NULL REFERENCES missions(id),student TEXT NOT NULL REFERENCES users(id),state TEXT NOT NULL,evidence TEXT NOT NULL,review TEXT NOT NULL,updated INTEGER NOT NULL,UNIQUE(mission,student));
          CREATE TABLE IF NOT EXISTS services(id TEXT PRIMARY KEY,seller TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,description TEXT NOT NULL,price INTEGER NOT NULL,days INTEGER NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS service_jobs(id TEXT PRIMARY KEY,service TEXT NOT NULL REFERENCES services(id),buyer TEXT NOT NULL REFERENCES users(id),seller TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,description TEXT NOT NULL,price INTEGER NOT NULL,days INTEGER NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL,deadline INTEGER NOT NULL,delivery TEXT NOT NULL,dispute TEXT NOT NULL,resolution TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS jobs_buyer ON service_jobs(buyer,state);
          CREATE INDEX IF NOT EXISTS jobs_seller ON service_jobs(seller,state);
          CREATE TABLE IF NOT EXISTS community_history(id INTEGER PRIMARY KEY AUTOINCREMENT,entity TEXT NOT NULL,reference TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,note TEXT NOT NULL,at INTEGER NOT NULL);
        ''')
        # Existing accounts already received their original one-time grant.
        db.execute("INSERT OR IGNORE INTO welcome_grants SELECT id,'paid' FROM users")

    def admin(self, db, actor):
        row = db.execute('SELECT role FROM users WHERE id=?', (actor,)).fetchone()
        require(row and row['role'] == 'admin', '관리자 권한이 필요합니다.', 'ADMIN_REQUIRED', 403)

    def event(self, db, kind, amount, actor, beneficiary, reference, tx):
        db.execute('INSERT INTO economy_events(kind,amount,actor,beneficiary,reference,tx,at) VALUES(?,?,?,?,?,?,?)',
                   (kind, amount, actor, beneficiary, reference, tx, self.now()))

    def history_event(self, db, entity, reference, actor, action, note=''):
        db.execute('INSERT INTO community_history(entity,reference,actor,action,note,at) VALUES(?,?,?,?,?,?)',
                   (entity, reference, actor, action, note, self.now()))

    def treasury_available(self, db):
        # A committed start may still fail. Hold the entire refund liability
        # until the game server durably confirms admission.
        liability = sum(len(json.loads(r['players']))*r['fee'] for r in
                        db.execute("SELECT players,fee FROM games WHERE state='committed'"))
        return max(0, self.balance(db, '@treasury') - liability)

    def treasury_spend(self, db, tx, target, amount, reason, actor):
        require(self.treasury_available(db) >= amount,
                '공동 금고의 지급 가능 잔액이 부족합니다. 관리자가 운영 예산을 넣어 주세요.', 'TREASURY_INSUFFICIENT', 409)
        self.move(db, tx, COIN, '@treasury', target, amount, reason, actor)

    def treasury_fund(self, actor, key, payload):
        def apply(db, tx):
            self.admin(db, actor)
            amount = integer(payload.get('amount'))
            reason = clean_text(payload.get('reason'), 120)
            self.move(db, tx, COIN, actor, '@treasury', amount, '운영 예산 입금 · '+reason, actor)
            self.event(db, 'funding', amount, actor, '@treasury', '', tx)
            return {'ok': True, 'transactionId': tx}
        return self.perform(actor, key, 'treasury-fund', payload, apply)

    def pay_welcome(self, db, uid):
        row = db.execute('SELECT state FROM welcome_grants WHERE uid=?', (uid,)).fetchone()
        if row and row['state'] == 'pending' and self.treasury_available(db) >= WELCOME_GRANT:
            tx = str(uuid.uuid4())
            self.treasury_spend(db, tx, uid, WELCOME_GRANT, '체험 코인 최초 지급', '@department')
            db.execute("UPDATE welcome_grants SET state='paid' WHERE uid=?", (uid,))
            self.event(db, 'welcome', WELCOME_GRANT, '@department', uid, uid, tx)

    def welcome_claim(self, actor, key, payload):
        def apply(db, tx):
            row = db.execute('SELECT state FROM welcome_grants WHERE uid=?', (actor,)).fetchone()
            require(row, '지갑을 먼저 만들어 주세요.')
            if row['state'] == 'pending':
                require(self.treasury_available(db) >= WELCOME_GRANT, '체험 코인 예산을 준비 중입니다. 나중에 다시 받아 주세요.', 'TREASURY_INSUFFICIENT', 409)
                self.pay_welcome(db, actor)
            return {'ok': True}
        return self.perform(actor, key, 'welcome-claim', payload, apply)

    def mission_action(self, actor, key, payload):
        def apply(db, tx):
            action = payload.get('action')
            if action == 'create':
                self.admin(db, actor)
                title, description = clean_text(payload.get('title'), 80), content(payload.get('description'))
                reward, slots = integer(payload.get('reward'), 1, 10**8), integer(payload.get('slots'), 1, 160)
                deadline = integer(payload.get('deadline'), self.now()+60000, self.now()+366*DAY)
                require(db.execute("SELECT COUNT(*) FROM missions WHERE state='open'").fetchone()[0] < 50, '먼저 종료된 미션을 마감해 주세요.')
                mid = str(uuid.uuid4())
                self.treasury_spend(db, tx, '@mission:'+mid, reward*slots, '미션 보상금 확보 · '+title, actor)
                db.execute('INSERT INTO missions VALUES(?,?,?,?,?,?,?,?,?)', (mid, actor, title, description, reward, slots, deadline, 'open', self.now()))
                self.history_event(db, 'mission', mid, actor, action)
                return {'ok': True, 'missionId': mid}
            mid = user_id(payload.get('missionId'))
            mission = db.execute('SELECT * FROM missions WHERE id=?', (mid,)).fetchone()
            require(mission, '미션을 찾을 수 없습니다.', 'NOT_FOUND', 404)
            escrow, reward = '@mission:'+mid, mission['reward']
            if action == 'close':
                self.admin(db, actor)
                if mission['state'] == 'open':
                    keep = db.execute("SELECT COUNT(*) FROM mission_claims WHERE mission=? AND state IN ('claimed','submitted')", (mid,)).fetchone()[0]*reward
                    release = self.balance(db, escrow)-keep
                    if release: self.move(db, tx, COIN, escrow, '@treasury', release, '미션 미배정 예산 반환', actor)
                    db.execute("UPDATE missions SET state='closed' WHERE id=?", (mid,))
                    self.history_event(db, 'mission', mid, actor, action)
                return {'ok': True}
            if action == 'claim':
                require(actor != mission['creator'], '자신이 만든 미션에는 참여할 수 없습니다.')
                require(mission['state'] == 'open' and mission['deadline'] > self.now(), '참여 모집이 끝난 미션입니다.', 'STATE_CONFLICT', 409)
                prior = db.execute('SELECT * FROM mission_claims WHERE mission=? AND student=?', (mid, actor)).fetchone()
                require(not prior or prior['state'] == 'cancelled', '이미 참여한 미션입니다.', 'STATE_CONFLICT', 409)
                occupied = db.execute("SELECT COUNT(*) FROM mission_claims WHERE mission=? AND state IN ('claimed','submitted','approved')", (mid,)).fetchone()[0]
                require(occupied < mission['slots'], '미션 참여 인원이 찼습니다.', 'MISSION_FULL', 409)
                require(db.execute("SELECT COUNT(*) FROM mission_claims WHERE student=? AND state IN ('claimed','submitted')", (actor,)).fetchone()[0] < 20, '진행 중인 미션은 최대 20개입니다.')
                cid = prior['id'] if prior else str(uuid.uuid4())
                db.execute("INSERT INTO mission_claims VALUES(?,?,?,'claimed','','',?) ON CONFLICT(mission,student) DO UPDATE SET state='claimed',evidence='',review='',updated=excluded.updated", (cid, mid, actor, self.now()))
                self.history_event(db, 'claim', cid, actor, action)
                return {'ok': True, 'claimId': cid}
            cid = user_id(payload.get('claimId'))
            claim = db.execute('SELECT * FROM mission_claims WHERE id=? AND mission=?', (cid, mid)).fetchone()
            require(claim, '참여 내역을 찾을 수 없습니다.', 'NOT_FOUND', 404)
            if action in ('submit', 'cancel'):
                require(claim['student'] == actor, '내 참여 내역만 변경할 수 있습니다.', 'FORBIDDEN', 403)
                require(claim['state'] == 'claimed', '이미 제출하거나 처리한 참여 내역입니다.', 'STATE_CONFLICT', 409)
                if action == 'submit':
                    require(self.now() <= mission['deadline'], '제출 기한이 지났습니다.')
                    db.execute("UPDATE mission_claims SET state='submitted',evidence=?,updated=? WHERE id=?", (content(payload.get('evidence')), self.now(), cid))
                else:
                    db.execute("UPDATE mission_claims SET state='cancelled',updated=? WHERE id=?", (self.now(), cid))
                    if mission['state'] == 'closed': self.move(db, tx, COIN, escrow, '@treasury', reward, '미션 참여 취소 예산 반환', actor)
            elif action in ('approve', 'reject'):
                self.admin(db, actor)
                require(claim['student'] != actor, '본인의 참여 내역은 다른 관리자가 검토해야 합니다.')
                require(claim['state'] == 'submitted' or action == 'reject' and claim['state'] == 'claimed', '검토 가능한 참여 내역이 아닙니다.', 'STATE_CONFLICT', 409)
                note = content(payload.get('review'), 500)
                if action == 'approve':
                    self.move(db, tx, COIN, escrow, claim['student'], reward, '미션 완료 · '+mission['title'], actor)
                    self.event(db, 'missionReward', reward, actor, claim['student'], cid, tx)
                elif mission['state'] == 'closed': self.move(db, tx, COIN, escrow, '@treasury', reward, '미션 검토 종료 예산 반환', actor)
                db.execute('UPDATE mission_claims SET state=?,review=?,updated=? WHERE id=?', ('approved' if action=='approve' else 'rejected', note, self.now(), cid))
            else: require(False, '미션 작업을 확인하세요.')
            self.history_event(db, 'claim', cid, actor, action, payload.get('evidence') or payload.get('review') or '')
            return {'ok': True}
        return self.perform(actor, key, 'mission', payload, apply)

    def service_action(self, actor, key, payload):
        def apply(db, tx):
            action = payload.get('action')
            if action == 'create':
                require(db.execute("SELECT COUNT(*) FROM services WHERE seller=? AND state='open'", (actor,)).fetchone()[0] < 20, '판매 중인 서비스는 최대 20개입니다.')
                sid = str(uuid.uuid4())
                db.execute('INSERT INTO services VALUES(?,?,?,?,?,?,?,?)', (sid, actor, clean_text(payload.get('title'), 80), content(payload.get('description')), integer(payload.get('price'), 1, 10**8), integer(payload.get('days'), 1, 30), 'open', self.now()))
                self.history_event(db, 'service', sid, actor, action)
                return {'ok': True, 'serviceId': sid}
            sid = user_id(payload.get('serviceId'))
            service = db.execute('SELECT * FROM services WHERE id=?', (sid,)).fetchone()
            require(service, '서비스를 찾을 수 없습니다.', 'NOT_FOUND', 404)
            if action == 'close':
                if actor != service['seller']: self.admin(db, actor)
                db.execute("UPDATE services SET state='closed' WHERE id=?", (sid,))
                self.history_event(db, 'service', sid, actor, action)
                return {'ok': True}
            require(action == 'buy' and service['state'] == 'open', '현재 구매 가능한 서비스가 아닙니다.', 'STATE_CONFLICT', 409)
            require(service['seller'] != actor, '내 서비스를 구매할 수 없습니다.')
            require(db.execute("SELECT COUNT(*) FROM service_jobs WHERE (buyer=? OR seller=?) AND state NOT IN ('paid','refunded')", (actor, actor)).fetchone()[0] < 20, '진행 중인 주문을 먼저 마무리해 주세요.')
            require(db.execute("SELECT COUNT(*) FROM service_jobs WHERE seller=? AND state NOT IN ('paid','refunded')", (service['seller'],)).fetchone()[0] < 20, '판매자가 진행할 수 있는 주문이 찼습니다.')
            jid = str(uuid.uuid4()); request = content(payload.get('request'), 1000)
            self.move(db, tx, COIN, actor, '@service:'+jid, service['price'], '서비스 대금 보관 · '+service['title'], actor)
            db.execute('INSERT INTO service_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', (jid, sid, actor, service['seller'], service['title'], service['description'], service['price'], service['days'], request, 'requested', 0, '', '', '', self.now(), self.now()))
            self.history_event(db, 'job', jid, actor, 'buy', request)
            return {'ok': True, 'jobId': jid}
        return self.perform(actor, key, 'service', payload, apply)

    def job_action(self, actor, key, payload):
        def apply(db, tx):
            jid = user_id(payload.get('jobId')); action = payload.get('action')
            job = db.execute('SELECT * FROM service_jobs WHERE id=?', (jid,)).fetchone()
            require(job, '주문을 찾을 수 없습니다.', 'NOT_FOUND', 404)
            buyer, seller, status = actor == job['buyer'], actor == job['seller'], job['state']
            require(status not in ('paid', 'refunded'), '이미 정산된 주문입니다.', 'STATE_CONFLICT', 409)
            target, note = None, ''
            if action == 'accept':
                require(seller, '판매자만 수락할 수 있습니다.', 'FORBIDDEN', 403)
                require(status == 'requested', '수락 대기 주문이 아닙니다.', 'STATE_CONFLICT', 409)
                db.execute("UPDATE service_jobs SET state='accepted',deadline=?,updated=? WHERE id=?", (self.now()+job['days']*DAY, self.now(), jid))
            elif action == 'deliver':
                require(seller, '판매자만 결과를 제출할 수 있습니다.', 'FORBIDDEN', 403)
                require(status == 'accepted', '진행 중인 주문이 아닙니다.', 'STATE_CONFLICT', 409)
                note = content(payload.get('note'))
                db.execute("UPDATE service_jobs SET state='delivered',delivery=?,updated=? WHERE id=?", (note, self.now(), jid))
            elif action == 'complete':
                require(buyer, '구매자만 완료를 확인할 수 있습니다.', 'FORBIDDEN', 403)
                require(status == 'delivered', '결과 제출 후 완료 확인할 수 있습니다.', 'STATE_CONFLICT', 409)
                target = job['seller']
            elif action == 'cancel':
                require(buyer or seller, '주문 당사자만 취소할 수 있습니다.', 'FORBIDDEN', 403)
                require(status == 'requested' or seller or status == 'accepted' and self.now() > job['deadline'], '수락된 주문은 판매자의 환불 또는 관리자 중재가 필요합니다.', 'STATE_CONFLICT', 409)
                note = content(payload.get('note'), 500); target = job['buyer']
            elif action == 'dispute':
                require(buyer or seller, '주문 당사자만 중재를 요청할 수 있습니다.', 'FORBIDDEN', 403)
                require(status in ('accepted', 'delivered'), '진행 중인 주문만 중재를 요청할 수 있습니다.', 'STATE_CONFLICT', 409)
                note = content(payload.get('note'), 500)
                db.execute("UPDATE service_jobs SET state='disputed',dispute=?,updated=? WHERE id=?", (note, self.now(), jid))
            elif action == 'resolve':
                self.admin(db, actor)
                require(not buyer and not seller, '본인의 거래는 다른 관리자가 중재해야 합니다.')
                require(status == 'disputed', '중재 요청된 주문이 아닙니다.', 'STATE_CONFLICT', 409)
                require(payload.get('decision') in ('pay', 'refund'), '정산 방식을 선택하세요.')
                note = content(payload.get('note'), 500)
                target = job['seller'] if payload['decision'] == 'pay' else job['buyer']
            else: require(False, '주문 작업을 확인하세요.')
            if target:
                paid = target == job['seller']
                self.move(db, tx, COIN, '@service:'+jid, target, job['price'], ('서비스 완료 · ' if paid else '서비스 환불 · ')+job['title'], actor)
                db.execute('UPDATE service_jobs SET state=?,resolution=?,updated=? WHERE id=?', ('paid' if paid else 'refunded', note, self.now(), jid))
                self.event(db, 'servicePaid' if paid else 'serviceRefund', job['price'], job['buyer'], job['seller'], jid, tx)
            self.history_event(db, 'job', jid, actor, action, note)
            return {'ok': True}
        return self.perform(actor, key, 'job', payload, apply)

    def community(self, uid):
        with self.connect() as db:
            db.execute('BEGIN')
            admin = db.execute('SELECT role FROM users WHERE id=?', (uid,)).fetchone()['role'] == 'admin'
            missions = [dict(r) for r in db.execute("SELECT m.*,u.name creatorName,(SELECT COUNT(*) FROM mission_claims c WHERE c.mission=m.id AND c.state IN ('claimed','submitted','approved')) occupied FROM missions m JOIN users u ON u.id=m.creator ORDER BY m.state='open' DESC,m.created DESC LIMIT 200")]
            claims = [dict(r) for r in db.execute("SELECT c.*,u.name studentName,m.title,m.reward,m.deadline FROM mission_claims c JOIN users u ON u.id=c.student JOIN missions m ON m.id=c.mission WHERE (? OR c.student=?) AND (c.state IN ('claimed','submitted') OR c.updated>?) ORDER BY c.updated DESC", (admin, uid, self.now()-30*DAY))]
            services = [dict(r) for r in db.execute("SELECT s.*,u.name sellerName FROM services s JOIN users u ON u.id=s.seller WHERE s.state='open' OR s.seller=? ORDER BY s.created DESC LIMIT 500", (uid,))]
            jobs = [dict(r) for r in db.execute("SELECT j.*,b.name buyerName,s.name sellerName FROM service_jobs j JOIN users b ON b.id=j.buyer JOIN users s ON s.id=j.seller WHERE (? OR j.buyer=? OR j.seller=?) AND (j.state NOT IN ('paid','refunded') OR j.updated>?) ORDER BY j.updated DESC", (admin, uid, uid, self.now()-30*DAY))]
            for job in jobs:
                job['history'] = [dict(r) for r in db.execute("SELECT actor,action,note,at FROM community_history WHERE entity='job' AND reference=? ORDER BY id", (job['id'],))]
            return {'missions': missions, 'claims': claims, 'services': services, 'jobs': jobs, 'now': self.now()}

    def economy(self):
        with self.connect() as db:
            db.execute('BEGIN')
            total = db.execute('SELECT supply FROM assets WHERE symbol=?', (COIN,)).fetchone()[0]
            treasury = self.balance(db, '@treasury'); available = self.treasury_available(db)
            rows = [dict(r) for r in db.execute('SELECT b.owner,b.amount,u.role FROM balances b LEFT JOIN users u ON u.id=b.owner WHERE b.asset=?', (COIN,))]
            parts = {'studentWallets': 0, 'adminWallets': 0, 'missionEscrow': 0, 'serviceEscrow': 0, 'orderEscrow': 0, 'gameEscrow': 0, 'other': 0}
            for row in rows:
                owner, amount = row['owner'], row['amount']
                if owner in ('@treasury', '@reserve'): continue
                category = 'adminWallets' if row['role']=='admin' else 'studentWallets' if row['role']=='user' else next((key for prefix,key in [('@mission:','missionEscrow'),('@service:','serviceEscrow'),('@order:','orderEscrow'),('@game:','gameEscrow')] if owner.startswith(prefix)), 'other')
                parts[category] += amount
            # Daily boundaries are Korea Standard Time, independent of host TZ.
            start = ((self.now()+9*3600000)//DAY)*DAY-9*3600000-6*DAY
            days = []; participants = set()
            for day in range(7):
                lo, hi = start+day*DAY, start+(day+1)*DAY
                metrics = dict(gameIncome=0, gameRefunds=0, reissued=0, servicePaid=0, transfers=0, funding=0)
                for event in db.execute('SELECT * FROM economy_events WHERE at>=? AND at<?', (lo, hi)):
                    key = 'reissued' if event['kind'] in ('reward','missionReward','welcome') else event['kind']
                    if key in metrics: metrics[key] += event['amount']
                    if key in ('servicePaid', 'reissued'): participants.add(event['beneficiary'])
                    if key == 'servicePaid': participants.add(event['actor'])
                for j in db.execute('SELECT j.*,s.role sourceRole,d.role destRole FROM journal j LEFT JOIN users s ON s.id=j.source LEFT JOIN users d ON d.id=j.destination WHERE j.asset=? AND j.at>=? AND j.at<?', (COIN, lo, hi)):
                    if j['source'].startswith('@game:') and j['destination']=='@treasury': metrics['gameIncome'] += j['amount']
                    if j['source']=='@treasury' and j['reason']=='시작 실패 이용료 반환': metrics['gameRefunds'] += j['amount']
                    if j['sourceRole']=='user' and j['destRole']=='user': metrics['transfers'] += j['amount']; participants.update((j['source'], j['destination']))
                days.append({'date': datetime.fromtimestamp((lo+9*3600000)/1000, timezone.utc).strftime('%m/%d'), **metrics})
            return {'totalSupply': total, 'treasury': treasury, 'spendable': available, 'refundHeld': treasury-available,
                    'reserve': self.balance(db, '@reserve'), **parts, 'days': days,
                    'totals': {k: sum(d[k] for d in days) for k in days[0] if k != 'date'},
                    'participants': len(participants), 'pendingWelcome': db.execute("SELECT COUNT(*) FROM welcome_grants WHERE state='pending'").fetchone()[0],
                    'pendingClaims': db.execute("SELECT COUNT(*) FROM mission_claims WHERE state='submitted'").fetchone()[0],
                    'disputedJobs': db.execute("SELECT COUNT(*) FROM service_jobs WHERE state='disputed'").fetchone()[0],
                    'policy': {'rewardPercent': 80, 'reservePercent': 20, 'gameFee': 100}, 'now': self.now()}
