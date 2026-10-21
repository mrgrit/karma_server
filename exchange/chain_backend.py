"""Signed EVM settlement. Private keys stay in mounted secret files, never HTTP."""
import hashlib
import json
import time
from pathlib import Path
from web3 import Web3
from web3.middleware import ExtraDataToPOAMiddleware
from web3.exceptions import TransactionNotFound
from ledger import Problem, require

ROOT = Path(__file__).parent
ZERO = '0x'+'0'*40


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def owner_address(owner):
    # These are custodian account identifiers, not externally signable wallets.
    if owner == '@mint':
        return ZERO
    return Web3.to_checksum_address(hashlib.sha256(('karma-custody-v1:'+owner).encode()).digest()[-20:])


def asset_id(symbol):
    return Web3.keccak(text=symbol)


def artifact(name):
    return json.loads((ROOT/'chain'/'artifacts'/(name+'.json')).read_text())


class EvmBackend:
    def __init__(self, config_file, key_file):
        self.config = json.loads(Path(config_file).read_text())
        self.web3 = Web3(Web3.HTTPProvider(self.config['rpcUrl'], request_kwargs={'timeout': 3}))
        self.web3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)
        self.account = self.web3.eth.account.from_key(Path(key_file).read_text().strip())
        self.hub = self.web3.eth.contract(address=Web3.to_checksum_address(self.config['settlement']), abi=artifact('KarmaSettlement')['abi'])
        self.token_abi = artifact('DepartmentToken')['abi']
        self._tokens = {}
        self.verify_network()

    def verify_network(self):
        require(self.web3.eth.chain_id == self.config['chainId'], '블록체인 네트워크가 다릅니다.', 'CHAIN_IDENTITY', 503)
        require(Web3.to_hex(self.web3.eth.get_block(0)['hash']) == self.config['genesisHash'], '블록체인 초기 블록이 다릅니다.', 'CHAIN_IDENTITY', 503)
        code_hash = Web3.to_hex(Web3.keccak(self.web3.eth.get_code(self.hub.address)))
        require(code_hash == self.config['codeHash'], '정산 계약 코드가 다릅니다.', 'CHAIN_IDENTITY', 503)
        require(self.hub.functions.operator().call() == self.account.address, '블록체인 정산 서명자를 확인하세요.', 'CHAIN_OPERATOR', 503)

    def head(self):
        block = self.web3.eth.get_block('latest')
        require(time.time()-block['timestamp'] < 20, '블록 생성이 지연되어 코인 처리를 중지했습니다.', 'CHAIN_UNAVAILABLE', 503)
        return block

    def token(self, symbol, block='latest'):
        address = self._tokens.get(symbol)
        if not address:
            address = self.hub.functions.tokens(asset_id(symbol)).call(block_identifier=block)
            if address == ZERO:
                return None
            self._tokens[symbol] = address
        return self.web3.eth.contract(address=address, abi=self.token_abi)

    def prepare(self, batch, sequence, assets, moves, audit_digest):
        self.head()
        require(self.hub.functions.sequence().call() == sequence, '블록체인 정산 순서가 일치하지 않습니다.', 'CHAIN_DIVERGENCE', 503)
        registrations = []
        for a in assets:
            if self.token(a['symbol']) is None:
                registrations.append((a['symbol'], a['name'], a['decimals'], 10**18 if a['symbol']=='KARMA' else a['supply']))
        transfers = [(asset_id(m['asset']), owner_address(m['source']), owner_address(m['destination']), m['amount']) for m in moves]
        require(len(transfers) <= 1024, '한 번에 처리할 거래가 많습니다. 수량을 나눠 주세요.', 'CHAIN_BATCH_SIZE', 409)
        fn = self.hub.functions.settle(bytes.fromhex(batch), sequence, registrations, transfers, bytes.fromhex(audit_digest))
        try:
            gas = fn.estimate_gas({'from': self.account.address, 'gasPrice': 0})
        except Exception:
            raise Problem('블록체인이 잔액·발행량 또는 정산 요청을 거절했습니다.', 'CHAIN_REJECTED', 409) from None
        require(gas <= 50000000, '거래 수량을 나눠 주세요.', 'CHAIN_BATCH_SIZE', 409)
        tx = fn.build_transaction({'from':self.account.address, 'chainId':self.config['chainId'], 'nonce':self.web3.eth.get_transaction_count(self.account.address, 'pending'), 'gas':int(gas*1.15)+50000, 'gasPrice':0})
        signed = self.account.sign_transaction(tx)
        return {'raw':Web3.to_hex(signed.raw_transaction), 'hash':Web3.to_hex(signed.hash), 'sequence':sequence+1, 'batch':batch}

    def resolve(self, signed, timeout=12):
        tx_hash=signed['hash']
        try:
            receipt=self.web3.eth.get_transaction_receipt(tx_hash)
        except TransactionNotFound:
            try:
                self.web3.eth.send_raw_transaction(bytes.fromhex(signed['raw'][2:]))
            except Exception:
                # The RPC response can be lost after submission. Reconcile the exact
                # signed transaction instead of creating another transfer or nonce.
                pass
            end=time.monotonic()+timeout
            while True:
                try:
                    receipt=self.web3.eth.get_transaction_receipt(tx_hash)
                    break
                except TransactionNotFound:
                    if time.monotonic() >= end:
                        raise Problem('블록체인 확정을 기다리고 있습니다. 같은 요청으로 다시 확인하세요.', 'CHAIN_PENDING', 503) from None
                    time.sleep(.2)
        require(receipt['status']==1, '블록체인 거래가 취소됐습니다. 잔액은 차감되지 않았습니다.', 'CHAIN_REVERTED', 409)
        block=self.web3.eth.get_block(receipt['blockNumber'])
        require(block['hash']==receipt['blockHash'], '블록체인 확정 블록이 일치하지 않습니다.', 'CHAIN_DIVERGENCE', 503)
        require(self.hub.functions.batchBlocks(bytes.fromhex(signed['batch'])).call()==receipt['blockNumber'], '블록체인 정산 증명을 찾지 못했습니다.', 'CHAIN_DIVERGENCE', 503)
        return {'transactionHash':tx_hash,'blockNumber':receipt['blockNumber'],'blockHash':Web3.to_hex(receipt['blockHash']),'sequence':signed['sequence']}

    def balances(self, entries, block=None):
        if block is None:
            block=self.head()['number']
        result={}
        for owner, symbol in entries:
            token=self.token(symbol,block)
            require(token is not None, '블록체인 코인을 찾을 수 없습니다.', 'CHAIN_DIVERGENCE', 503)
            result[(owner,symbol)]=token.functions.balanceOf(owner_address(owner)).call(block_identifier=block)
        return result

    def summary(self):
        block=self.head()
        validators=self.web3.provider.make_request('qbft_getValidatorsByBlockNumber',['latest'])
        require('result' in validators, '검증 노드 정보를 확인하지 못했습니다.', 'CHAIN_UNAVAILABLE', 503)
        treasury=self.balances([('@treasury','KARMA')],block['number'])[('@treasury','KARMA')]
        karma=self.token('KARMA',block['number'])
        return {'network':'KARMA Department Chain','consensus':'QBFT','chainId':self.config['chainId'],
            'blockNumber':block['number'],'blockHash':Web3.to_hex(block['hash']), 'blockTimestamp':block['timestamp'],
            'validators':len(validators['result']),'settlement':self.hub.address,'karmaToken':karma.address,
            'treasuryAddress':owner_address('@treasury'),'treasury':treasury,'custody':'학과 서버 관리 지갑',
            'gasPrice':0,'physicalHosts':1,'sequence':self.hub.functions.sequence().call(block_identifier=block['number'])}

    def receipt(self, tx_hash):
        receipt=self.web3.eth.get_transaction_receipt(tx_hash)
        transfers=[]
        for item in receipt['logs']:
            if len(item['topics'])==3 and item['topics'][0]==Web3.keccak(text='Transfer(address,address,uint256)'):
                transfers.append({'token':item['address'],'from':Web3.to_checksum_address(item['topics'][1][-20:]),
                    'to':Web3.to_checksum_address(item['topics'][2][-20:]),'amount':int.from_bytes(item['data'],'big')})
        return {'transactionHash':Web3.to_hex(receipt['transactionHash']),'blockNumber':receipt['blockNumber'],
            'blockHash':Web3.to_hex(receipt['blockHash']),'status':'confirmed' if receipt['status']==1 else 'reverted',
            'gasUsed':receipt['gasUsed'],'transfers':transfers}
