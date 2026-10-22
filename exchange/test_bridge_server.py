"""Isolated TLS integration fixture. Never deploy its certificate or key."""
import sys,ssl,threading,json,uuid
from pathlib import Path
from app import Exchange,serve
from ledger import Ledger
from test_support import existing_student
root=Path(__file__).parent
app=Exchange(Ledger(Path(sys.argv[1])/'ledger.sqlite'),'https://unused.invalid','https://localhost','test-only-service-key-'+'a'*48)
admin=dict(playerId=str(uuid.uuid4()),name='Fixture budget',role='admin')
app.ledger.ensure(admin)
app.ledger.treasury_fund(admin['playerId'],str(uuid.uuid4()),dict(amount=10000,reason='Fixture budget'))
players=[dict(playerId=str(uuid.uuid4()),name='Fixture '+str(i),role='user') for i in range(2)]
for p in players:existing_student(app.ledger,p)
server=serve(app,'127.0.0.1',0)
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(root/'test-fixtures/localhost.pem',root/'test-fixtures/localhost.key')
server.socket=context.wrap_socket(server.socket,server_side=True)
threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'port':server.server_port,'players':players}),flush=True)
try:sys.stdin.read()
finally:server.shutdown();server.server_close()
