import hashlib
import hmac
import json
import os
import secrets
import ssl
import threading
import time
import urllib.error
import urllib.request
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from ledger import Ledger, Problem, require

ROOT = Path(__file__).resolve().parent


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise Problem('계정 서버 주소가 변경됐습니다. 관리자에게 문의하세요.', 'AUTH_UPSTREAM', 503)


class Exchange:
    def __init__(self, ledger, auth_url, origin, service_key, ca=None):
        self.ledger, self.auth_url, self.origin, self.key = ledger, auth_url.rstrip('/'), origin.rstrip('/'), service_key
        require(len(service_key) >= 40, '서비스 키를 설정해야 합니다.')
        require(auth_url.startswith('https://'), '계정 서버는 HTTPS가 필요합니다.')
        self.http = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=ca)))
        self.sessions, self.limits, self.lock = {}, {}, threading.Lock()

    def account_api(self, path, token=None, body=None):
        headers = {'Accept': 'application/json'}
        if token:
            headers['Authorization'] = 'Bearer '+token
        if body is not None:
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(self.auth_url+path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
        try:
            with self.http.open(request, timeout=8) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            try:
                value = json.load(error).get('error', {})
            except Exception:
                value = {}
            raise Problem(value.get('message', '계정 인증을 확인하세요.'), value.get('code', 'AUTH_ERROR'), error.code) from None
        except (OSError, urllib.error.URLError, TimeoutError):
            raise Problem('카르마 계정 서버에 연결하지 못했습니다.', 'AUTH_UNAVAILABLE', 503) from None

    def rate(self, ip, action):
        with self.lock:
            now = time.monotonic()
            key = (ip, action)
            recent = [at for at in self.limits.get(key, []) if at > now-60]
            require(len(recent) < (10 if action == 'login' else 120), '요청이 많습니다. 잠시 후 다시 시도하세요.', 'RATE_LIMIT', 429)
            self.limits[key] = recent+[now]
            if len(self.limits) > 10000:
                self.limits = {k: v for k, v in self.limits.items() if v[-1] > now-60}

    def session(self, cookie):
        try:
            sid = SimpleCookie(cookie or '').get('__Host-karma-exchange')
            hashed = hashlib.sha256(sid.value.encode()).hexdigest() if sid else ''
        except Exception:
            hashed = ''
        with self.lock:
            session = self.sessions.get(hashed)
        require(session and session['expires'] > time.time(), '카르마 계정으로 로그인하세요.', 'AUTH_REQUIRED', 401)
        # Revalidate at the account server: disable/logout takes effect on the next request.
        profile = self.account_api('/api/me?wallet=0', token=session['token'])['profile']
        self.ledger.ensure(profile)
        return hashed, session, profile

    def login(self, body, register=False):
        path = '/auth/register/request' if register else '/auth/login'
        result = self.account_api(path, body={k: body.get(k) for k in (['email', 'password', 'name'] if register else ['email', 'password'])})
        require(not result.get('requiresVerification'), '현재 가입은 카르마 클라이언트에서 인증을 완료해 주세요.')
        if result.get('approvalRequired'):
            return None
        self.ledger.ensure(result['profile'])
        sid = secrets.token_urlsafe(32)
        with self.lock:
            now = time.time()
            self.sessions = {k: s for k, s in self.sessions.items() if s['expires'] > now}
            self.sessions[hashlib.sha256(sid.encode()).hexdigest()] = {'token': result['authToken'], 'expires': min(result['expiresAt']/1000, now+43200)}
        return sid

    def handle(self, handler):
        route = handler.path.split('?', 1)[0]
        method = handler.command
        if method == 'GET' and route == '/health':
            return 200, {'ok': True, 'service': 'karma-exchange', 'version': 1}, {}
        if method == 'GET' and route in ['/', '/app.js', '/style.css']:
            name = 'index.html' if route == '/' else route[1:]
            kind = {'index.html': 'text/html', 'app.js': 'text/javascript', 'style.css': 'text/css'}[name]
            return 200, (ROOT/'public'/name).read_bytes(), {'Content-Type': kind+'; charset=utf-8'}
        if route.startswith('/service/'):
            require(method == 'POST' and hmac.compare_digest(handler.headers.get('Authorization', ''), 'Bearer '+self.key), '서비스 인증이 필요합니다.', 'SERVICE_AUTH', 401)
            body = handler.body()
            if route == '/service/wallet':
                return 200, self.ledger.ensure(body['profile']), {}
            if route in ['/service/reserve', '/service/commit', '/service/refund']:
                return 200, self.ledger.game(route.rsplit('/', 1)[1], body), {}
            raise Problem('서비스 경로를 찾을 수 없습니다.', 'NOT_FOUND', 404)
        require(route.startswith('/api/'), '페이지를 찾을 수 없습니다.', 'NOT_FOUND', 404)
        # KT88 replaces inbound X-Forwarded-For with the observed origin address.
        ip = handler.headers.get('X-Forwarded-For', handler.client_address[0]).split(',')[0].strip()
        self.rate(ip, 'login' if route in ['/api/login', '/api/register'] else 'api')
        if method != 'GET':
            require(handler.headers.get('Origin') == self.origin, '다른 사이트에서 보낸 요청입니다.', 'CSRF', 403)
        if method == 'POST' and route in ['/api/login', '/api/register']:
            sid = self.login(handler.body(), route == '/api/register')
            if sid is None:
                return 200, {'ok': True, 'approvalRequired': True, 'message': '가입 신청이 접수되었습니다. 관리자 승인 후 로그인해 주세요.'}, {}
            return 200, {'ok': True}, {'Set-Cookie': '__Host-karma-exchange='+sid+'; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200'}
        hashed, session, profile = self.session(handler.headers.get('Cookie'))
        uid = profile['playerId']
        if method == 'POST' and route == '/api/logout':
            with self.lock:
                self.sessions.pop(hashed, None)
            return 200, {'ok': True}, {'Set-Cookie': '__Host-karma-exchange=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0'}
        if method == 'GET' and route == '/api/state':
            market = self.ledger.market(uid)
            # Show ownership only for the current user's orders.
            for order in market['orders']:
                order['mine'] = order.pop('owner') == uid
            return 200, {'profile': {k: profile.get(k) for k in ['playerId', 'name', 'role', 'rank', 'xp']}, 'wallet': self.ledger.wallet(uid), 'market': market, 'users': self.ledger.users()}, {}
        if method == 'GET' and route == '/api/admin/audit':
            require(profile.get('role') == 'admin', '관리자 권한이 필요합니다.', 'ADMIN_REQUIRED', 403)
            return 200, self.ledger.audit(), {}
        if method == 'POST':
            body = handler.body()
            key = handler.headers.get('Idempotency-Key')
            actions = {'/api/transfer': self.ledger.transfer, '/api/issue': self.ledger.issue, '/api/order': self.ledger.order, '/api/cancel': self.ledger.cancel, '/api/reward': self.ledger.reward}
            if route in actions:
                return 200, actions[route](uid, key, body), {}
        raise Problem('요청 경로를 찾을 수 없습니다.', 'NOT_FOUND', 404)


def serve(app, host='0.0.0.0', port=8080):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, *args):
            pass  # Never log passwords, authorization headers or request bodies.

        def body(self):
            require(self.headers.get('Content-Type', '').split(';')[0] == 'application/json', 'JSON 요청이 필요합니다.', status=415)
            length = int(self.headers.get('Content-Length', 0))
            require(0 < length <= 32768, '요청 크기를 확인하세요.', status=413)
            self.connection.settimeout(10)
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeError):
                raise Problem('JSON 요청을 확인하세요.') from None
            require(isinstance(body, dict), 'JSON 객체가 필요합니다.')
            return body

        def do_GET(self):
            try:
                status, value, extra = app.handle(self)
            except Problem as error:
                status, value, extra = error.status, {'error': {'code': error.code, 'message': str(error)}}, {}
            except Exception as error:
                print(json.dumps({'event': 'request-failed', 'type': type(error).__name__}), flush=True)
                status, value, extra = 500, {'error': {'code': 'INTERNAL_ERROR', 'message': '요청을 처리하지 못했습니다.'}}, {}
            encoded = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
            self.send_response(status)
            headers = {'Content-Type': 'application/json; charset=utf-8', 'Content-Length': str(len(encoded)), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'", **extra}
            for key, val in headers.items():
                self.send_header(key, val)
            self.send_header('Connection', 'close')
            self.end_headers()
            self.wfile.write(encoded)
            # Do not reuse a connection with an unread/rejected POST body.
            self.close_connection = True

        do_POST = do_GET

    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    return server


if __name__ == '__main__':
    secret_file = Path(os.environ['SERVICE_KEY_FILE'])
    app = Exchange(Ledger(os.environ.get('LEDGER_FILE', '/data/exchange.sqlite')), os.environ['KARMA_AUTH_URL'], os.environ['PUBLIC_ORIGIN'], secret_file.read_text().strip(), os.environ['KARMA_CA_FILE'])
    server = serve(app)
    print(json.dumps({'event': 'exchange-started', 'port': 8080}), flush=True)
    server.serve_forever()
