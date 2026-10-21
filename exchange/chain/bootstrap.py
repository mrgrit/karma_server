"""Create a new four-validator Besu network; never overwrite existing chain state."""
import json, os, shutil, subprocess, sys
from pathlib import Path

IMAGE = 'hyperledger/besu:26.10.0@sha256:7ce78163f9de6733bb868c8bd2ebb4e6e90cc7cb950034ff8c333b1a0c27aace'
root = Path(sys.argv[1]).resolve()
if root.exists():
    raise SystemExit('Refusing to overwrite an existing network: '+str(root))
root.mkdir(mode=0o700, parents=True)
config = {'genesis': {'config': {'chainId': 2902026, 'berlinBlock': 0, 'londonBlock': 0, 'zeroBaseFee': True,
    'qbft': {'blockperiodseconds': 1, 'epochlength': 30000, 'requesttimeoutseconds': 4, 'pertxgaslimit': 0}},
    'nonce': '0x0', 'timestamp': '0x0', 'gasLimit': '0x3938700', 'difficulty': '0x1', 'mixHash': '0x63746963616c2d627974652d776974682d726573706563742d746f2d7468652d',
    'coinbase': '0x0000000000000000000000000000000000000000', 'alloc': {}}, 'blockchain': {'nodes': {'generate': True, 'count': 4}}}
(root/'config.json').write_text(json.dumps(config))
subprocess.run(['docker','run','--rm','--user','0:0','-v',str(root)+':/work',IMAGE,'operator','generate-blockchain-config',
    '--config-file=/work/config.json','--to=/work/generated','--private-key-file-name=key'], check=True, stdout=subprocess.DEVNULL)
shutil.copy2(root/'generated/genesis.json', root/'genesis.json')
keys=sorted((root/'generated/keys').iterdir())
assert len(keys)==4
enodes=[]
for i,source in enumerate(keys,1):
    folder=root/f'validator{i}'; folder.mkdir(mode=0o700)
    for name in ('key','key.pub'):
        shutil.copy2(source/name,folder/name); os.chmod(folder/name,0o600)
    public=(folder/'key.pub').read_text().strip().removeprefix('0x')
    enodes.append(f'enode://{public}@172.30.29.{10+i}:30303')
for i in range(1,5):
    folder=root/f'validator{i}'
    (folder/'static-nodes.json').write_text(json.dumps([e for j,e in enumerate(enodes,1) if j!=i]))
    for p in [folder,*folder.iterdir()]: os.chown(p,1000,1000)
lines=['name: karma-chain','services:']
for i in range(1,5):
    lines += [f'  validator{i}:',f'    image: {IMAGE}','    restart: unless-stopped','    user: "1000:1000"','    mem_limit: 1536m','    cpus: 0.75',
        '    environment:', '      JAVA_OPTS: "-Xms256m -Xmx768m"', '    volumes:', f'      - ./validator{i}:/data', '      - ./genesis.json:/config/genesis.json:ro',
        '    command:', '      - --data-path=/data','      - --genesis-file=/config/genesis.json','      - --sync-mode=FULL','      - --data-storage-format=FOREST',
        '      - --discovery-enabled=false','      - --p2p-host=172.30.29.'+str(10+i),'      - --min-gas-price=0','      - --tx-pool-enable-balance-check=false',
        '      - --rpc-http-enabled=true','      - --rpc-http-host=0.0.0.0','      - --rpc-http-api=ETH,NET,WEB3,QBFT','      - --host-allowlist=*',
        '      - --logging=INFO', '    networks:', '      chain:', f'        ipv4_address: 172.30.29.{10+i}']
lines += ['networks:', '  chain:', '    name: karma-chain', '    internal: true', '    ipam:', '      config:', '        - subnet: 172.30.29.0/24']
(root/'compose.yaml').write_text('\n'.join(lines)+'\n')
print(json.dumps({'root':str(root),'chainId':2902026,'validators':4,'image':IMAGE}))
