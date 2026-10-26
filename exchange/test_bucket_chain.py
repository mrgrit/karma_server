"""Real EVM test: isolated contracts and wallets, never production keys/balances."""
import os
import tempfile
import unittest
import uuid
from pathlib import Path
from deploy_chain import deploy
from chain_backend import EvmBackend
from chain_ledger import ChainLedger
from ledger import Problem
from coin_buckets import DAY, KST, HALF_HOUR

@unittest.skipUnless(os.environ.get('CHAIN_TEST_RPC'), 'Requires isolated test contract on private EVM')
class BucketChain(unittest.TestCase):
    def test_projection_recharge_refund_recovery_and_sanction(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);key=lambda:str(uuid.uuid4())
            deploy(os.environ['CHAIN_TEST_RPC'],root/'keys')
            backend=EvmBackend(root/'keys/chain.json',root/'keys/operator.key')
            path=root/'ledger.sqlite';ledger=ChainLedger(path,backend)
            clock=20000*DAY-KST+12*3600000;ledger.now=lambda:clock
            admin=dict(playerId=key(),name='Isolated admin',role='admin',rankIndex=0)
            a,b=[dict(playerId=key(),name='Isolated student '+str(i),role='user',rankIndex=0) for i in range(2)]
            ledger.ensure(admin);ledger.treasury_fund(admin['playerId'],key(),dict(amount=100000,reason='Isolated bucket test'))
            for p in (a,b):ledger.ensure(p)
            supply=ledger.audit()['supplies']
            coins=lambda:ledger.wallet(a['playerId'])['coins']
            self.assertEqual((coins()['base'],coins()['daily'],coins()['bonus']),(10000,1000,0))
            with self.assertRaises(Problem):ledger.transfer(a['playerId'],key(),dict(asset='KARMA',to=b['playerId'],amount=100))
            match=dict(matchId=key(),players=[a,b]);ledger.game('reserve',match);ledger.game('commit',match)
            self.assertEqual(coins()['daily'],900)
            ledger.game('refund',match);ledger.game('refund',match);self.assertEqual(coins()['daily'],1000)
            match=dict(matchId=key(),players=[a,b]);ledger.game('reserve',match);ledger.game('commit',match);ledger.game('finalize',match)
            clock+=HALF_HOUR
            ledger.apply_plan=lambda *_:(_ for _ in ()).throw(OSError('simulated restart after EVM settlement'))
            with self.assertRaises(OSError):coins()
            ledger=ChainLedger(path,backend);ledger.now=lambda:clock
            self.assertEqual(coins()['daily'],1000);self.assertEqual(coins()['bonus'],0)
            self.assertEqual(coins()['dailyRefilled'],100)
            self.assertEqual(coins()['dailyRefillRemaining'],900)
            ledger.reward(admin['playerId'],key(),dict(recipients=[a['playerId']],amount=500,reason='Verified activity bonus'))
            ledger.transfer(a['playerId'],key(),dict(asset='KARMA',to=b['playerId'],amount=200))
            self.assertEqual(coins()['bonus'],300)
            solo=dict(matchId=key(),players=[b]);ledger.game('reserve',solo);ledger.game('reserve',solo)
            ledger.game('commit',solo);ledger.game('finalize',solo)
            self.assertEqual(ledger.wallet(b['playerId'])['coins']['daily'],900)
            case=key();payload=dict(caseId=case,playerId=a['playerId'],amount=12000,action='apply',reason='Isolated penalty')
            ledger.sanction_coins(admin['playerId'],'apply:'+case,payload);ledger.sanction_coins(admin['playerId'],'apply:'+case,payload)
            self.assertEqual((coins()['total'],coins()['penaltyDebt']),(0,700))
            ledger.sanction_coins(admin['playerId'],'revoke:'+case,dict(caseId=case,playerId=a['playerId'],action='revoke'))
            self.assertEqual((coins()['bonus'],coins()['penaltyDebt']),(11300,0))
            ledger.reset_coins(admin['playerId'],key(),dict(playerId=a['playerId'],reason='Authorized isolated reset'))
            self.assertEqual((coins()['base'],coins()['daily'],coins()['bonus']),(10000,1000,0))
            self.assertTrue(ledger.audit()['ok'])
            self.assertEqual(backend.balances([(a['playerId'],'KARMA')])[(a['playerId'],'KARMA')],11000)
            self.assertEqual(ledger.audit()['supplies'],supply)
            print('PASS isolated EVM: classified coins, bonus-only transfer, game/refund, recharge crash recovery, fines/revoke, reset and conserved supply',flush=True)

if __name__=='__main__':unittest.main()
