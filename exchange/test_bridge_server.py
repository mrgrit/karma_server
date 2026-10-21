"""Isolated TLS integration fixture. Never deploy its certificate or key."""
import sys,ssl,threading,json
from pathlib import Path
from app import Exchange,serve
from ledger import Ledger
root=Path(__file__).parent
app=Exchange(Ledger(Path(sys.argv[1])/'ledger.sqlite'),'https://unused.invalid','https://localhost','test-only-service-key-'+'a'*48)
server=serve(app,'127.0.0.1',0)
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(root/'test-fixtures/localhost.pem',root/'test-fixtures/localhost.key')
server.socket=context.wrap_socket(server.socket,server_side=True)
threading.Thread(target=server.serve_forever,daemon=True).start()
print(json.dumps({'port':server.server_port}),flush=True)
try:sys.stdin.read()
finally:server.shutdown();server.server_close()
