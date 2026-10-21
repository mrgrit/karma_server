"""Department exchange: integer balances, SQLite atomic settlement and audit journal."""
import contextlib
import hashlib
import json
import re
import sqlite3
import time
import uuid
from pathlib import Path

COIN = 'KARMA'
FEE = 100  # 100 minor units = one department coin.
MAX_AMOUNT = 10**12


class Connection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


class Problem(Exception):
    def __init__(self, message, code='BAD_REQUEST', status=400):
        super().__init__(message)
        self.code, self.status = code, status


def require(condition, message, code='BAD_REQUEST', status=400):
    if not condition:
        raise Problem(message, code, status)


def integer(value, low=1, high=MAX_AMOUNT):
    require(type(value) is int and low <= value <= high, '수량과 가격 범위를 확인하세요.')
    return value


def user_id(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-f0-9-]{36}', value), '사용자 ID가 올바르지 않습니다.')
    try:
        valid = str(uuid.UUID(value)) == value
    except ValueError:
        valid = False
    require(valid, '사용자 ID가 올바르지 않습니다.')
    return value


def clean_text(value, length):
    require(isinstance(value, str) and 1 <= len(value.strip()) <= length and not any(ord(c) < 32 for c in value), '이름 또는 지급 사유를 확인하세요.')
    return value.strip()


class Ledger:
    def __init__(self, filename):
        self.filename = str(filename)
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, created INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS assets(symbol TEXT PRIMARY KEY, name TEXT NOT NULL, issuer TEXT NOT NULL, supply INTEGER NOT NULL CHECK(supply>=0), decimals INTEGER NOT NULL, created INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS balances(owner TEXT NOT NULL, asset TEXT NOT NULL REFERENCES assets(symbol), amount INTEGER NOT NULL CHECK(amount>=0 AND amount<=1000000000000), PRIMARY KEY(owner,asset));
                CREATE TABLE IF NOT EXISTS journal(id INTEGER PRIMARY KEY AUTOINCREMENT, tx TEXT NOT NULL, asset TEXT NOT NULL, source TEXT NOT NULL, destination TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), reason TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS journal_source ON journal(source,id);
                CREATE INDEX IF NOT EXISTS journal_destination ON journal(destination,id);
                CREATE TABLE IF NOT EXISTS requests(actor TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(actor,key));
                CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, owner TEXT NOT NULL, asset TEXT NOT NULL, side TEXT NOT NULL, price INTEGER NOT NULL, quantity INTEGER NOT NULL, remaining INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS book ON orders(asset,status,side,price,created);
                CREATE TABLE IF NOT EXISTS trades(id INTEGER PRIMARY KEY AUTOINCREMENT, asset TEXT NOT NULL, price INTEGER NOT NULL, quantity INTEGER NOT NULL, buyer TEXT NOT NULL, seller TEXT NOT NULL, buy_order TEXT NOT NULL, sell_order TEXT NOT NULL, at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS games(id TEXT PRIMARY KEY, players TEXT NOT NULL, state TEXT NOT NULL, fee INTEGER NOT NULL, updated INTEGER NOT NULL);
            ''')
            db.execute('INSERT OR IGNORE INTO assets VALUES(?,?,?,?,?,?)', (COIN, '학과 코인', '@department', 0, 2, self.now()))

    @staticmethod
    def now():
        return time.time_ns() // 1000000

    def connect(self):
        db = sqlite3.connect(self.filename, timeout=15, factory=Connection)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('PRAGMA synchronous=FULL')
        return db

    @contextlib.contextmanager
    def transaction(self):
        db = self.connect()
        try:
            db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def perform(self, actor, key, action, payload, operation):
        require(isinstance(key, str) and re.fullmatch(r'[A-Za-z0-9:_-]{8,128}', key), '요청 식별자가 필요합니다.')
        fingerprint = hashlib.sha256(json.dumps([action, payload], sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        with self.transaction() as db:
            previous = db.execute('SELECT * FROM requests WHERE actor=? AND key=?', (actor, key)).fetchone()
            if previous:
                require(previous['fingerprint'] == fingerprint, '같은 요청 번호에 다른 내용을 보낼 수 없습니다.', 'IDEMPOTENCY_CONFLICT', 409)
                return json.loads(previous['response'])
            tx = str(uuid.uuid4())
            result = operation(db, tx)
            db.execute('INSERT INTO requests VALUES(?,?,?,?)', (actor, key, fingerprint, json.dumps(result)))
            return result

    @staticmethod
    def balance(db, owner, asset=COIN):
        row = db.execute('SELECT amount FROM balances WHERE owner=? AND asset=?', (owner, asset)).fetchone()
        return row['amount'] if row else 0

    def move(self, db, tx, asset, source, destination, amount, reason, actor):
        integer(amount)
        require(source != destination, '같은 지갑으로 보낼 수 없습니다.')
        if source == '@mint':
            db.execute('UPDATE assets SET supply=supply+? WHERE symbol=?', (amount, asset))
        else:
            require(self.balance(db, source, asset) >= amount, '사용 가능한 코인이 부족합니다.', 'INSUFFICIENT_FUNDS', 409)
            db.execute('UPDATE balances SET amount=amount-? WHERE owner=? AND asset=?', (amount, source, asset))
        require(self.balance(db, destination, asset)+amount <= MAX_AMOUNT, '지갑 보유 한도를 초과합니다.')
        db.execute('INSERT INTO balances VALUES(?,?,?) ON CONFLICT(owner,asset) DO UPDATE SET amount=amount+excluded.amount', (destination, asset, amount))
        db.execute('INSERT INTO journal(tx,asset,source,destination,amount,reason,actor,at) VALUES(?,?,?,?,?,?,?,?)', (tx, asset, source, destination, amount, reason, actor, self.now()))

    def ensure_in(self, db, profile):
        uid = user_id(profile['playerId'])
        name = clean_text(profile['name'], 32)
        role = 'admin' if profile.get('role') == 'admin' else 'user'
        exists = db.execute('SELECT 1 FROM users WHERE id=?', (uid,)).fetchone()
        db.execute('INSERT INTO users VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role', (uid, name, role, self.now()))
        if not exists:
            grant = 10000000 if role == 'admin' else 300
            self.move(db, str(uuid.uuid4()), COIN, '@mint', uid, grant, '관리자 최초 지급' if role == 'admin' else '체험 코인 최초 지급', '@department')
        return uid

    def ensure(self, profile):
        with self.transaction() as db:
            uid = self.ensure_in(db, profile)
        return self.wallet(uid)

    def wallet(self, uid):
        with self.connect() as db:
            balances = [dict(r) for r in db.execute('SELECT a.*,COALESCE(b.amount,0) available FROM assets a LEFT JOIN balances b ON b.asset=a.symbol AND b.owner=? WHERE a.symbol=? OR b.amount>0 OR a.issuer=? ORDER BY a.created', (uid, COIN, uid))]
            locked = {}
            for order in db.execute("SELECT * FROM orders WHERE owner=? AND status='open'", (uid,)):
                asset = COIN if order['side'] == 'buy' else order['asset']
                locked[asset] = locked.get(asset, 0)+order['remaining']*(order['price'] if order['side'] == 'buy' else 1)
            history = [dict(r) for r in db.execute('SELECT * FROM journal WHERE source=? OR destination=? ORDER BY id DESC LIMIT 100', (uid, uid))]
            return {'playerId': uid, 'balances': balances, 'locked': locked, 'history': history, 'gameFee': FEE, 'coin': COIN}

    def market(self, uid=None):
        with self.connect() as db:
            assets = [dict(r) for r in db.execute('SELECT a.*,u.name issuerName FROM assets a LEFT JOIN users u ON u.id=a.issuer ORDER BY a.created')]
            orders = [dict(r) for r in db.execute("SELECT id,owner,asset,side,price,remaining,created FROM orders WHERE status='open' ORDER BY created,id LIMIT 2000")]
            trades = [dict(r) for r in db.execute('SELECT id,asset,price,quantity,at FROM trades ORDER BY id DESC LIMIT 200')]
            own = [dict(r) for r in db.execute('SELECT * FROM orders WHERE owner=? ORDER BY created DESC LIMIT 100', (uid,))] if uid else []
            return {'assets': assets, 'orders': orders, 'trades': trades, 'myOrders': own}

    def users(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute('SELECT id,name FROM users ORDER BY name LIMIT 2000')]

    def transfer(self, actor, key, payload):
        def apply(db, tx):
            target = user_id(payload.get('to'))
            require(db.execute('SELECT 1 FROM users WHERE id=?', (target,)).fetchone(), '받는 사용자가 거래소에 먼저 로그인해야 합니다.')
            asset = payload.get('asset')
            require(db.execute('SELECT 1 FROM assets WHERE symbol=?', (asset,)).fetchone(), '코인을 확인하세요.')
            self.move(db, tx, asset, actor, target, integer(payload.get('amount')), clean_text(payload.get('memo') or '개인 양도', 120), actor)
            return {'ok': True, 'transactionId': tx}
        return self.perform(actor, key, 'transfer', payload, apply)

    def issue(self, actor, key, payload):
        def apply(db, tx):
            symbol = payload.get('symbol', '')
            require(isinstance(symbol, str) and re.fullmatch(r'[A-Z][A-Z0-9]{1,9}', symbol) and symbol not in [COIN, 'KRW', 'USD', 'BTC', 'ETH', 'USDT'], '영문 대문자·숫자 2~10자의 새 코인 기호를 입력하세요.')
            require(not db.execute('SELECT 1 FROM assets WHERE symbol=?', (symbol,)).fetchone(), '이미 사용 중인 코인 기호입니다.', 'SYMBOL_EXISTS', 409)
            require(db.execute('SELECT COUNT(*) FROM assets WHERE issuer=?', (actor,)).fetchone()[0] < 5, '계정당 사설 코인은 최대 5개입니다.')
            name, supply = clean_text(payload.get('name'), 40), integer(payload.get('supply'), 1, 10**9)
            db.execute('INSERT INTO assets VALUES(?,?,?,?,?,?)', (symbol, name, actor, 0, 0, self.now()))
            self.move(db, tx, symbol, '@mint', actor, supply, '사설 코인 고정 발행', actor)
            return {'ok': True, 'symbol': symbol, 'transactionId': tx}
        return self.perform(actor, key, 'issue', payload, apply)

    def reward(self, actor, key, payload):
        def apply(db, tx):
            row = db.execute('SELECT role FROM users WHERE id=?', (actor,)).fetchone()
            require(row and row['role'] == 'admin', '관리자 권한이 필요합니다.', 'ADMIN_REQUIRED', 403)
            recipients = payload.get('recipients')
            require(isinstance(recipients, list) and 1 <= len(recipients) <= 160 and len(set(recipients)) == len(recipients), '중복 없는 지급 대상 1~160명을 선택하세요.')
            amount, reason = integer(payload.get('amount'), 1, 10**8), clean_text(payload.get('reason'), 120)
            for target in recipients:
                user_id(target)
                require(db.execute('SELECT 1 FROM users WHERE id=?', (target,)).fetchone(), '지급 대상의 지갑이 없습니다.')
                self.move(db, tx, COIN, '@mint', target, amount, reason, actor)
            return {'ok': True, 'transactionId': tx, 'recipients': len(recipients)}
        return self.perform(actor, key, 'reward', payload, apply)

    def order(self, actor, key, payload):
        def apply(db, tx):
            asset, side = payload.get('asset'), payload.get('side')
            require(asset != COIN and db.execute('SELECT 1 FROM assets WHERE symbol=?', (asset,)).fetchone(), '거래할 사설 코인을 선택하세요.')
            require(side in ['buy', 'sell'], '매수 또는 매도를 선택하세요.')
            price, qty = integer(payload.get('price'), 1, 10**8), integer(payload.get('quantity'), 1, 10**9)
            require(price*qty <= MAX_AMOUNT, '주문 금액 한도를 초과합니다.')
            require(db.execute("SELECT COUNT(*) FROM orders WHERE owner=? AND status='open'", (actor,)).fetchone()[0] < 50, '미체결 주문은 최대 50개입니다.')
            opposite, comparison, sort = ('sell', '<=', 'ASC') if side == 'buy' else ('buy', '>=', 'DESC')
            book = db.execute(f"SELECT * FROM orders WHERE asset=? AND side=? AND status='open' AND price {comparison} ? ORDER BY price {sort},rowid", (asset, opposite, price)).fetchall()
            require(not any(r['owner'] == actor for r in book), '본인의 반대 주문과 체결되는 주문은 등록할 수 없습니다.', 'SELF_TRADE', 409)
            oid, remaining = str(uuid.uuid4()), qty
            reserve_asset, reserve_amount = (COIN, price*qty) if side == 'buy' else (asset, qty)
            self.move(db, tx, reserve_asset, actor, '@order:'+oid, reserve_amount, '주문 예약', actor)
            db.execute('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?)', (oid, actor, asset, side, price, qty, qty, 'open', self.now()))
            for maker in book:
                if not remaining:
                    break
                fill = min(remaining, maker['remaining'])
                buy = {'id': oid, 'owner': actor, 'price': price} if side == 'buy' else maker
                sell = maker if side == 'buy' else {'id': oid, 'owner': actor, 'price': price}
                cost = fill*maker['price']
                self.move(db, tx, asset, '@order:'+sell['id'], buy['owner'], fill, '거래 체결', actor)
                self.move(db, tx, COIN, '@order:'+buy['id'], sell['owner'], cost, '거래 체결', actor)
                improvement = fill*buy['price']-cost
                if improvement:
                    self.move(db, tx, COIN, '@order:'+buy['id'], buy['owner'], improvement, '체결 가격 차액 반환', actor)
                db.execute('INSERT INTO trades(asset,price,quantity,buyer,seller,buy_order,sell_order,at) VALUES(?,?,?,?,?,?,?,?)', (asset, maker['price'], fill, buy['owner'], sell['owner'], buy['id'], sell['id'], self.now()))
                left = maker['remaining']-fill
                db.execute('UPDATE orders SET remaining=?,status=? WHERE id=?', (left, 'open' if left else 'filled', maker['id']))
                remaining -= fill
            db.execute('UPDATE orders SET remaining=?,status=? WHERE id=?', (remaining, 'open' if remaining else 'filled', oid))
            return {'ok': True, 'orderId': oid, 'filled': qty-remaining, 'remaining': remaining}
        return self.perform(actor, key, 'order', payload, apply)

    def cancel(self, actor, key, payload):
        def apply(db, tx):
            order = db.execute('SELECT * FROM orders WHERE id=? AND owner=?', (payload.get('orderId'), actor)).fetchone()
            require(order, '취소할 주문을 찾을 수 없습니다.', 'NOT_FOUND', 404)
            if order['status'] == 'open':
                asset, amount = (COIN, order['price']*order['remaining']) if order['side'] == 'buy' else (order['asset'], order['remaining'])
                self.move(db, tx, asset, '@order:'+order['id'], actor, amount, '주문 취소', actor)
                db.execute("UPDATE orders SET status='cancelled' WHERE id=?", (order['id'],))
            return {'ok': True}
        return self.perform(actor, key, 'cancel', payload, apply)

    def game(self, action, payload):
        gid = user_id(payload.get('matchId'))
        with self.transaction() as db:
            game = db.execute('SELECT * FROM games WHERE id=?', (gid,)).fetchone()
            if action == 'reserve':
                if payload.get('expiresAt') is not None:
                    require(integer(payload['expiresAt'], 1, 2**53-1) > self.now(), '대전 시작 요청이 만료됐습니다.', 'RESERVATION_EXPIRED', 409)
                profiles = payload.get('players')
                require(isinstance(profiles, list) and 2 <= len(profiles) <= 8, '대전 참가자를 확인하세요.')
                ids = sorted(user_id(p['playerId']) for p in profiles)
                require(len(set(ids)) == len(ids), '동일 계정 중복 참가입니다.')
                if game:
                    require(json.loads(game['players']) == ids, '이미 처리된 대전의 참가자가 다릅니다.', 'MATCH_CONFLICT', 409)
                    require(game['state'] != 'refunded', '취소된 대전입니다.', 'MATCH_CANCELLED', 409)
                    return {'ok': True, 'state': game['state'], 'fee': FEE}
                for profile in profiles:
                    self.ensure_in(db, profile)
                missing = [p['name'] for p in profiles if self.balance(db, p['playerId']) < FEE]
                require(not missing, '코인 부족: '+', '.join(missing)+' · 1인당 1 KARMA가 필요합니다.', 'INSUFFICIENT_FUNDS', 409)
                for uid in ids:
                    self.move(db, gid, COIN, uid, '@game:'+gid, FEE, '대전 이용료 예약', '@game-server')
                db.execute('INSERT INTO games VALUES(?,?,?,?,?)', (gid, json.dumps(ids), 'reserved', FEE, self.now()))
                return {'ok': True, 'state': 'reserved', 'fee': FEE}
            require(game, '대전 결제를 찾을 수 없습니다.', 'NOT_FOUND', 404)
            if action == 'commit':
                require(game['state'] != 'refunded', '취소된 대전입니다.', 'MATCH_CANCELLED', 409)
                if game['state'] == 'reserved':
                    self.move(db, gid, COIN, '@game:'+gid, '@treasury', len(json.loads(game['players']))*FEE, '대전 이용료 확정', '@game-server')
                    db.execute("UPDATE games SET state='committed',updated=? WHERE id=?", (self.now(), gid))
                return {'ok': True, 'state': 'committed'}
            require(action == 'refund', '지원하지 않는 결제 처리입니다.')
            if game['state'] != 'refunded':
                source = '@game:'+gid if game['state'] == 'reserved' else '@treasury'
                for uid in json.loads(game['players']):
                    self.move(db, gid, COIN, source, uid, FEE, '시작 실패 이용료 반환', '@game-server')
                db.execute("UPDATE games SET state='refunded',updated=? WHERE id=?", (self.now(), gid))
            return {'ok': True, 'state': 'refunded'}

    def audit(self):
        with self.connect() as db:
            supplies = [dict(r) for r in db.execute('SELECT a.symbol,a.supply,COALESCE(SUM(b.amount),0) accounted FROM assets a LEFT JOIN balances b ON b.asset=a.symbol GROUP BY a.symbol')]
            require(all(r['supply'] == r['accounted'] for r in supplies), '원장 보존 검사 실패', 'LEDGER_INVARIANT', 500)
            return {'ok': True, 'supplies': supplies, 'treasury': self.balance(db, '@treasury'), 'journal': [dict(r) for r in db.execute('SELECT * FROM journal ORDER BY id DESC LIMIT 100')]}
