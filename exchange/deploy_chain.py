"""One-time contract deployment / legacy migration, with crash-safe tx reuse."""
import argparse
import json
import os
from pathlib import Path
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware
from web3.exceptions import TransactionNotFound
from chain_backend import EvmBackend, artifact
from chain_ledger import ChainLedger, durable_json
from ledger import require


def secret(path, web3):
    if not path.exists():
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as out:
            out.write(Web3.to_hex(web3.eth.account.create().key)+'\n'); out.flush(); os.fsync(out.fileno())
    return web3.eth.account.from_key(path.read_text().strip())


def deploy(rpc, directory):
    directory=Path(directory); directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    config_path=directory/'chain.json'
    if config_path.exists():
        backend=EvmBackend(config_path,directory/'operator.key')
        return {'alreadyDeployed':True,'settlement':backend.hub.address}
    web3=Web3(Web3.HTTPProvider(rpc,request_kwargs={'timeout':5}))
    web3.middleware_onion.inject(ExtraDataToPOAMiddleware,layer=0)
    owner=secret(directory/'owner.key',web3)
    operator=secret(directory/'operator.key',web3)
    pending=directory/'deployment-pending.json'
    if pending.exists():
        saved=json.loads(pending.read_text())
    else:
        contract=web3.eth.contract(abi=artifact('KarmaSettlement')['abi'],bytecode=artifact('KarmaSettlement')['bytecode'])
        tx=contract.constructor(owner.address,operator.address).build_transaction({'from':owner.address,'chainId':web3.eth.chain_id,
            'nonce':web3.eth.get_transaction_count(owner.address,'pending'),'gas':8000000,'gasPrice':0})
        signed=owner.sign_transaction(tx)
        saved={'raw':Web3.to_hex(signed.raw_transaction),'hash':Web3.to_hex(signed.hash)}
        durable_json(pending,saved)
    try: receipt=web3.eth.get_transaction_receipt(saved['hash'])
    except TransactionNotFound:
        try: web3.eth.send_raw_transaction(bytes.fromhex(saved['raw'][2:]))
        except Exception: pass
        receipt=web3.eth.wait_for_transaction_receipt(saved['hash'],timeout=45,poll_latency=.25)
    require(receipt['status']==1 and receipt['contractAddress'],'Contract deployment reverted')
    config={'rpcUrl':rpc,'chainId':web3.eth.chain_id,'settlement':receipt['contractAddress'],
        'genesisHash':Web3.to_hex(web3.eth.get_block(0)['hash']),
        'codeHash':Web3.to_hex(Web3.keccak(web3.eth.get_code(receipt['contractAddress']))),
        'deploymentHash':saved['hash'],'owner':owner.address,'operator':operator.address}
    durable_json(config_path,config)
    return {k:v for k,v in config.items() if k!='rpcUrl'}


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('action',choices=['deploy','migrate','audit'])
    parser.add_argument('--directory',required=True)
    parser.add_argument('--rpc',default='http://validator1:8545')
    parser.add_argument('--database')
    parser.add_argument('--key-file')
    args=parser.parse_args()
    if args.action=='deploy': result=deploy(args.rpc,args.directory)
    else:
        directory=Path(args.directory)
        ledger=ChainLedger(args.database,EvmBackend(directory/'chain.json',Path(args.key_file) if args.key_file else directory/'operator.key'))
        if args.action=='migrate':
            backup=Path(args.database).with_name('before-blockchain-'+str(ledger.now())+'.sqlite')
            import sqlite3
            with ledger.connect() as source,sqlite3.connect(backup) as target: source.backup(target)
            result=ledger.migrate(); result['backup']=str(backup)
        else: result=ledger.audit(); result.pop('journal',None)
    print(json.dumps(result,ensure_ascii=False))


if __name__=='__main__': main()
