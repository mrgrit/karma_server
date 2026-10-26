import concurrent.futures
import json
import tempfile
import unittest
import uuid
from pathlib import Path
from ledger import Ledger, Problem
from coin_buckets import DAY, HALF_HOUR, KST

class Coins(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'coins.sqlite'
        self.clock=20000*DAY-KST+12*3600000
        self.db=Ledger(self.path);self.db.now=lambda:self.clock
        self.admin=dict(playerId=self.key(),name='Admin',role='admin',rankIndex=0)
        self.a=dict(playerId=self.key(),name='Student A',role='user',rankIndex=0)
        self.b=dict(playerId=self.key(),name='Student B',role='user',rankIndex=0)
        self.db.ensure(self.admin)
        self.db.treasury_fund(self.admin['playerId'],self.key(),dict(amount=1000000,reason='Test budget'))
        self.db.ensure(self.a);self.db.ensure(self.b)
    def tearDown(self):self.temp.cleanup()
    def key(self):return str(uuid.uuid4())
    def coins(self,p=None):return self.db.wallet((p or self.a)['playerId'])['coins']
    def game(self,final=True):
        gid=self.key();self.db.game('reserve',dict(matchId=gid,players=[self.a,self.b]));self.db.game('commit',dict(matchId=gid))
        if final:self.db.game('finalize',dict(matchId=gid))
        return gid
    def reward(self,amount):self.db.reward(self.admin['playerId'],self.key(),dict(recipients=[self.a['playerId']],amount=amount,reason='Test bonus'))
    def test_new_account_cap_and_once(self):
        c=self.coins();self.assertEqual((c['base'],c['daily'],c['bonus'],c['total']),(10000,1000,0,11000))
        self.clock+=3*DAY;self.db.ensure(self.a);self.assertEqual(self.coins()['total'],11000)
        self.db=Ledger(self.path);self.db.now=lambda:self.clock
        self.assertEqual(self.coins()['total'],11000);self.db.audit()
    def test_offline_refill_no_banked_time_and_spend_order(self):
        self.clock+=4*3600000;self.game();self.assertEqual(self.coins()['daily'],900)
        self.clock+=HALF_HOUR-1;self.assertEqual(self.coins()['daily'],900)
        self.clock+=1;self.assertEqual(self.coins()['daily'],1000)
        self.reward(150)
        for _ in range(12):self.game()
        c=self.coins();self.assertEqual((c['daily'],c['bonus'],c['base']),(0,0,9950))
        self.clock+=HALF_HOUR;self.assertEqual(self.coins()['daily'],100)
        self.db.audit()
    def test_midnight_resets_to_cap_without_carry_and_rank(self):
        self.game();self.game();self.clock=(self.clock+KST)//DAY*DAY-KST+DAY
        self.assertEqual(self.coins()['daily'],1000)
        self.a['rankIndex']=2;self.db.ensure(self.a);self.assertEqual(self.coins()['dailyCap'],1400)
        self.clock+=HALF_HOUR;self.assertEqual(self.coins()['daily'],1100)
        self.clock+=DAY;self.assertEqual(self.coins()['daily'],1400)
        self.a['rankIndex']=0;self.db.ensure(self.a);self.assertEqual(self.coins()['daily'],1000);self.db.audit()
    def test_bonus_only_transfer_market_service_and_refunds(self):
        a,b=self.a['playerId'],self.b['playerId']
        with self.assertRaises(Problem):self.db.transfer(a,self.key(),dict(to=b,asset='KARMA',amount=1))
        self.db.issue(b,self.key(),dict(symbol='LAB',name='Lab',supply=50))
        with self.assertRaises(Problem):self.db.order(a,self.key(),dict(asset='LAB',side='buy',quantity=1,price=100))
        sid=self.db.service_action(b,self.key(),dict(action='create',title='Help',description='Tutoring',price=100,days=1))['serviceId']
        with self.assertRaises(Problem):self.db.service_action(a,self.key(),dict(action='buy',serviceId=sid,request='Help'))
        self.reward(500);self.db.transfer(a,self.key(),dict(to=b,asset='KARMA',amount=100));self.assertEqual(self.coins(self.b)['bonus'],100)
        order=self.db.order(a,self.key(),dict(asset='LAB',side='buy',quantity=2,price=100))
        self.assertEqual(self.coins()['bonus'],200);self.db.cancel(a,self.key(),dict(orderId=order['orderId']));self.assertEqual(self.coins()['bonus'],400)
        self.db.audit()
    def test_refund_restores_types_without_laundering_or_overcap(self):
        gid=self.game(False);self.db.game('refund',dict(matchId=gid));self.db.game('refund',dict(matchId=gid))
        self.assertEqual((self.coins()['daily'],self.coins()['bonus']),(1000,0))
        gid=self.game(False);self.clock+=DAY;self.db.game('refund',dict(matchId=gid))
        self.assertEqual((self.coins()['daily'],self.coins()['bonus']),(1000,0));self.db.audit()
    def test_concurrent_refill_and_game_idempotency(self):
        self.game();self.clock+=HALF_HOUR
        with concurrent.futures.ThreadPoolExecutor(4) as pool:values=list(pool.map(lambda _:self.coins()['daily'],range(8)))
        self.assertEqual(values,[1000]*8)
        gid=self.key();req=dict(matchId=gid,players=[self.a,self.b])
        with concurrent.futures.ThreadPoolExecutor(4) as pool:list(pool.map(lambda _:self.db.game('reserve',req),range(8)))
        self.assertEqual(self.coins()['daily'],900);self.db.audit()
    def test_reset_authority_replay_and_penalty_debt(self):
        uid=self.a['playerId'];self.reward(350)
        with self.assertRaises(Problem):self.db.reset_coins(uid,self.key(),dict(playerId=uid,reason='No permission'))
        key=self.key();req=dict(playerId=uid,reason='Confirmed reset')
        self.db.reset_coins(self.admin['playerId'],key,req);self.game();self.db.reset_coins(self.admin['playerId'],key,req)
        self.assertEqual((self.coins()['base'],self.coins()['daily'],self.coins()['bonus']),(10000,900,0))
        cid=self.key();req=dict(caseId=cid,playerId=uid,action='apply',amount=12000,reason='Confirmed violation')
        self.db.sanction_coins(self.admin['playerId'],'apply:'+cid,req)
        c=self.coins();self.assertEqual((c['total'],c['penaltyDebt']),(0,1100))
        with self.assertRaises(Problem):self.db.reset_coins(self.admin['playerId'],self.key(),dict(playerId=uid,reason='Evade penalty'))
        self.clock+=HALF_HOUR;c=self.coins();self.assertEqual((c['daily'],c['penaltyDebt']),(0,1000))
        self.db.sanction_coins(self.admin['playerId'],'revoke:'+cid,dict(caseId=cid,playerId=uid,action='revoke'))
        c=self.coins();self.assertEqual((c['bonus'],c['penaltyDebt']),(11000,0));self.db.audit()

    def test_pending_budget_frozen_and_incoming_debt(self):
        uid=self.a['playerId'];cid=self.key()
        self.db.sanction_coins(self.admin['playerId'],self.key(),dict(caseId=cid,playerId=uid,amount=12000,action='apply',reason='Confirmed penalty'))
        self.a['sanctions']={'active':True};self.db.ensure(self.a)
        self.clock+=DAY;self.assertEqual(self.coins()['daily'],0)
        self.reward(200);self.assertEqual((self.coins()['bonus'],self.coins()['penaltyDebt']),(0,800))
        self.a['sanctions']={'active':False};self.db.ensure(self.a)
        self.assertEqual((self.coins()['daily'],self.coins()['penaltyDebt']),(200,0));self.db.audit()
        # Missing budget is pending, not an unbacked mint; funding retries once.
        p=dict(playerId=self.key(),name='Unfunded',role='user')
        with self.db.transaction() as db:
            available=self.db.treasury_available(db)
            self.db.treasury_spend(db,self.key(),self.admin['playerId'],available,'Move test budget',self.admin['playerId'])
        self.db.ensure(p);c=self.coins(p);self.assertEqual(c['total'],0);self.assertTrue(c['dailyPending'])
        self.db.treasury_fund(self.admin['playerId'],self.key(),dict(amount=11000,reason='Restore test budget'))
        self.db.ensure(p);self.assertEqual(self.coins(p)['total'],11000);self.assertFalse(self.coins(p)['dailyPending']);self.db.audit()

if __name__=='__main__':unittest.main()
