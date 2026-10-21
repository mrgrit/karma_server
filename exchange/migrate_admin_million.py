"""Explicit, once-only administrator funding increase; preserves the journal."""
import argparse
import json
import sqlite3
import uuid
from pathlib import Path
from ledger import Ledger, COIN, require, user_id

TARGET = 100_000_000  # 1,000,000 KARMA, in minor units.


def fund_admin(ledger, administrator):
    uid = user_id(administrator)
    def apply(db, tx):
        row = db.execute('SELECT role FROM users WHERE id=?', (uid,)).fetchone()
        require(row and row['role'] == 'admin', '관리자 계정만 증액할 수 있습니다.', 'ADMIN_REQUIRED', 403)
        before = ledger.balance(db, uid)
        addition = max(0, TARGET - before)
        if addition:
            ledger.move(db, tx, COIN, '@mint', uid, addition, '관리자 운영 코인 1,000,000 KARMA로 증액', uid)
        return {'ok': True, 'transactionId': tx, 'before': before, 'added': addition, 'after': before + addition}
    return ledger.perform(uid, 'admin-funding-million-v1', 'admin-funding-increase', {'target': TARGET}, apply)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database')
    parser.add_argument('administrator', help='Existing administrator player UUID')
    args = parser.parse_args()
    ledger = Ledger(args.database)
    ledger.audit()
    backup = Path(args.database).parent / 'backups' / ('before-admin-million-' + str(uuid.uuid4()) + '.sqlite')
    backup.parent.mkdir(exist_ok=True)
    with ledger.connect() as source, sqlite3.connect(backup) as destination:
        source.backup(destination)
    result = fund_admin(ledger, args.administrator)
    audit = ledger.audit()
    print(json.dumps({**result, 'backup': str(backup), 'audit': {'ok': audit['ok'], 'supplies': audit['supplies']}}, ensure_ascii=False))
