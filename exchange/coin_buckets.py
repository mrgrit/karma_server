"""KARMA classes are a conserved projection of the existing on-chain balance.

All changes, including offline regeneration, run in the ledger transaction;
ChainLedger records these SQL writes in the same recoverable settlement plan.
"""
import json
import uuid
from common import COIN, require, integer, user_id, clean_text

DAY = 86400000
HALF_HOUR = 1800000
KST = 9*3600000
DAILY_REFILL_LIMIT = 1000  # 10 KARMA, separate from the rank-dependent balance cap.
BUCKETS = ('daily', 'bonus', 'base')


class CoinBuckets:
    def initialize_buckets(self, db):
        db.executescript('''
          CREATE TABLE IF NOT EXISTS coin_accounts(uid TEXT PRIMARY KEY REFERENCES users(id),
            base INTEGER NOT NULL DEFAULT 0 CHECK(base>=0), daily INTEGER NOT NULL DEFAULT 0 CHECK(daily>=0),
            bonus INTEGER NOT NULL DEFAULT 0 CHECK(bonus>=0), rank_index INTEGER NOT NULL DEFAULT 0,
            day INTEGER NOT NULL, refilled_at INTEGER NOT NULL, frozen INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS game_coin_parts(game TEXT NOT NULL,uid TEXT NOT NULL,parts TEXT NOT NULL,PRIMARY KEY(game,uid));
          CREATE TABLE IF NOT EXISTS coin_penalties(id TEXT PRIMARY KEY,uid TEXT NOT NULL,amount INTEGER NOT NULL,
            paid INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,reason TEXT NOT NULL,created INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS coin_daily_limits(uid TEXT NOT NULL REFERENCES users(id),day INTEGER NOT NULL,
            refilled INTEGER NOT NULL DEFAULT 0 CHECK(refilled>=0 AND refilled<=1000),
            reset_remaining INTEGER NOT NULL DEFAULT 0 CHECK(reset_remaining>=0),PRIMARY KEY(uid,day));
        ''')

    def coin_account(self, db, uid):
        row = db.execute('SELECT * FROM coin_accounts WHERE uid=?', (uid,)).fetchone()
        if row is None:
            # Existing balances retain their transferable status. No re-grant.
            db.execute('INSERT INTO coin_accounts(uid,bonus,day,refilled_at) VALUES(?,?,?,0)',
                       (uid, self.balance(db, uid), (self.now()+KST)//DAY))
            row = db.execute('SELECT * FROM coin_accounts WHERE uid=?', (uid,)).fetchone()
        return row

    def bucket_move(self, db, source, destination, amount, debit='bonus', credit='bonus'):
        parts = {}
        if db.execute('SELECT 1 FROM users WHERE id=?', (source,)).fetchone():
            row = self.coin_account(db, source)
            require(not row['frozen'] or debit in ('penalty', 'reset', 'daily-return'),
                    '이용 정지 중에는 코인을 사용할 수 없습니다.', 'ACCOUNT_RESTRICTED', 403)
            order = BUCKETS if debit in ('game', 'penalty', 'reset') else ('daily',) if debit == 'daily-return' else ('bonus',)
            require(sum(row[b] for b in order) >= amount,
                    '양도·장터·거래에는 보너스 코인만 사용할 수 있습니다.' if debit == 'bonus' else '사용 가능한 코인이 부족합니다.',
                    'INSUFFICIENT_BONUS' if debit == 'bonus' else 'INSUFFICIENT_FUNDS', 409)
            remaining = amount
            for bucket in order:
                used = min(row[bucket], remaining)
                if used:
                    db.execute('UPDATE coin_accounts SET '+bucket+'='+bucket+'-? WHERE uid=?', (used, source))
                    parts[bucket] = used
                    remaining -= used
            if parts.get('daily') and row['daily'] >= (10+2*row['rank_index'])*100:
                db.execute('UPDATE coin_accounts SET refilled_at=? WHERE uid=?', (self.now(), source))
        if db.execute('SELECT 1 FROM users WHERE id=?', (destination,)).fetchone():
            require(credit in BUCKETS, '잘못된 코인 구분입니다.')
            self.coin_account(db, destination)
            db.execute('UPDATE coin_accounts SET '+credit+'='+credit+'+? WHERE uid=?', (amount, destination))
        return parts

    def daily_limit(self, db, uid, day):
        row = db.execute('SELECT * FROM coin_daily_limits WHERE uid=? AND day=?', (uid, day)).fetchone()
        if row is None:
            # Upgrades must count refills already received today under the old policy.
            start = day*DAY-KST
            used = db.execute("SELECT COALESCE(SUM(amount),0) FROM journal WHERE destination=? AND asset=? AND reason='일당 30분 회복' AND at>=? AND at<?",
                              (uid, COIN, start, start+DAY)).fetchone()[0]
            db.execute('INSERT INTO coin_daily_limits(uid,day,refilled) VALUES(?,?,?)', (uid, day, min(used, DAILY_REFILL_LIMIT)))
            row = db.execute('SELECT * FROM coin_daily_limits WHERE uid=? AND day=?', (uid, day)).fetchone()
        return row

    def refresh_daily(self, db, uid):
        row = self.coin_account(db, uid)
        now = self.now()
        day = (now+KST)//DAY
        cap = (10+2*row['rank_index'])*100
        if row['frozen']:
            return
        if row['daily'] > cap:
            self.move(db, str(uuid.uuid4()), COIN, uid, '@treasury', row['daily']-cap,
                      '계급별 일당 한도 조정', '@department', debit='daily-return')
            row = self.coin_account(db, uid)
        full = day > row['day'] or row['refilled_at'] == 0
        limit = self.daily_limit(db, uid, day)
        if full:
            # Remember a fixed unpaid entitlement: spending while treasury funding is
            # partial must never cause the same midnight allowance to be granted twice.
            db.execute('UPDATE coin_daily_limits SET reset_remaining=? WHERE uid=? AND day=?',
                       (max(0, cap-row['daily']), uid, day))
            db.execute('UPDATE coin_accounts SET day=?,refilled_at=? WHERE uid=?', (day, now, uid))
            limit = self.daily_limit(db, uid, day)
        reset = full or limit['reset_remaining'] > 0
        ticks = max(0, (now-row['refilled_at'])//HALF_HOUR)
        wanted = min(max(0, cap-row['daily']), limit['reset_remaining']) if reset else min(
            max(0, cap-row['daily']), ticks*100, DAILY_REFILL_LIMIT-limit['refilled'])
        funded = min(wanted, self.treasury_available(db)//100*100)
        if funded:
            tx = str(uuid.uuid4())
            self.treasury_spend(db, tx, uid, funded, '일당 자정 충전' if reset else '일당 30분 회복', '@department', credit='daily')
            self.event(db, 'dailyGrant', funded, '@department', uid, str(day), tx)
        # Do not lose an unfunded entitlement; a later funded request retries it.
        if reset:
            db.execute('UPDATE coin_daily_limits SET reset_remaining=? WHERE uid=? AND day=?', (wanted-funded, uid, day))
            db.execute('UPDATE coin_accounts SET refilled_at=? WHERE uid=?', (now, uid))
        elif funded:
            db.execute('UPDATE coin_daily_limits SET refilled=refilled+? WHERE uid=? AND day=?', (funded, uid, day))
            anchor = now if row['daily']+funded >= cap else row['refilled_at']+funded//100*HALF_HOUR
            db.execute('UPDATE coin_accounts SET refilled_at=? WHERE uid=?', (anchor, uid))
        self.collect_penalties(db, uid)

    def update_coin_profile(self, db, profile):
        uid = profile['playerId']
        self.coin_account(db, uid)
        if 'rankIndex' in profile:
            rank = integer(profile['rankIndex'], 0, 100)
            db.execute('UPDATE coin_accounts SET rank_index=? WHERE uid=?', (rank, uid))
        if 'sanctions' in profile:
            db.execute('UPDATE coin_accounts SET frozen=? WHERE uid=?', (int(profile['sanctions'].get('active') is True), uid))
        if not self.coin_account(db, uid)['frozen']:
            self.pay_welcome(db, uid)
        self.refresh_daily(db, uid)

    def coin_summary(self, db, uid):
        row = self.coin_account(db, uid)
        debt = db.execute("SELECT COALESCE(SUM(amount-paid),0) FROM coin_penalties WHERE uid=? AND state='active'", (uid,)).fetchone()[0]
        cap = (10+2*row['rank_index'])*100
        midnight = ((self.now()+KST)//DAY+1)*DAY-KST
        limit = self.daily_limit(db, uid, (self.now()+KST)//DAY)
        remaining = DAILY_REFILL_LIMIT-limit['refilled']
        pending = limit['reset_remaining'] > 0 or row['refilled_at'] == 0 or row['day'] < (self.now()+KST)//DAY
        return {b: row[b] for b in BUCKETS} | {'dailyCap': cap, 'rankIndex': row['rank_index'],
            'dailyRefillLimit': DAILY_REFILL_LIMIT, 'dailyRefilled': limit['refilled'], 'dailyRefillRemaining': remaining,
            'total': sum(row[b] for b in BUCKETS), 'transferable': row['bonus'], 'penaltyDebt': debt,
            'dailyPending': not row['frozen'] and row['daily'] < cap and (pending or (remaining > 0 and row['refilled_at']+HALF_HOUR <= self.now())),
            'frozen': bool(row['frozen']), 'nextRefillAt': None if row['daily'] >= cap or row['frozen'] or not remaining or pending else min(row['refilled_at']+HALF_HOUR, midnight),
            'nextResetAt': midnight, 'refillSeconds': 1800, 'timezone': 'Asia/Seoul', 'spendOrder': list(BUCKETS)}

    def refund_game_coins(self, db, gid, uid, source, fee):
        self.refresh_daily(db, uid)
        saved = db.execute('SELECT parts FROM game_coin_parts WHERE game=? AND uid=?', (gid, uid)).fetchone()
        parts = json.loads(saved['parts']) if saved else {'bonus': fee}
        row = self.coin_account(db, uid)
        for bucket, amount in parts.items():
            restored = min(amount, max(0, (10+2*row['rank_index'])*100-row['daily'])) if bucket == 'daily' else amount
            if restored:
                self.move(db, gid, COIN, source, uid, restored, '시작 실패 이용료 반환 · '+bucket, '@game-server', credit=bucket)
            if amount > restored and source != '@treasury':
                self.move(db, gid, COIN, source, '@treasury', amount-restored, '일당 한도 초과 환불금 금고 반환', '@game-server')

    def collect_penalties(self, db, uid):
        for p in db.execute("SELECT * FROM coin_penalties WHERE uid=? AND state='active' AND paid<amount ORDER BY created,id", (uid,)).fetchall():
            paid = min(p['amount']-p['paid'], self.balance(db, uid))
            if paid:
                self.move(db, 'penalty:'+p['id'], COIN, uid, '@treasury', paid, '규정 위반 제재금', '@conduct', debit='penalty')
                db.execute('UPDATE coin_penalties SET paid=paid+? WHERE id=?', (paid, p['id']))

    def sanction_coins(self, actor, key, payload):
        def apply(db, tx):
            self.admin(db, actor)
            uid = user_id(payload.get('playerId'))
            require(db.execute('SELECT 1 FROM users WHERE id=?', (uid,)).fetchone(), '사용자를 찾을 수 없습니다.', 'NOT_FOUND', 404)
            self.coin_account(db, uid)
            cid = user_id(payload.get('caseId'))
            action = payload.get('action')
            if action == 'apply':
                amount = integer(payload.get('amount'), 0, 10000000)
                reason = clean_text(payload.get('reason'), 300)
                old = db.execute('SELECT * FROM coin_penalties WHERE id=?', (cid,)).fetchone()
                require(not old or (old['uid']==uid and old['amount']==amount and old['reason']==reason), '제재 번호의 내용이 다릅니다.', 'CASE_CONFLICT', 409)
                if not old:
                    db.execute("INSERT INTO coin_penalties VALUES(?,?,?,0,'active',?,?)", (cid, uid, amount, reason, self.now()))
                self.collect_penalties(db, uid)
            elif action == 'revoke':
                old = db.execute('SELECT * FROM coin_penalties WHERE id=? AND uid=?', (cid, uid)).fetchone()
                require(old, '제재 기록을 찾을 수 없습니다.', 'NOT_FOUND', 404)
                if old['state'] == 'active':
                    db.execute("UPDATE coin_penalties SET state='revoked' WHERE id=?", (cid,))
                    if old['paid']:
                        self.treasury_spend(db, tx, uid, old['paid'], '제재 취소 · 보너스 보상', actor)
            else:
                require(False, '제재 작업을 확인하세요.')
            return {'ok': True, 'caseId': cid, 'coins': self.coin_summary(db, uid)}
        return self.perform(actor, key, 'sanction-coins', payload, apply)

    def reset_coins(self, actor, key, payload):
        def apply(db, tx):
            self.admin(db, actor)
            uid = user_id(payload.get('playerId')); reason = clean_text(payload.get('reason'), 300)
            require(db.execute('SELECT 1 FROM users WHERE id=?', (uid,)).fetchone(), '사용자를 찾을 수 없습니다.', 'NOT_FOUND', 404)
            row = self.coin_account(db, uid)
            require(not row['frozen'] and not self.coin_summary(db, uid)['penaltyDebt'], '제재 중인 계정은 리셋할 수 없습니다.', 'ACCOUNT_RESTRICTED', 409)
            require(not db.execute("SELECT 1 FROM orders WHERE owner=? AND status='open'", (uid,)).fetchone(), '미체결 주문을 먼저 취소하세요.', 'FUNDS_LOCKED', 409)
            require(not db.execute("SELECT 1 FROM service_jobs WHERE (buyer=? OR seller=?) AND state NOT IN ('paid','refunded')", (uid,uid)).fetchone(), '진행 중인 장터 거래를 먼저 정리하세요.', 'FUNDS_LOCKED', 409)
            require(not any(uid in json.loads(g['players']) for g in db.execute("SELECT players FROM games WHERE state IN ('reserved','committed')")), '진행 중인 이용료 정산이 있습니다.', 'FUNDS_LOCKED', 409)
            amount = self.balance(db, uid)
            if amount:
                self.move(db, tx, COIN, uid, '@treasury', amount, '관리자 코인 리셋 · '+reason, actor, debit='reset')
            self.treasury_spend(db, tx, uid, 10000, '리셋 기본 코인 지급', actor, credit='base')
            db.execute("UPDATE welcome_grants SET state='paid' WHERE uid=?", (uid,))
            db.execute('UPDATE coin_accounts SET refilled_at=0 WHERE uid=?', (uid,))
            self.refresh_daily(db, uid)
            self.event(db, 'coinReset', 10000, actor, uid, reason, tx)
            return {'ok': True, 'coins': self.coin_summary(db, uid)}
        return self.perform(actor, key, 'reset-coins', payload, apply)

    def audit_buckets(self, db):
        for row in db.execute('SELECT * FROM coin_accounts'):
            require(sum(row[b] for b in BUCKETS)==self.balance(db, row['uid']), '코인 구분 합계가 원장과 다릅니다.', 'BUCKET_DIVERGENCE', 503)
