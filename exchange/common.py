import re
import uuid

COIN = 'KARMA'
WELCOME_GRANT = 10000  # 100 KARMA, paid once from the communal treasury.
FEE = 100  # 100 minor units = one department coin.
MAX_AMOUNT = 10**12


class Problem(Exception):
    def __init__(self, message, code='BAD_REQUEST', status=400):
        super().__init__(message)
        self.code, self.status = code, status


def require(condition, message, code='BAD_REQUEST', status=400):
    if not condition:
        raise Problem(message, code, status)


def integer(value, low=1, high=MAX_AMOUNT):
    require(type(value) is int and low <= value <= high, '수량과 가격 범위를 확인하세요.')
    return value


def user_id(value):
    require(isinstance(value, str) and re.fullmatch(r'[a-f0-9-]{36}', value), '사용자 ID가 올바르지 않습니다.')
    try:
        valid = str(uuid.UUID(value)) == value
    except ValueError:
        valid = False
    require(valid, '사용자 ID가 올바르지 않습니다.')
    return value


def clean_text(value, length):
    require(isinstance(value, str) and 1 <= len(value.strip()) <= length and not any(ord(c) < 32 for c in value), '이름 또는 지급 사유를 확인하세요.')
    return value.strip()

