from test_support import existing_student
import concurrent.futures
import tempfile
import unittest
import uuid
from pathlib import Path
from ledger import Ledger, Problem
from test_support import fixed_balance
Ledger = fixed_balance(Ledger)


class EconomyTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.db=Ledger(Path(self.temp.name)/'ledger.sqlite')
        self.profiles=[dict(playerId=str(uuid.uuid4()),name='학생 '+str(i),role='admin' if i==0 else 'user') for i in range(4)]
        self.admin,self.a,self.b,self.c=[p['playerId'] for p in self.profiles]
        self.db.ensure(self.profiles[0]);self.db.treasury_fund(self.admin,self.key(),{'amount':10000,'reason':'테스트 예산'})
        for p in self.profiles[1:]:existing_student(self.db,p)
    def tearDown(self): self.temp.cleanup()
    def key(self): return str(uuid.uuid4())
    def balance(self,uid):
        with self.db.connect() as db:return self.db.balance(db,uid)
    def mission(self,slots=2):
        return self.db.mission_action(self.admin,self.key(),dict(action='create',title='CTF 문제 만들기',description='문제와 해설 제출\n검토 후 지급',reward=200,slots=slots,deadline=self.db.now()+86400000))['missionId']
    def claim(self,mid,uid): return self.db.mission_action(uid,self.key(),dict(action='claim',missionId=mid))['claimId']
    def change(self,uid,mid,cid,action,**extra): return self.db.mission_action(uid,self.key(),dict(action=action,missionId=mid,claimId=cid,**extra))
    def service(self): return self.db.service_action(self.b,self.key(),dict(action='create',title='코드 리뷰',description='30분 코드 리뷰',price=200,days=2))['serviceId']
    def buy(self,sid,uid=None): return self.db.service_action(uid or self.a,self.key(),dict(action='buy',serviceId=sid,request='테스트 코드를 봐 주세요'))['jobId']
    def job(self,uid,jid,action,**extra): return self.db.job_action(uid,self.key(),dict(action=action,jobId=jid,**extra))

    def test_rewards_do_not_mint_and_fail_atomically(self):
        supply=self.db.audit()['supplies'];before=self.balance('@treasury')
        p={'recipients':[self.a,self.b],'amount':500,'reason':'학과 행사'}; key=self.key()
        self.db.reward(self.admin,key,p);self.db.reward(self.admin,key,p)
        self.assertEqual(self.balance('@treasury'),before-1000);self.assertEqual(self.balance(self.a),800)
        self.assertEqual(self.db.audit()['supplies'],supply)
        with self.assertRaises(Problem):self.db.reward(self.admin,self.key(),{**p,'amount':100000})
        self.assertEqual(self.balance(self.a),800)

    def test_welcome_pending_once_and_existing_upgrade(self):
        with tempfile.TemporaryDirectory() as root:
            db=Ledger(Path(root)/'empty.sqlite');p=dict(playerId=self.key(),name='신입',role='user')
            self.assertTrue(db.ensure(p)['welcomePending']);self.assertEqual(db.wallet(p['playerId'])['balances'][0]['available'],0)
            admin=dict(playerId=self.key(),name='관리자',role='admin');db.ensure(admin)
            db.treasury_fund(admin['playerId'],self.key(),{'amount':10000,'reason':'체험 예산'})
            for _ in range(2):db.welcome_claim(p['playerId'],self.key(),{})
            self.assertEqual(db.wallet(p['playerId'])['balances'][0]['available'],10000)
            db=Ledger(db.filename);db.ensure(p);self.assertFalse(db.wallet(p['playerId'])['welcomePending'])
            self.assertEqual(db.audit()['supplies'][0]['supply'],100000000)

    def test_hundred_coin_grant_atomic_once_and_legacy_not_topped_up(self):
        admin=self.profiles[0];p=dict(playerId=self.key(),name='New hundred grant',role='user')
        self.db.treasury_fund(self.admin,self.key(),dict(amount=10000,reason='Welcome budget'))
        supply=self.db.audit()['supplies'];before=self.balance('@treasury')
        self.db.ensure(p)
        self.assertEqual(self.balance(p['playerId']),10000)
        self.assertEqual(self.balance('@treasury'),before-10000)
        def retry(_):self.db.welcome_claim(p['playerId'],self.key(),{})
        with concurrent.futures.ThreadPoolExecutor(4) as pool:list(pool.map(retry,range(4)))
        self.db=Ledger(self.db.filename);self.db.ensure(p);self.db.ensure(self.profiles[1])
        self.assertEqual(self.balance(p['playerId']),10000);self.assertEqual(self.balance(self.a),300)
        self.assertEqual(self.db.audit()['supplies'],supply)

    def test_mission_reserve_approve_close_reject_and_replay(self):
        before=self.balance('@treasury');mid=self.mission(3);a=self.claim(mid,self.a);b=self.claim(mid,self.b)
        self.assertEqual(self.balance('@treasury'),before-600)
        self.db.mission_action(self.admin,self.key(),dict(action='close',missionId=mid))
        self.assertEqual(self.balance('@mission:'+mid),400)
        self.change(self.a,mid,a,'submit',evidence='완료\nhttps://example.invalid/proof')
        with self.assertRaises(Problem):self.change(self.b,mid,a,'approve',review='허위 승인')
        key=self.key();payload=dict(action='approve',missionId=mid,claimId=a,review='문제와 해설 확인')
        self.db.mission_action(self.admin,key,payload);self.db.mission_action(self.admin,key,payload)
        self.change(self.admin,mid,b,'reject',review='기한 내 미제출')
        self.assertEqual(self.balance(self.a),500);self.assertEqual(self.balance('@mission:'+mid),0)
        self.assertEqual(self.balance('@treasury'),before-200);self.db.audit()
        self.assertEqual(self.db.economy()['totals']['reissued'],200) # current mission reward; legacy balances excluded

    def test_mission_last_slot_race_and_expiry(self):
        mid=self.mission(1)
        def claim(uid):
            try:return self.claim(mid,uid)
            except Problem:return None
        with concurrent.futures.ThreadPoolExecutor(3) as pool:results=list(pool.map(claim,[self.a,self.b,self.c]))
        self.assertEqual(sum(bool(r) for r in results),1);self.db.audit()
        self.db.now=lambda:9999999999999
        with self.assertRaises(Problem):self.claim(mid,self.a)

    def test_service_payment_authority_and_no_leaks(self):
        sid=self.service();jid=self.buy(sid)
        self.assertEqual(self.balance(self.a),100);self.assertEqual(self.balance(self.b),300)
        self.assertEqual(self.db.wallet(self.a)['serviceLocked'],200)
        self.assertFalse(self.db.community(self.c)['jobs'])
        with self.assertRaises(Problem):self.job(self.c,jid,'complete')
        with self.assertRaises(Problem):self.job(self.a,jid,'complete')
        self.job(self.b,jid,'accept');self.job(self.b,jid,'deliver',note='리뷰 결과')
        self.job(self.a,jid,'complete');self.assertEqual(self.balance(self.b),500)
        with self.assertRaises(Problem):self.job(self.a,jid,'complete')
        self.assertEqual(self.balance('@service:'+jid),0);self.db.audit()
        self.assertEqual(self.db.economy()['totals']['servicePaid'],200)

    def test_service_cancellation_dispute_timeout_and_snapshot(self):
        sid=self.service();jid=self.buy(sid);self.job(self.a,jid,'cancel',note='취소')
        self.assertEqual(self.balance(self.a),300)
        jid=self.buy(sid);self.job(self.b,jid,'accept')
        with self.assertRaises(Problem):self.job(self.a,jid,'cancel',note='수락 후 취소')
        self.job(self.a,jid,'dispute',note='협의 요청')
        with self.assertRaises(Problem):self.job(self.b,jid,'complete')
        self.job(self.admin,jid,'resolve',decision='refund',note='합의된 취소')
        self.assertEqual(self.balance(self.a),300)
        jid=self.buy(sid);self.job(self.b,jid,'accept');old=self.db.now;self.db.now=lambda:old()+3*86400000
        self.job(self.a,jid,'cancel',note='기한 경과');self.assertEqual(self.balance(self.a),300)
        self.db.audit()

    def test_game_refund_protection_and_eighty_twenty_finalization(self):
        match={'matchId':self.key(),'players':self.profiles[1:3]}
        before=self.db.economy()['spendable'];self.db.game('reserve',match);self.db.game('commit',match)
        self.assertEqual(self.db.economy()['spendable'],before)
        self.db.game('finalize',match);self.db.game('finalize',match)
        self.assertEqual(self.db.economy()['spendable'],before+160);self.assertEqual(self.balance('@reserve'),40)
        with self.assertRaises(Problem):self.db.game('refund',match)
        self.db.audit();e=self.db.economy()
        self.assertEqual(e['totalSupply'],sum(e[k] for k in ['treasury','reserve','studentWallets','adminWallets','missionEscrow','serviceEscrow','orderEscrow','gameEscrow','other']))


if __name__=='__main__':unittest.main()
