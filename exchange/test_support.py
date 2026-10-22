"""Already-paid legacy students for low-balance settlement regression fixtures."""
import uuid
def existing_student(ledger, profile):
    uid=profile['playerId']
    with ledger.transaction() as db:
        db.execute('INSERT INTO users VALUES(?,?,?,?)',(uid,profile['name'],'user',ledger.now()))
        db.execute("INSERT INTO welcome_grants VALUES(?,'paid')",(uid,))
        ledger.treasury_spend(db,str(uuid.uuid4()),uid,300,'Legacy funded balance fixture','@department')
