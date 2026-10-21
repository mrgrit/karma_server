"""Run against real QBFT EVM, using isolated contracts and disposable users only."""
import concurrent.futures
import json
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from chain_backend import EvmBackend, owner_address
from chain_ledger import ChainLedger, durable_json
from deploy_chain import deploy
from ledger import Ledger, Problem


@unittest.skipUnless(os.environ.get('CHAIN_TEST_RPC'),'Set CHAIN_TEST_RPC to an isolated private-chain RPC')
class ChainTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.keys=self.root/'keys'
        deploy(os.environ['CHAIN_TEST_RPC'],self.keys)
        self.backend=EvmBackend(self.keys/'chain.json',self.keys/'operator.key')
        self.path=self.root/'exchange.sqlite'
        self.ledger=ChainLedger(self.path,self.backend)
        self.admin=dict(playerId=str(uuid.uuid4()),name='Isolated budget admin',role='admin')
        self.ledger.ensure(self.admin)
        self.ledger.treasury_fund(self.admin['playerId'],str(uuid.uuid4()),dict(amount=10000,reason='Isolated test budget'))
        self.a,self.b=[{'playerId':str(uuid.uuid4()),'name':'Isolated Chain Test '+str(i),'role':'user'} for i in range(2)]
        for p in (self.a,self.b):self.ledger.ensure(p)

    def tearDown(self):self.temp.cleanup()
    def balance(self,p,asset='KARMA'):
        return next((b['available'] for b in self.ledger.wallet(p['playerId'])['balances'] if b['symbol']==asset),0)
    def transfer(self,key=None,amount=100):
        return self.ledger.transfer(self.a['playerId'],key or str(uuid.uuid4()),{'asset':'KARMA','to':self.b['playerId'],'amount':amount})

    def test_atomic_matching_cancellation_and_supply(self):
        a,b=self.a['playerId'],self.b['playerId']
        self.ledger.issue(a,str(uuid.uuid4()),{'symbol':'LAB','name':'Lab test coin','supply':100})
        buy=self.ledger.order(b,str(uuid.uuid4()),{'asset':'LAB','side':'buy','price':25,'quantity':4})
        self.assertEqual(self.balance(self.b),200)
        self.assertEqual(self.ledger.wallet(b)['locked']['KARMA'],100)
        sell=self.ledger.order(a,str(uuid.uuid4()),{'asset':'LAB','side':'sell','price':20,'quantity':2})
        self.assertEqual(sell['filled'],2)
        self.assertEqual(self.balance(self.b,'LAB'),2)
        self.assertEqual(self.balance(self.a),350)
        self.ledger.cancel(b,str(uuid.uuid4()),{'orderId':buy['orderId']})
        self.assertEqual(self.balance(self.b),250)
        self.assertTrue(self.ledger.audit()['ok'])
        with self.assertRaises(Problem):
            self.backend.prepare(uuid.uuid4().hex*2,self.backend.hub.functions.sequence().call(),[],[{'asset':'LAB','source':'@mint','destination':a,'amount':1}],'11'*32)

    def test_game_fee_treasury_refund_and_exactly_once(self):
        gid=str(uuid.uuid4()); request={'matchId':gid,'players':[self.a,self.b]}
        self.ledger.game('reserve',request);self.ledger.game('reserve',request)
        self.assertEqual(self.balance(self.a),200)
        self.ledger.game('commit',{'matchId':gid});self.ledger.game('commit',{'matchId':gid})
        self.assertEqual(self.ledger.audit()['treasury'],9600)
        proof=self.ledger.wallet(self.a['playerId'])['history'][0]
        self.assertTrue(proof['transactionHash'].startswith('0x'))
        self.assertEqual(self.ledger.chain_receipt(proof['transactionHash'])['status'],'confirmed')
        self.ledger.game('refund',{'matchId':gid});self.ledger.game('refund',{'matchId':gid})
        self.assertEqual(self.balance(self.a),300)
        self.assertEqual(self.ledger.audit()['treasury'],9400)

    def test_crash_after_chain_commit_before_sql_materialization(self):
        key=str(uuid.uuid4()); original=self.ledger.apply_plan
        self.ledger.apply_plan=lambda *_:(_ for _ in ()).throw(OSError('simulated power loss'))
        with self.assertRaises(OSError):self.transfer(key)
        plan=json.loads(self.ledger.pending.read_text())
        with self.ledger.connect() as db:self.assertEqual(self.ledger.balance(db,self.a['playerId']),300)
        self.assertEqual(self.backend.balances([(self.a['playerId'],'KARMA')])[(self.a['playerId'],'KARMA')],200)
        self.ledger=ChainLedger(self.path,self.backend)
        first=self.transfer(key); self.assertEqual(self.transfer(key),first)
        self.assertEqual(self.balance(self.a),200)
        # Simulate the other crash window: SQL committed, intent not yet unlinked.
        durable_json(self.ledger.pending,plan)
        self.ledger=ChainLedger(self.path,self.backend)
        self.assertEqual(self.balance(self.a),200)
        self.assertTrue(self.ledger.audit()['ok'])

    def test_rpc_failure_keeps_pending_without_sql_debit(self):
        resolve=self.backend.resolve; key=str(uuid.uuid4())
        self.backend.resolve=lambda *_:(_ for _ in ()).throw(Problem('offline','CHAIN_PENDING',503))
        with self.assertRaises(Problem):self.transfer(key)
        with self.ledger.connect() as db:self.assertEqual(self.ledger.balance(db,self.a['playerId']),300)
        self.backend.resolve=resolve
        self.ledger=ChainLedger(self.path,self.backend)
        self.transfer(key)
        self.assertEqual(self.balance(self.a),200)

    def test_parallel_overspend_and_permission_boundaries(self):
        def spend(_):
            try:self.transfer(amount=200);return True
            except Problem:return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            self.assertEqual(sum(pool.map(spend,range(6))),1)
        self.assertEqual(self.balance(self.a),100)
        token=self.backend.token('KARMA')
        with self.assertRaises(Exception):
            token.functions.transfer(owner_address(self.b['playerId']),1).call({'from':owner_address(self.a['playerId'])})
        with self.assertRaises(Exception):
            self.backend.hub.functions.setOperator(owner_address(self.a['playerId'])).call({'from':self.backend.account.address})
        self.assertTrue(self.ledger.audit()['ok'])

    def test_sql_balance_tampering_fails_closed(self):
        with self.ledger.connect() as db:db.execute('UPDATE balances SET amount=amount+100 WHERE owner=?',(self.a['playerId'],))
        with self.assertRaises(Problem) as error:self.ledger.wallet(self.a['playerId'])
        self.assertEqual(error.exception.code,'CHAIN_DIVERGENCE')

    def test_community_escrow_reward_recovery_and_game_split_on_chain(self):
        a,b,admin=self.a['playerId'],self.b['playerId'],self.admin['playerId'];key=lambda:str(uuid.uuid4())
        supply=self.ledger.audit()['supplies']
        mid=self.ledger.mission_action(admin,key(),dict(action='create',title='Chain mission',description='Complete a lab',reward=200,slots=2,deadline=self.ledger.now()+86400000))['missionId']
        cid=self.ledger.mission_action(a,key(),dict(action='claim',missionId=mid))['claimId']
        self.ledger.mission_action(a,key(),dict(action='submit',missionId=mid,claimId=cid,evidence='Lab result'))
        payload=dict(action='approve',missionId=mid,claimId=cid,review='Verified');once=key()
        self.ledger.apply_plan=lambda *_:(_ for _ in ()).throw(OSError('power loss during reward'))
        with self.assertRaises(OSError):self.ledger.mission_action(admin,once,payload)
        self.ledger=ChainLedger(self.path,self.backend)
        self.ledger.mission_action(admin,once,payload)
        self.assertEqual(self.balance(self.a),500)
        self.ledger.mission_action(admin,key(),dict(action='close',missionId=mid))
        sid=self.ledger.service_action(b,key(),dict(action='create',title='Review',description='Code review',price=200,days=1))['serviceId']
        jid=self.ledger.service_action(a,key(),dict(action='buy',serviceId=sid,request='Review this'))['jobId']
        self.assertEqual(self.ledger.wallet(a)['serviceLocked'],200)
        self.ledger.job_action(b,key(),dict(action='accept',jobId=jid))
        self.ledger.job_action(b,key(),dict(action='deliver',jobId=jid,note='Reviewed'))
        once=key();payload=dict(action='complete',jobId=jid)
        self.ledger.job_action(a,once,payload);self.ledger.job_action(a,once,payload)
        self.assertEqual(self.balance(self.b),500)
        match=dict(matchId=key(),players=[self.a,self.b])
        self.ledger.game('reserve',match);self.ledger.game('commit',match);self.ledger.game('finalize',match);self.ledger.game('finalize',match)
        self.assertEqual(self.ledger.economy()['reserve'],40)
        self.assertEqual(self.ledger.economy()['totals']['servicePaid'],200)
        self.assertEqual(self.ledger.audit()['supplies'],supply)
        self.assertEqual(self.backend.balances([('@mission:'+mid,'KARMA'),('@service:'+jid,'KARMA')]),{('@mission:'+mid,'KARMA'):0,('@service:'+jid,'KARMA'):0})


@unittest.skipUnless(os.environ.get('CHAIN_TEST_RPC'),'Requires private EVM')
class MigrationTests(unittest.TestCase):
    def test_snapshot_preserves_admin_students_treasury_and_reserved_orders(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); path=root/'old.sqlite'; legacy=Ledger(path)
            a,b=[{'playerId':str(uuid.uuid4()),'name':'Migration Test '+str(i),'role':'admin' if i==0 else 'user'} for i in range(2)]
            for p in (a,b):legacy.ensure(p)
            with legacy.transaction() as db:
                legacy.move(db,str(uuid.uuid4()),'KARMA','@mint',b['playerId'],300,'Legacy welcome fixture','@department')
            legacy.issue(b['playerId'],str(uuid.uuid4()),{'symbol':'LAB','name':'Imported coin','supply':100})
            legacy.order(b['playerId'],str(uuid.uuid4()),{'asset':'LAB','side':'sell','price':10,'quantity':7})
            match={'matchId':str(uuid.uuid4()),'players':[a,b]}
            legacy.game('reserve',match);legacy.game('commit',match)
            before=legacy.audit(); wallets={p['playerId']:legacy.wallet(p['playerId']) for p in (a,b)}
            keys=root/'keys';deploy(os.environ['CHAIN_TEST_RPC'],keys)
            backend=EvmBackend(keys/'chain.json',keys/'operator.key');ledger=ChainLedger(path,backend)
            result=ledger.migrate();self.assertTrue(result['migrated'])
            self.assertTrue(ledger.migrate()['alreadyMigrated'])
            self.assertEqual(ledger.audit()['supplies'],before['supplies']);self.assertEqual(ledger.audit()['treasury'],200)
            for uid,wallet in wallets.items():
                current=ledger.wallet(uid)
                self.assertEqual([(x['symbol'],x['available']) for x in current['balances']],[(x['symbol'],x['available']) for x in wallet['balances']])
                self.assertEqual(current['locked'],wallet['locked'])
            ledger.ensure(a);self.assertEqual(ledger.wallet(a['playerId'])['balances'][0]['available'],99999900)
            with self.assertRaises(Problem) as error:legacy.ensure(a)
            self.assertEqual(error.exception.code,'CHAIN_REQUIRED')


if __name__=='__main__':unittest.main(verbosity=2)
