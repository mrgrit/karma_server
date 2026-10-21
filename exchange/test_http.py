import http.client
import tempfile
import threading
import unittest
import uuid
import json
from pathlib import Path
from app import Exchange, serve
from ledger import Ledger, Problem


class HttpTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.profile=dict(playerId=str(uuid.uuid4()),name='Test Student',role='user')
        self.ex=Exchange(Ledger(Path(self.temp.name)/'test.sqlite'),'https://account.invalid','https://exchange.test.internal','a'*48)
        self.disabled=False
        def upstream(path,token=None,body=None):
            if self.disabled:raise Problem('사용 중지된 계정','ACCOUNT_DISABLED',403)
            if path=='/auth/register/request':return {'ok':True,'approvalRequired':True,'requiresVerification':False}
            if path=='/auth/login':
                if body.get('password')!='test-password':raise Problem('로그인 실패','LOGIN_FAILED',401)
                return {'profile':self.profile,'authToken':'test-token','expiresAt':9999999999999}
            if path=='/api/me?wallet=0' and token=='test-token':return {'profile':self.profile}
            raise Problem('인증 실패','AUTH_REQUIRED',401)
        self.ex.account_api=upstream
        self.server=serve(self.ex,'127.0.0.1',0)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.cookie=''

    def tearDown(self):
        self.server.shutdown();self.server.server_close();self.thread.join();self.temp.cleanup()

    def call(self,path,body=None,origin=True,headers=None):
        h={'Content-Type':'application/json',**(headers or {})}
        if origin:h['Origin']=self.ex.origin
        if self.cookie:h['Cookie']=self.cookie
        client=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=5)
        client.request('GET' if body is None else 'POST',path,None if body is None else json.dumps(body),h)
        response=client.getresponse();raw=response.read();status=response.status;reply_headers=dict(response.getheaders());client.close()
        return status,json.loads(raw),reply_headers

    def login(self):
        if not self.ex.ledger.users():
            admin=dict(playerId=str(uuid.uuid4()),name='Budget admin',role='admin')
            self.ex.ledger.ensure(admin)
            self.ex.ledger.treasury_fund(admin['playerId'],str(uuid.uuid4()),dict(amount=10000,reason='Test budget'))
        status,data,h=self.call('/api/login',dict(email='student@test.invalid',password='test-password'))
        self.assertEqual(status,200);self.cookie=h['Set-Cookie'].split(';',1)[0]
        self.assertIn('HttpOnly',h['Set-Cookie']);self.assertIn('SameSite=Strict',h['Set-Cookie'])

    def test_auth_csrf_service_boundary_and_revocation(self):
        self.assertEqual(self.call('/api/state')[0],401)
        self.assertEqual(self.call('/api/login',{},origin=False)[0],403)
        self.login();self.assertEqual(self.call('/api/state')[1]['wallet']['balances'][0]['available'],300)
        self.assertEqual(self.call('/api/admin/audit')[0],403)
        self.assertEqual(self.call('/service/wallet',{'profile':self.profile})[0],401)
        self.assertEqual(self.call('/api/issue',{'symbol':'LAB','name':'Lab','supply':10},origin=False)[0],403)
        self.disabled=True;self.assertEqual(self.call('/api/state')[0],403)

    def test_duplicate_issue_and_safe_state(self):
        self.login();h={'Idempotency-Key':str(uuid.uuid4())};payload={'symbol':'LAB','name':'<script>test</script>','supply':10}
        first=self.call('/api/issue',payload,headers=h);self.assertEqual(first[0],200)
        self.assertEqual(first[1],self.call('/api/issue',payload,headers=h)[1])
        status,data,_=self.call('/api/state');self.assertEqual(status,200)
        self.assertEqual(len(data['market']['assets']),2)
        self.assertNotIn('authToken',json.dumps(data));self.assertNotIn('email',data['profile'])
        self.assertEqual(self.call('/api/logout',{})[0],200);self.assertEqual(self.call('/api/state')[0],401)

    def test_pending_signup_has_no_session_or_wallet(self):
        status,data,headers=self.call('/api/register',dict(email='new@test.invalid',password='test-password',name='New'))
        self.assertEqual(status,200);self.assertTrue(data['approvalRequired'])
        self.assertNotIn('Set-Cookie',headers);self.assertEqual(self.ex.sessions,{})
        self.assertEqual(self.ex.ledger.users(),[])
        self.assertEqual(self.call('/api/state')[0],401)

    def test_community_auth_roles_and_escrow(self):
        for url in ['/api/community','/api/economy']:
            self.assertEqual(self.call(url)[0],401)
        self.login()
        self.assertEqual(self.call('/api/community')[0],200)
        self.assertEqual(self.call('/api/economy')[1]['spendable'],9700)
        h={'Idempotency-Key':str(uuid.uuid4())}
        self.assertEqual(self.call('/api/treasury/fund',dict(amount=100,reason='Test'),headers=h)[0],403)
        self.assertEqual(self.call('/api/mission',dict(action='create'),headers={'Idempotency-Key':str(uuid.uuid4())})[0],403)
        payload=dict(action='create',title='Code review',description='Review your code',price=100,days=1)
        first=self.call('/api/service',payload,headers=h)
        self.assertEqual(first[0],200);self.assertEqual(first[1],self.call('/api/service',payload,headers=h)[1])
        self.assertEqual(len(self.call('/api/community')[1]['services']),1)
        self.disabled=True;self.assertEqual(self.call('/api/community')[0],403)


if __name__=='__main__':unittest.main()
