"""Blockchain-backed ledger with durable, replayable SQL materialization.

The EVM atomically checks and commits balances first. SQLite holds the order
book, profiles and an indexed projection. A persisted signed transaction and
exact SQL plan recover either side of a crash without reminting/recharging.
"""
import contextlib
import hashlib
import json
import os
import sqlite3
import threading
import uuid
from pathlib import Path
from ledger import Ledger, Connection, Problem, require
from chain_backend import canonical, owner_address


class RecordingConnection(Connection):
    writes = None
    def execute(self, sql, parameters=()):
        result=super().execute(sql,parameters)
        if self.writes is not None and sql.lstrip().split()[0].upper() in ('INSERT','UPDATE','DELETE','REPLACE'):
            self.writes.append([sql,list(parameters)])
        return result


def durable_json(path,value):
    temp=path.with_suffix('.tmp')
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
    with os.fdopen(fd,'w',encoding='utf-8') as out:
        out.write(canonical(value)); out.flush(); os.fsync(out.fileno())
    os.replace(temp,path)
    if os.name!='nt':
        fd=os.open(path.parent,os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)


class ChainLedger(Ledger):
    def __init__(self, filename, backend):
        self.backend=backend
        self._lock=threading.RLock()
        self.pending=Path(str(filename)+'.chain-pending.json')
        self.lockfile=Path(str(filename)+'.chain.lock')
        super().__init__(filename)
        with self.connect() as db:
            db.execute('CREATE TABLE IF NOT EXISTS chain_commits(batch TEXT PRIMARY KEY,tx_hash TEXT NOT NULL,block_number INTEGER NOT NULL,block_hash TEXT NOT NULL,sequence INTEGER NOT NULL UNIQUE,first_journal INTEGER NOT NULL,last_journal INTEGER NOT NULL,created INTEGER NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS chain_migrations(snapshot TEXT PRIMARY KEY,tx_hash TEXT NOT NULL UNIQUE)')
        with self.serialized():
            self.recover()

    def connect(self):
        db=sqlite3.connect(self.filename,timeout=20,factory=RecordingConnection)
        db.row_factory=sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON'); db.execute('PRAGMA synchronous=FULL')
        return db

    @contextlib.contextmanager
    def serialized(self):
        with self._lock:
            with open(self.lockfile,'a+b') as lock:
                if os.name=='nt':
                    import msvcrt
                    if lock.tell()==0: lock.write(b'0'); lock.flush()
                    lock.seek(0); msvcrt.locking(lock.fileno(),msvcrt.LK_LOCK,1)
                else:
                    import fcntl
                    fcntl.flock(lock,fcntl.LOCK_EX)
                try: yield
                finally:
                    if os.name=='nt': lock.seek(0); msvcrt.locking(lock.fileno(),msvcrt.LK_UNLCK,1)
                    else: fcntl.flock(lock,fcntl.LOCK_UN)

    @staticmethod
    def marker(db):
        return {'journal':db.execute('SELECT COALESCE(MAX(id),0) FROM journal').fetchone()[0],
            'sequence':db.execute('SELECT COALESCE(MAX(sequence),0) FROM chain_commits').fetchone()[0]}

    def apply_plan(self, plan, receipt):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if not db.execute('SELECT 1 FROM chain_commits WHERE batch=?',(plan['signed']['batch'],)).fetchone():
                require(self.marker(db)==plan['before'],'정산 복구 전 원장이 변경됐습니다. 관리자 확인이 필요합니다.','CHAIN_DIVERGENCE',503)
                for sql,params in plan['writes']: db.execute(sql,params)
                db.execute('INSERT INTO chain_commits VALUES(?,?,?,?,?,?,?,?)',(plan['signed']['batch'],receipt['transactionHash'],receipt['blockNumber'],receipt['blockHash'],receipt['sequence'],plan['first'],plan['last'],self.now()))
        # The durable commit is the recovery marker even if unlink is interrupted.
        self.pending.unlink(missing_ok=True)

    def recover(self):
        if not self.pending.exists(): return
        plan=json.loads(self.pending.read_text(encoding='utf-8'))
        try:
            receipt=self.backend.resolve(plan['signed'])
        except Problem as error:
            if error.code=='CHAIN_REVERTED':
                self.pending.replace(self.pending.with_name(self.pending.name+'.rejected-'+plan['signed']['batch']))
            raise
        self.apply_plan(plan,receipt)

    @contextlib.contextmanager
    def transaction(self):
        with self.serialized():
            self.recover()
            db=self.connect()
            try:
                db.execute('BEGIN IMMEDIATE')
                before=self.marker(db); db.writes=[]
                require(not before['journal'] or before['sequence'], '기존 지갑의 블록체인 이관이 먼저 필요합니다.', 'MIGRATION_REQUIRED', 503)
                yield db
                rows=[dict(r) for r in db.execute('SELECT * FROM journal WHERE id>? ORDER BY id',(before['journal'],))]
                if not rows:
                    db.commit(); return
                assets=[dict(r) for r in db.execute('SELECT * FROM assets ORDER BY symbol')]
                batch=uuid.uuid4().hex+uuid.uuid4().hex
                digest=hashlib.sha256(canonical(rows).encode()).hexdigest()
                signed=self.backend.prepare(batch,before['sequence'],assets,rows,digest)
                plan={'version':1,'before':before,'signed':signed,'writes':db.writes,'first':rows[0]['id'],'last':rows[-1]['id']}
                durable_json(self.pending,plan)
                db.rollback()
                self.recover()
            except BaseException:
                db.rollback(); raise
            finally: db.close()

    def migrate(self):
        """Import a frozen legacy snapshot exactly once; retain every existing row."""
        with self.serialized():
            self.recover()
            with self.connect() as db:
                before=self.marker(db)
                if before['sequence']: return {'alreadyMigrated':True}
                assets=[dict(r) for r in db.execute('SELECT * FROM assets ORDER BY symbol')]
                rows=[dict(r) for r in db.execute('SELECT owner,asset,amount FROM balances WHERE amount>0 ORDER BY owner,asset')]
                sums={a['symbol']:sum(r['amount'] for r in rows if r['asset']==a['symbol']) for a in assets}
                require(all(sums[a['symbol']]==a['supply'] for a in assets),'기존 잔액 합계가 발행량과 다릅니다.','MIGRATION_INVARIANT',503)
                require(rows,'이전할 지갑이 없습니다.','MIGRATION_EMPTY',409)
                snapshot=hashlib.sha256(canonical({'assets':assets,'balances':rows}).encode()).hexdigest()
                moves=[{'asset':r['asset'],'source':'@mint','destination':r['owner'],'amount':r['amount']} for r in rows]
                signed=self.backend.prepare(snapshot,0,assets,moves,snapshot)
                plan={'version':1,'before':before,'signed':signed,'writes':[['INSERT INTO chain_migrations VALUES(?,?)',[snapshot,signed['hash']]]],'first':1,'last':before['journal']}
                durable_json(self.pending,plan)
            self.recover()
            return {'migrated':True,'snapshotHash':snapshot,'accounts':len(rows),'transactionHash':signed['hash']}

    def wallet(self, uid):
        with self.serialized():
            self.recover()
            value=super().wallet(uid)
            block=self.backend.head()['number']
            with self.connect() as db:
                entries=[(uid,b['symbol']) for b in value['balances']]
                for row in db.execute("SELECT id,asset,side FROM orders WHERE owner=? AND status='open'",(uid,)):
                    entries.append(('@order:'+row['id'],'KARMA' if row['side']=='buy' else row['asset']))
                for row in db.execute("SELECT id FROM service_jobs WHERE buyer=? AND state NOT IN ('paid','refunded')", (uid,)):
                    entries.append(('@service:'+row['id'], 'KARMA'))
                amounts=self.backend.balances(entries,block)
                for owner,symbol in entries:
                    require(amounts[(owner,symbol)]==self.balance(db,owner,symbol),'블록체인 잔액과 거래소 인덱스가 다릅니다.','CHAIN_DIVERGENCE',503)
                for b in value['balances']:
                    b['available']=amounts[(uid,b['symbol'])]; b['tokenAddress']=self.backend.token(b['symbol'],block).address
                for h in value['history']:
                    proof=db.execute('SELECT tx_hash,block_number FROM chain_commits WHERE first_journal<=? AND last_journal>=? ORDER BY sequence DESC LIMIT 1',(h['id'],h['id'])).fetchone()
                    if proof:
                        migrated=db.execute('SELECT 1 FROM chain_migrations WHERE tx_hash=?',(proof['tx_hash'],)).fetchone()
                        h.update(transactionHash=proof['tx_hash'],blockNumber=proof['block_number'],chainKind='migration' if migrated else 'transaction')
            value['address']=owner_address(uid)
            value['blockNumber']=block
            value['chainId']=self.backend.config['chainId']
            value['feeDestination']={'name':'학과 공동 금고','address':owner_address('@treasury')}
            return value

    def audit(self):
        with self.serialized():
            self.recover()
            value=super().audit()
            block=self.backend.head()['number']
            with self.connect() as db:
                rows=[dict(r) for r in db.execute('SELECT * FROM balances')]
                amounts=self.backend.balances([(r['owner'],r['asset']) for r in rows],block)
                require(all(amounts[(r['owner'],r['asset'])]==r['amount'] for r in rows),'블록체인 지갑 검사 실패','CHAIN_DIVERGENCE',503)
                for asset in value['supplies']:
                    token=self.backend.token(asset['symbol'],block)
                    require(token.functions.totalSupply().call(block_identifier=block)==asset['supply'],'블록체인 발행량 검사 실패','CHAIN_DIVERGENCE',503)
                require(self.backend.hub.functions.sequence().call(block_identifier=block)==self.marker(db)['sequence'],'블록체인 정산 순서 검사 실패','CHAIN_DIVERGENCE',503)
            value['chain']=self.backend.summary(); value['verifiedWallets']=len(rows)
            return value

    def chain_state(self):
        with self.serialized():
            self.recover()
            value=self.backend.summary()
            with self.connect() as db:
                value['transactions']=[dict(r) for r in db.execute('SELECT tx_hash transactionHash,block_number blockNumber,created FROM chain_commits ORDER BY sequence DESC LIMIT 30')]
            return value

    def community(self, uid):
        with self.serialized():
            self.recover()
            return super().community(uid)

    def economy(self):
        with self.serialized():
            self.recover()
            value = super().economy()
            amounts = self.backend.balances([('@treasury', 'KARMA'), ('@reserve', 'KARMA')])
            require(value['treasury'] == amounts[('@treasury', 'KARMA')] and value['reserve'] == amounts[('@reserve', 'KARMA')], '공동 금고 블록체인 잔액이 일치하지 않습니다.', 'CHAIN_DIVERGENCE', 503)
            return value

    def chain_receipt(self, tx_hash):
        with self.connect() as db:
            require(db.execute('SELECT 1 FROM chain_commits WHERE tx_hash=?',(tx_hash,)).fetchone(),'거래를 찾을 수 없습니다.','NOT_FOUND',404)
        return self.backend.receipt(tx_hash)
