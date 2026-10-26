"""Already-paid legacy students for low-balance settlement regression fixtures."""
import uuid
def existing_student(ledger, profile):
    uid=profile['playerId']
    with ledger.transaction() as db:
        db.execute('INSERT INTO users VALUES(?,?,?,?)',(uid,profile['name'],'user',ledger.now()))
        db.execute("INSERT INTO welcome_grants VALUES(?,'paid')",(uid,))
        ledger.treasury_spend(db,str(uuid.uuid4()),uid,300,'Legacy funded balance fixture','@department')


def fixed_balance(cls):
    """Legacy settlement tests hold time-based grants out of their fixed fixtures.
    Regeneration and bucket conservation are exercised with the default ledger
    by test_coin_buckets, including mixed game/refund/order operations.
    """
    class FixedBalance(cls):
        def refresh_daily(self, db, uid):
            self.coin_account(db, uid)
            self.collect_penalties(db, uid)
    return FixedBalance
