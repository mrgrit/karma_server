from test_support import existing_student
import concurrent.futures
import tempfile
import unittest
import uuid
from pathlib import Path
from ledger import Ledger, Problem, COIN


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name)/'ledger.sqlite'
        self.db = Ledger(self.path)
        self.a, self.b, self.c = [dict(playerId=str(uuid.uuid4()), name='학생 '+str(i), role='admin' if i == 0 else 'user') for i in range(3)]
        self.db.ensure(self.a)
        self.db.treasury_fund(self.a['playerId'], self.key(), dict(amount=10000, reason='Test operating budget'))
        for p in [self.b, self.c]:
            existing_student(self.db,p)

    def tearDown(self):
        self.temp.cleanup()

    def balance(self, p, asset=COIN):
        return next((b['available'] for b in self.db.wallet(p['playerId'])['balances'] if b['symbol'] == asset), 0)

    def key(self):
        return str(uuid.uuid4())

    def test_initial_once_and_restart(self):
        self.assertEqual(self.balance(self.a), 99990000)
        self.assertEqual(self.balance(self.b), 300)
        for _ in range(3):
            Ledger(self.path).ensure(self.a)
            Ledger(self.path).ensure(self.b)
        self.assertEqual(self.balance(self.a), 99990000)
        self.assertEqual(self.balance(self.b), 300)
        self.db.audit()

    def test_duplicate_transfer_and_racing_overspend(self):
        payload = dict(to=self.c['playerId'], asset=COIN, amount=100)
        key = self.key()
        first = self.db.transfer(self.b['playerId'], key, payload)
        self.assertEqual(first, self.db.transfer(self.b['playerId'], key, payload))
        with self.assertRaises(Problem):
            self.db.transfer(self.b['playerId'], key, {**payload, 'amount': 200})
        def take(_):
            try:
                self.db.transfer(self.b['playerId'], self.key(), {**payload, 'amount': 150})
                return True
            except Problem:
                return False
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(sum(pool.map(take, range(8))), 1)
        self.assertEqual(self.balance(self.b), 50)
        self.assertEqual(self.balance(self.c), 550)
        self.db.audit()

    def test_reward_atomic_and_authority(self):
        request = dict(recipients=[self.b['playerId'], self.c['playerId']], amount=500, reason='메이커톤 참가')
        with self.assertRaises(Problem):
            self.db.reward(self.b['playerId'], self.key(), request)
        with self.assertRaises(Problem):
            self.db.reward(self.a['playerId'], self.key(), {**request, 'recipients': [self.b['playerId'], str(uuid.uuid4())]})
        self.assertEqual(self.balance(self.b), 300)
        key = self.key()
        self.db.reward(self.a['playerId'], key, request)
        self.db.reward(self.a['playerId'], key, request)
        self.assertEqual(self.balance(self.b), 800)
        self.db.audit()

    def test_order_matching_escrow_refund_cancel(self):
        self.db.issue(self.b['playerId'], self.key(), dict(symbol='LAB', name='실습 코인', supply=100))
        sell = self.db.order(self.b['playerId'], self.key(), dict(asset='LAB', side='sell', price=20, quantity=10))
        buy = self.db.order(self.c['playerId'], self.key(), dict(asset='LAB', side='buy', price=25, quantity=12))
        self.assertEqual(buy['filled'], 10)
        self.assertEqual(self.balance(self.c), 50)  # 200 paid +50 reserved,50 available
        self.assertEqual(self.db.wallet(self.c['playerId'])['locked'][COIN], 50)
        self.assertEqual(self.balance(self.c, 'LAB'), 10)
        self.assertEqual(self.balance(self.b), 500)
        self.assertEqual(self.balance(self.b, 'LAB'), 90)
        self.db.cancel(self.c['playerId'], self.key(), dict(orderId=buy['orderId']))
        self.db.cancel(self.c['playerId'], self.key(), dict(orderId=buy['orderId']))
        self.assertEqual(self.balance(self.c), 100)
        self.db.audit()

    def test_sell_matches_highest_oldest_buy_and_self_trade_rejected(self):
        self.db.issue(self.b['playerId'], self.key(), dict(symbol='LAB', name='실습 코인', supply=100))
        self.db.order(self.c['playerId'], self.key(), dict(asset='LAB', side='buy', price=30, quantity=2))
        self.db.order(self.a['playerId'], self.key(), dict(asset='LAB', side='buy', price=40, quantity=2))
        self.db.order(self.b['playerId'], self.key(), dict(asset='LAB', side='sell', price=25, quantity=3))
        self.assertEqual(self.balance(self.a, 'LAB'), 2)
        self.assertEqual(self.balance(self.c, 'LAB'), 1)
        with self.assertRaises(Problem):
            self.db.order(self.c['playerId'], self.key(), dict(asset='LAB', side='sell', price=30, quantity=1))
        self.db.audit()

    def test_game_fee_all_or_nothing_restart_duplicate_and_refund(self):
        gid = self.key()
        payload = dict(matchId=gid, players=[self.b, self.c], expiresAt=self.db.now()+20000)
        self.db.game('reserve', payload)
        self.db.game('reserve', payload)
        self.assertEqual(self.balance(self.b), 200)
        self.db.game('commit', dict(matchId=gid))
        Ledger(self.path).game('commit', dict(matchId=gid))
        self.assertEqual(self.db.audit()['treasury'], 9600)
        self.db.game('refund', dict(matchId=gid))
        self.db.game('refund', dict(matchId=gid))
        self.assertEqual(self.balance(self.b), 300)
        self.db.transfer(self.c['playerId'], self.key(), dict(to=self.a['playerId'], asset=COIN, amount=250))
        with self.assertRaises(Problem):
            self.db.game('reserve', dict(matchId=self.key(), players=[self.b, self.c]))
        self.assertEqual(self.balance(self.b), 300)
        self.assertEqual(self.balance(self.c), 50)
        self.db.audit()

    def test_expired_reservation_never_debits(self):
        with self.assertRaises(Problem) as raised:
            self.db.game('reserve', dict(matchId=self.key(), players=[self.b,self.c], expiresAt=self.db.now()-1))
        self.assertEqual(raised.exception.code,'RESERVATION_EXPIRED')
        self.assertEqual(self.balance(self.b),300)

    def test_same_timestamp_orders_keep_insertion_priority(self):
        self.db.issue(self.b['playerId'],self.key(),dict(symbol='LAB',name='실습',supply=20))
        self.db.now=lambda:1792500000000
        self.db.order(self.c['playerId'],self.key(),dict(asset='LAB',side='buy',price=10,quantity=1))
        self.db.order(self.a['playerId'],self.key(),dict(asset='LAB',side='buy',price=10,quantity=1))
        self.db.order(self.b['playerId'],self.key(),dict(asset='LAB',side='sell',price=10,quantity=1))
        self.assertEqual(self.balance(self.c,'LAB'),1)
        self.assertEqual(self.balance(self.a,'LAB'),0)

    def test_private_coin_does_not_pay_fee_and_escrow_is_not_spendable(self):
        self.db.issue(self.b['playerId'], self.key(), dict(symbol='LAB', name='실습 코인', supply=1000000000))
        self.db.order(self.c['playerId'], self.key(), dict(asset='LAB', side='buy', price=100, quantity=3))
        with self.assertRaises(Problem):
            self.db.game('reserve', dict(matchId=self.key(), players=[self.b, self.c]))
        self.assertEqual(self.balance(self.b), 300)
        self.db.audit()


if __name__ == '__main__':
    unittest.main()
