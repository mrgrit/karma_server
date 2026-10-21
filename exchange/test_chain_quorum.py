"""Operator-run fault test on the new chain, before production migration.

init -> stop one validator / verify head advances -> stop another -> pending
-> restore both validators -> recover. Uses a separate disposable contract.
"""
import json,sys,time,uuid
from pathlib import Path
from deploy_chain import deploy
from chain_backend import EvmBackend
from chain_ledger import ChainLedger
from ledger import Problem

root=Path(sys.argv[2]);root.mkdir(exist_ok=True,parents=True)
action=sys.argv[1]
if action=='init':
    deploy('http://validator1:8545',root/'keys')
    profiles=[{'playerId':str(uuid.uuid4()),'name':'Quorum fixture '+str(i),'role':'user'} for i in range(2)]
    (root/'profiles.json').write_text(json.dumps(profiles))
backend=EvmBackend(root/'keys/chain.json',root/'keys/operator.key')
ledger=ChainLedger(root/'ledger.sqlite',backend)
profiles=json.loads((root/'profiles.json').read_text())
key='quorum-transfer-once'
payload={'asset':'KARMA','to':profiles[1]['playerId'],'amount':100}
if action=='init':
    admin=dict(playerId=str(uuid.uuid4()),name='Quorum budget',role='admin')
    ledger.ensure(admin)
    ledger.treasury_fund(admin['playerId'],str(uuid.uuid4()),dict(amount=10000,reason='Isolated fixture budget'))
    for profile in profiles:ledger.ensure(profile)
    print(json.dumps({'ready':True,'block':backend.head()['number']}))
elif action=='one-down':
    before=backend.head()['number'];after=before;deadline=time.monotonic()+25
    while after==before and time.monotonic()<deadline:
        time.sleep(.5);after=backend.web3.eth.block_number
    assert after>before
    print(json.dumps({'oneValidatorOffline':'blocks continue','before':before,'after':after}))
elif action=='pending':
    try:ledger.transfer(profiles[0]['playerId'],key,payload)
    except Problem as error:assert error.code=='CHAIN_PENDING',error.code
    else:raise AssertionError('A transaction confirmed without quorum')
    with ledger.connect() as db:assert ledger.balance(db,profiles[0]['playerId'])==300
    assert ledger.pending.exists()
    print(json.dumps({'twoValidatorsOffline':'no false success or SQL debit','pending':True}))
elif action=='recover':
    ledger.transfer(profiles[0]['playerId'],key,payload)
    ledger.transfer(profiles[0]['playerId'],key,payload)
    assert ledger.wallet(profiles[0]['playerId'])['balances'][0]['available']==200
    assert ledger.audit()['ok']
    print(json.dumps({'quorumRestored':'exactly one transfer confirmed','sender':200,'recipient':400}))
