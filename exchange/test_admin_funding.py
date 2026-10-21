import tempfile
import unittest
import uuid
from pathlib import Path
from ledger import Ledger, Problem, COIN
from migrate_admin_million import fund_admin, TARGET


class AdminFundingTests(unittest.TestCase):
    def test_legacy_balance_and_replay_after_spending(self):
        with tempfile.TemporaryDirectory() as folder:
            ledger = Ledger(Path(folder) / 'ledger.sqlite')
            admin, student = str(uuid.uuid4()), str(uuid.uuid4())
            ledger.ensure({'playerId': student, 'name': '학생', 'role': 'user'})
            with ledger.transaction() as db:
                db.execute('INSERT INTO users VALUES(?,?,?,?)', (admin, '관리자', 'admin', ledger.now()))
                ledger.move(db, str(uuid.uuid4()), COIN, '@mint', admin, 10_000_000, '기존 최초 지급', '@department')
                ledger.move(db, str(uuid.uuid4()), COIN, admin, '@treasury', 100, '기존 대전 이용료', '@game-server')
            result = fund_admin(ledger, admin)
            self.assertEqual((result['before'], result['added'], result['after']), (9_999_900, 90_000_100, TARGET))
            ledger.transfer(admin, 'after-increase-test', {'to': student, 'asset': COIN, 'amount': 100})
            self.assertEqual(fund_admin(Ledger(ledger.filename), admin), result)
            with ledger.connect() as db:
                self.assertEqual(ledger.balance(db, admin), TARGET - 100)
                self.assertEqual(ledger.balance(db, student), 400)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM journal WHERE tx=?', (result['transactionId'],)).fetchone()[0], 1)
            self.assertTrue(ledger.audit()['ok'])
            with self.assertRaises(Problem):
                fund_admin(ledger, student)

    def test_new_admin_already_has_million(self):
        with tempfile.TemporaryDirectory() as folder:
            ledger = Ledger(Path(folder) / 'ledger.sqlite')
            admin = str(uuid.uuid4())
            ledger.ensure({'playerId': admin, 'name': '관리자', 'role': 'admin'})
            result = fund_admin(ledger, admin)
            self.assertEqual((result['added'], result['after']), (0, TARGET))
            self.assertTrue(ledger.audit()['ok'])


if __name__ == '__main__':
    unittest.main()
