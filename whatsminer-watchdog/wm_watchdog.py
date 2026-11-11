#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
wm_watchdog.py — сторож для асиков Whatsminer (MicroBT).

Раз в минуту опрашивает асики по их родному API. Если асик перестал хешировать
(типичный случай — отвал по питанию/напряжению, ошибки 2xx), сам перезагружает
его через API, пишет в Telegram и ведёт журнал инцидентов, по которому потом
видно, какой асик, когда и с какими кодами ошибок падает.

Без внешних зависимостей: нужен только Python 3.8+ (Linux / Windows / macOS /
Raspberry Pi). Поддерживается API v2 (порт 4028, большинство M2x/M3x/M5x) и
API v3 (порт 4433, M6x и новые прошивки) — версия определяется сама.

    python3 wm_watchdog.py run            # основной режим: следить и чинить
    python3 wm_watchdog.py status         # таблица по всем асикам
    python3 wm_watchdog.py check-auth     # проверить, что перезагрузка по API разрешена
    python3 wm_watchdog.py report         # статистика падений по журналу
    python3 wm_watchdog.py -h             # все команды
"""
from __future__ import annotations

import argparse
import base64
import configparser
import csv
import getpass
import hashlib
import html.parser
import http.cookiejar
import ipaddress
import json
import logging
import logging.handlers
import os
import queue
import re
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, deque
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Callable, Deque, Dict, List, Optional, Sequence, Tuple

__version__ = "1.2.0"

log = logging.getLogger("wm_watchdog")


# =============================================================================
#  Криптография для привилегированного API v2.
#  Реализована здесь же (md5-crypt + AES-256-ECB), чтобы не тащить зависимости.
#  Корректность проверяется тестами против passlib/cryptography/openssl.
# =============================================================================

_ITOA64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"


def md5_crypt(password: str, salt: str) -> str:
    """Классический md5-crypt ($1$), как `openssl passwd -1`. Возвращает '$1$<salt>$<hash>'."""
    pw = password.encode("utf-8")
    salt_b = salt.encode("ascii")[:8]
    alt = hashlib.md5(pw + salt_b + pw).digest()
    ctx = hashlib.md5(pw + b"$1$" + salt_b)
    n = len(pw)
    while n > 0:
        ctx.update(alt[: min(16, n)])
        n -= 16
    i = len(pw)
    while i:
        ctx.update(b"\x00" if i & 1 else pw[:1])
        i >>= 1
    final = ctx.digest()
    for r in range(1000):
        c = hashlib.md5()
        c.update(pw if r & 1 else final)
        if r % 3:
            c.update(salt_b)
        if r % 7:
            c.update(pw)
        c.update(final if r & 1 else pw)
        final = c.digest()

    out: List[str] = []

    def to64(v: int, cnt: int) -> None:
        for _ in range(cnt):
            out.append(_ITOA64[v & 0x3F])
            v >>= 6

    for a, b, c3 in ((0, 6, 12), (1, 7, 13), (2, 8, 14), (3, 9, 15), (4, 10, 5)):
        to64((final[a] << 16) | (final[b] << 8) | final[c3], 4)
    to64(final[11], 2)
    return "$1$" + salt_b.decode("ascii") + "$" + "".join(out)


def _xtime(a: int) -> int:
    a <<= 1
    return a ^ 0x11B if a & 0x100 else a


def _gmul(a: int, b: int) -> int:
    p = 0
    while b:
        if b & 1:
            p ^= a
        a = _xtime(a)
        b >>= 1
    return p


def _make_sbox() -> List[int]:
    def rotl8(x: int, s: int) -> int:
        return ((x << s) | (x >> (8 - s))) & 0xFF

    sbox = [0] * 256
    p = q = 1
    while True:
        p ^= _xtime(p)  # p *= 3
        q ^= q << 1  # q /= 3
        q ^= q << 2
        q ^= q << 4
        q &= 0xFF
        if q & 0x80:
            q ^= 0x09
        sbox[p] = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63
        if p == 1:
            break
    sbox[0] = 0x63
    return sbox


_SBOX = _make_sbox()
_INV_SBOX = [0] * 256
for _i, _v in enumerate(_SBOX):
    _INV_SBOX[_v] = _i
_M9, _M11, _M13, _M14 = ([_gmul(x, k) for x in range(256)] for k in (9, 11, 13, 14))


class AES256ECB:
    """Минимальный AES-256 в режиме ECB (только то, что нужно для API Whatsminer)."""

    def __init__(self, key: bytes) -> None:
        if len(key) != 32:
            raise ValueError("AES-256 key must be 32 bytes")
        w = [list(key[i : i + 4]) for i in range(0, 32, 4)]
        rcon = 1
        for i in range(8, 60):
            t = list(w[i - 1])
            if i % 8 == 0:
                t = [_SBOX[b] for b in t[1:] + t[:1]]
                t[0] ^= rcon
                rcon = _xtime(rcon)
            elif i % 8 == 4:
                t = [_SBOX[b] for b in t]
            w.append([a ^ b for a, b in zip(w[i - 8], t)])
        self._rk = [sum(w[4 * r : 4 * r + 4], []) for r in range(15)]

    def _enc_block(self, blk: bytes) -> bytes:
        rk = self._rk
        s = [a ^ b for a, b in zip(blk, rk[0])]
        for rnd in range(1, 15):
            s = [_SBOX[b] for b in s]
            s = [s[r + 4 * ((c + r) % 4)] for c in range(4) for r in range(4)]
            if rnd != 14:
                m: List[int] = []
                for c in range(4):
                    a0, a1, a2, a3 = s[4 * c : 4 * c + 4]
                    t = a0 ^ a1 ^ a2 ^ a3
                    m += [
                        a0 ^ t ^ _xtime(a0 ^ a1),
                        a1 ^ t ^ _xtime(a1 ^ a2),
                        a2 ^ t ^ _xtime(a2 ^ a3),
                        a3 ^ t ^ _xtime(a3 ^ a0),
                    ]
                s = m
            s = [a ^ b for a, b in zip(s, rk[rnd])]
        return bytes(s)

    def _dec_block(self, blk: bytes) -> bytes:
        rk = self._rk
        s = [a ^ b for a, b in zip(blk, rk[14])]
        for rnd in range(13, -1, -1):
            s = [s[r + 4 * ((c - r) % 4)] for c in range(4) for r in range(4)]
            s = [_INV_SBOX[b] for b in s]
            s = [a ^ b for a, b in zip(s, rk[rnd])]
            if rnd != 0:
                m: List[int] = []
                for c in range(4):
                    a0, a1, a2, a3 = s[4 * c : 4 * c + 4]
                    m += [
                        _M14[a0] ^ _M11[a1] ^ _M13[a2] ^ _M9[a3],
                        _M9[a0] ^ _M14[a1] ^ _M11[a2] ^ _M13[a3],
                        _M13[a0] ^ _M9[a1] ^ _M14[a2] ^ _M11[a3],
                        _M11[a0] ^ _M13[a1] ^ _M9[a2] ^ _M14[a3],
                    ]
                s = m
        return bytes(s)

    def encrypt(self, data: bytes) -> bytes:
        if len(data) % 16:
            raise ValueError("data length must be a multiple of 16")
        return b"".join(self._enc_block(data[i : i + 16]) for i in range(0, len(data), 16))

    def decrypt(self, data: bytes) -> bytes:
        if len(data) % 16:
            raise ValueError("data length must be a multiple of 16")
        return b"".join(self._dec_block(data[i : i + 16]) for i in range(0, len(data), 16))


# =============================================================================
#  Коды ошибок Whatsminer (по таблице MicroBT). Питание расписано подробно —
#  это ровно наш случай; остальные группы — коротко.
# =============================================================================

_POWER_ERRORS = {
    200: "БП не найден (ошибка опроса блока питания)",
    201: "БП не соответствует конфигурации",
    202: "ошибка выходного напряжения БП",
    203: "защита БП: высокая температура окружающей среды",
    204: "защита БП по току: высокая температура окружающей среды",
    205: "ошибка тока БП (проверь сеть)",
    206: "низкое входное напряжение (сеть просела)",
    207: "защита БП по входному току: плохое питание на входе",
    208: "мощность БП сильно скачет",
    209: "напряжение БП отклонилось от заданного",
    210: "БП сообщает об ошибке",
    211: "слишком большое отклонение выходного тока БП",
    212: "не хватает запаса по выходному напряжению БП",
    213: "входные напряжение/ток не соответствуют выходной мощности",
    214: "не изменился сигнал PIN БП",
    215: "ошибка установки выходного напряжения БП (vout set)",
    216: "показания БП долго не менялись (БП завис)",
    217: "ошибка включения БП (set enable)",
    218: "входное напряжение ниже 230 В для режима High",
    219: "некорректный входной ток БП",
    239: "защита БП: перенапряжение на выходе",
    240: "защита БП: пониженное выходное напряжение",
    241: "дисбаланс выходного тока БП",
    257: "защита по току первичной стороны БП",
    263: "предупреждение связи с БП",
    264: "ошибка связи с БП",
    267: "сработал watchdog БП",
    268: "защита БП: перегрузка по выходному току",
    269: "защита БП: перегрузка по входному току",
    270: "защита БП: повышенное входное напряжение",
    271: "защита БП: пониженное входное напряжение",
    272: "предупреждение: слишком большая выходная мощность БП",
    273: "предупреждение: слишком большая входная мощность БП",
    274: "предупреждение: вентилятор БП",
    275: "предупреждение: перегрев БП",
    8700: "модель БП не подходит к асику",
}
_POWER_RANGES = [
    ((233, 235), "защита БП: перегрев выхода"),
    ((236, 238), "защита БП: перегрузка по выходному току (проверь винты медных шин)"),
    ((243, 245), "защита БП: перегрев входа"),
    ((246, 247), "защита БП: перегрузка по входному току"),
    ((248, 249), "защита БП: повышенное входное напряжение"),
    ((250, 251), "защита БП: пониженное входное напряжение"),
    ((253, 254), "ошибка вентилятора БП"),
    ((255, 256), "защита БП: перегрузка по выходной мощности"),
    ((258, 259), "перекос фаз на входе"),
    ((265, 266), "неизвестная ошибка БП"),
    ((276, 280), "неизвестная ошибка БП"),
    ((281, 299), "ошибка регистра БП"),
]
_BOARD_ERRORS = {
    1: "ошибка типа майнера",
    2: "ошибка bin-типа чипов",
    3: "хэшплата не найдена",
    4: "ошибка чтения chip id",
    5: "битые чипы",
    6: "дисбаланс (loss of balance)",
    7: "ошибка передачи данных чипа (xfer)",
    8: "ошибка сброса",
    9: "частота слишком низкая",
}


def _split_code(code: int) -> Tuple[int, int, int]:
    s = str(code)
    if len(s) == 6 and s[0] != "1":
        return int(s[:2]), int(s[2]), int(s[3:])
    return int(s[:-2]), int(s[-2]), int(s[-1])


def is_power_error(code: int) -> bool:
    """Коды, которые по таблице MicroBT указывают на питание (БП или сеть)."""
    if 200 <= code <= 299 or code == 8700 or 5010 <= code <= 5029:
        return True
    s = str(code)
    return len(s) == 6 and s[:2] in ("55", "56")


def describe_error(code: int) -> str:
    """Человеческое описание кода ошибки Whatsminer (на русском)."""
    if code in _POWER_ERRORS:
        return _POWER_ERRORS[code]
    for (lo, hi), text in _POWER_RANGES:
        if lo <= code <= hi:
            return text
    if code < 100:
        return "неизвестный код"
    try:
        etype, sub, val = _split_code(code)
    except ValueError:
        return "неизвестный код"
    if etype == 1:
        if sub == 4:
            return "слишком высокие обороты вентилятора"
        return "ошибка оборотов вентилятора (%s)" % ("вход" if val == 0 else "выход")
    if etype == 2:
        return "ошибка блока питания"
    if etype == 3:
        if sub == 0:
            return "слот %d: датчик температуры не найден" % val
        if sub == 2:
            return "ошибка датчика температуры" + ("" if val == 9 else " (слот %d)" % val)
        if sub == 5:
            return "слот %d: защита по температуре (перегрев)" % val
        if sub == 6:
            return "перегрев хэшплаты"
        if sub == 7:
            return "температура окружающей среды сильно скачет"
        if sub == 8:
            return "ошибка датчика влажности"
        return "ошибка температуры"
    if etype == 4:
        return "слот %d: ошибка EEPROM" % val
    if etype == 5:
        if sub in _BOARD_ERRORS:
            return "слот %d: %s" % (val, _BOARD_ERRORS[sub])
        return "ошибка хэшплаты"
    if etype == 6:
        return "слишком высокая температура окружающей среды" + (
            " для режима высокой мощности" if sub == 1 else ""
        )
    if etype == 7:
        if sub == 1:
            return "плата управления аварийно перезагрузилась"
        if sub == 2:
            return "плата управления: ошибка связи со слотом %d" % val
        return "ошибка платы управления"
    if etype == 8:
        return "ошибка контрольной суммы ПО"
    if etype == 9:
        return "ошибка мощности (power rate)"
    if etype == 20:
        if sub == 0:
            return "не настроены пулы"
        if sub == 1:
            return "все пулы отключены"
        if sub == 2:
            return "пул %d: нет соединения" % val
        if sub == 3:
            return "высокий процент reject на пуле"
        if sub == 4:
            return "пул не поддерживает asicboost"
        return "ошибка пула"
    if etype == 21:
        return "слот %d: не пройден заводской тест" % val
    if etype == 23:
        return "низкий хешрейт / потеря хешрейта (проверь питание, сеть, температуру)"
    if etype == 50 and sub in (1, 2):
        return "слот %d: %s" % (val, "слишком низкое напряжение на чипах" if sub == 1
                               else "скачет напряжение на чипах (часто БП)")
    if etype in (55, 56):
        return "слот %d: %s" % (sub, "сброс чипа" if etype == 55 else "чип не отдаёт nonce") + " (часто БП)"
    return "неизвестный код"


def format_errors(codes: Sequence[int], limit: int = 6) -> str:
    if not codes:
        return "нет"
    parts = ["%d (%s)" % (c, describe_error(c)) for c in list(codes)[:limit]]
    if len(codes) > limit:
        parts.append("и ещё %d" % (len(codes) - limit))
    return ", ".join(parts)


def parse_error_codes(raw: object) -> List[int]:
    """Разбирает список ошибок в любом из форматов, которые отдают разные прошивки."""
    out: List[int] = []
    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list):
        return out
    for item in raw:
        keys = list(item.keys()) if isinstance(item, dict) else [item]
        for k in keys:
            if str(k).lower() == "reason":
                continue
            try:
                out.append(int(str(k).strip()))
            except ValueError:
                pass
    return sorted(set(out))


# =============================================================================
#  Транспорт и клиенты API
# =============================================================================


class ApiError(Exception):
    """Асик ответил, но с ошибкой (или ответ не разобрать)."""


class Unreachable(ApiError):
    """Не удалось даже подключиться к порту API."""


class NoReply(ApiError):
    """Подключились, но ответа нет (обрыв или таймаут)."""


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    buf = b""
    while len(buf) < n:
        chunk = sock.recv(n - len(buf))
        if not chunk:
            raise ConnectionError("connection closed")
        buf += chunk
    return buf


def tcp_request(host: str, port: int, payload: bytes, timeout: float, framed: bool = False) -> bytes:
    try:
        sock = socket.create_connection((host, port), timeout=timeout)
    except OSError as e:
        raise Unreachable("%s:%d — нет связи (%s)" % (host, port, e)) from e
    with sock:
        sock.settimeout(timeout)
        try:
            sock.sendall(payload)
            if framed:
                (length,) = struct.unpack("<I", _recv_exact(sock, 4))
                if length > 16 * 1024 * 1024:
                    raise ApiError("слишком длинный ответ (%d байт)" % length)
                return _recv_exact(sock, length)
            chunks: List[bytes] = []
            while True:
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    if chunks:
                        break
                    raise
                if not chunk:
                    break
                chunks.append(chunk)
            data = b"".join(chunks)
            if not data.strip(b"\x00 \r\n"):
                raise ConnectionError("empty reply")
            return data
        except OSError as e:
            raise NoReply("%s:%d — нет ответа (%s)" % (host, port, e)) from e


def parse_v2_json(data: bytes) -> dict:
    """btminer иногда отдаёт слегка битый JSON — чиним известные косяки."""
    s = data.decode("utf-8", errors="replace").strip().rstrip("\x00").strip()
    s = s.replace(",}", "}").replace("\n", "").replace('""temp0', '","temp0')
    # API 2.0.4: "error_code":["110":"...","203":"..."] — список, оформленный как словарь
    if re.search(r"\"error_code\":\[\".+\"\]", s):
        s = s.replace("[", "{").replace("]", "}")
    try:
        obj = json.loads(s)
    except ValueError as e:
        raise ApiError("не удалось разобрать ответ: %s" % s[:200]) from e
    if not isinstance(obj, dict):
        raise ApiError("неожиданный ответ: %s" % s[:200])
    return obj


def _v2_status(d: dict) -> Tuple[Optional[str], object]:
    st = d.get("STATUS")
    if isinstance(st, list) and st and isinstance(st[0], dict):
        return st[0].get("STATUS"), st[0].get("Msg")
    return st, d.get("Msg")


def _to_float(v: object) -> Optional[float]:
    try:
        return float(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def _volts(v: object) -> Optional[float]:
    """Входное напряжение БП: прошивки отдают его в вольтах или в единицах по 10 мВ (22500 = 225 В)."""
    x = _to_float(v)
    if x is None or x <= 0:
        return None
    while x >= 1000:
        x /= 10
    return round(x, 1)


def _first_float(d: dict, *keys: str) -> Optional[float]:
    for k in keys:
        v = _to_float(d.get(k))
        if v is not None:
            return v
    return None


_HINT_WRITE = (
    "Запись по API выключена. Включи её в WhatsMinerTool (API / «Remote control» → "
    "включить API) и смени пароль admin через WhatsMinerTool — см. README."
)
_HINT_TOKEN = (
    "Похоже, неверный пароль admin. На многих прошивках API не принимает пароль по "
    "умолчанию, пока его один раз не сменить через WhatsMinerTool — см. README."
)


def _hint(msg: object) -> str:
    m = str(msg).lower()
    if "write" in m or "access" in m:
        return " — " + _HINT_WRITE
    if "token" in m or "password" in m or "pwd" in m:
        return " — " + _HINT_TOKEN
    return ""


@dataclass
class Snapshot:
    api: str = ""
    hashrate_ths: Optional[float] = None
    expected_ths: Optional[float] = None
    uptime_s: Optional[int] = None
    power_w: Optional[float] = None
    env_temp: Optional[float] = None
    vin: Optional[float] = None  # входное напряжение БП, В
    fan_in: Optional[float] = None  # обороты вентиляторов, об/мин
    fan_out: Optional[float] = None
    # «сырые» короткие значения хешрейта (5s/1m). У живого майнера они меняются каждый опрос;
    # если не меняются — статистика зависла на последнем значении.
    hr_sig: Tuple = ()
    boards_ths: List[float] = field(default_factory=list)
    errors: List[int] = field(default_factory=list)
    read_error: Optional[str] = None


class WhatsminerV2:
    """API v2 (btminer, TCP 4028). Чтение — открытым JSON, запись — с токеном и AES."""

    api = "v2"

    def __init__(self, host: str, port: int = 4028, password: str = "admin", timeout: float = 10.0):
        self.host, self.port, self.password, self.timeout = host, port, password, timeout

    def _send(self, payload: bytes) -> bytes:
        return tcp_request(self.host, self.port, payload, self.timeout)

    def read(self, cmd: str, **params: object) -> dict:
        req = {"command": cmd}
        req.update(params)  # type: ignore[arg-type]
        d = parse_v2_json(self._send(json.dumps(req).encode()))
        status, msg = _v2_status(d)
        if status == "E":
            raise ApiError("%s: %s" % (cmd, msg))
        return d

    def privileged(self, cmd: str, expect_disconnect: bool = False, **params: object) -> dict:
        try:
            tok = self.read("get_token")
        except (Unreachable, NoReply):
            raise
        except ApiError as e:
            raise ApiError("%s%s" % (e, _hint(e) or " — " + _HINT_WRITE)) from e
        m = tok.get("Msg")
        if not isinstance(m, dict) or not all(k in m for k in ("salt", "newsalt", "time")):
            raise ApiError("get_token: неожиданный ответ %s%s" % (str(tok)[:200], _hint(m)))
        key = md5_crypt(self.password, str(m["salt"])).split("$")[3]
        sign = md5_crypt(key + str(m["time"]), str(m["newsalt"])).split("$")[3]
        aes = AES256ECB(hashlib.sha256(key.encode()).digest())
        body: Dict[str, object] = {"cmd": cmd}
        body.update(params)
        body["token"] = sign
        text = json.dumps(body)
        text += "\0" * (-len(text) % 16)
        packet = json.dumps({"enc": 1, "data": base64.b64encode(aes.encrypt(text.encode())).decode()})
        try:
            raw = self._send(packet.encode())
        except NoReply:
            if expect_disconnect:  # reboot часто рвёт соединение, не ответив
                return {"STATUS": "S", "Msg": "команда отправлена, асик оборвал связь"}
            raise
        d = parse_v2_json(raw)
        if "enc" in d:
            try:
                plain = aes.decrypt(base64.b64decode(str(d["enc"]))).rstrip(b"\0")
                d = json.loads(plain.decode("utf-8", errors="replace"))
            except (ValueError, TypeError) as e:
                raise ApiError("%s: не удалось расшифровать ответ (%s)%s" % (cmd, e, _hint("token"))) from e
        status, msg = _v2_status(d)
        if status != "S":
            raise ApiError("%s: %s (code %s)%s" % (cmd, msg, d.get("Code"), _hint(msg)))
        return d

    def snapshot(self) -> Snapshot:
        summ = self.read("summary")
        rows = summ.get("SUMMARY") or [{}]
        s = rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else {}
        snap = Snapshot(api=self.api)
        mhs = _first_float(s, "MHS 1m", "MHS 5s", "MHS av")
        snap.hashrate_ths = None if mhs is None else mhs / 1e6
        ghs = _to_float(s.get("Factory GHS"))
        snap.expected_ths = ghs / 1000 if ghs and ghs > 0 else None
        up = _to_float(s.get("Elapsed"))
        snap.uptime_s = None if up is None else int(up)
        snap.power_w = _to_float(s.get("Power"))
        snap.env_temp = _to_float(s.get("Env Temp"))
        snap.fan_in = _to_float(s.get("Fan Speed In"))
        snap.fan_out = _to_float(s.get("Fan Speed Out"))
        snap.hr_sig = tuple(_to_float(s.get(k)) for k in ("MHS 5s", "MHS 1m") if k in s)
        errors = set()
        try:
            cnt = int(s.get("Error Code Count") or 0)
        except (TypeError, ValueError):
            cnt = 0
        for i in range(cnt):
            errors.update(parse_error_codes([s.get("Error Code %d" % i)]))
        try:
            ec = self.read("get_error_code")
            msg = ec.get("Msg")
            if isinstance(msg, dict):
                errors.update(parse_error_codes(msg.get("error_code")))
        except ApiError as e:
            if isinstance(e, Unreachable):
                raise
            log.debug("%s: get_error_code: %s", self.host, e)
        snap.errors = sorted(errors)
        try:
            devs = self.read("devs").get("DEVS") or []
            for b in devs if isinstance(devs, list) else []:
                v = _first_float(b, "MHS 1m", "MHS 5s", "MHS av") if isinstance(b, dict) else None
                snap.boards_ths.append((v or 0.0) / 1e6)
        except ApiError as e:
            if isinstance(e, Unreachable):
                raise
            log.debug("%s: devs: %s", self.host, e)
        try:
            psu = self.read("get_psu").get("Msg")
            if isinstance(psu, dict):
                snap.vin = _volts(psu.get("vin"))
        except ApiError as e:
            if isinstance(e, Unreachable):
                raise
            log.debug("%s: get_psu: %s", self.host, e)
        return snap

    def reboot(self) -> dict:
        return self.privileged("reboot", expect_disconnect=True)

    def restart(self) -> dict:
        return self.privileged("restart_btminer", expect_disconnect=True)

    def check_auth(self) -> dict:
        return self.privileged("set_led", param="auto")

    def power_limit(self, watts: int) -> dict:
        return self.privileged("adjust_power_limit", expect_disconnect=True, power_limit=str(int(watts)))

    def power_mode(self, mode: str) -> dict:
        cmd = {"low": "set_low_power", "normal": "set_normal_power", "high": "set_high_power"}[mode]
        return self.privileged(cmd)


class WhatsminerV3:
    """API v3 (TCP 4433, M6x и новые прошивки). Кадр = 4 байта длины + JSON."""

    api = "v3"

    def __init__(self, host: str, port: int = 4433, password: str = "super", timeout: float = 10.0,
                 account: str = "super"):
        self.host, self.port, self.password, self.timeout, self.account = host, port, password, timeout, account

    def _call(self, payload: dict) -> dict:
        body = json.dumps(payload).encode()
        raw = tcp_request(self.host, self.port, struct.pack("<I", len(body)) + body, self.timeout, framed=True)
        try:
            d = json.loads(raw.decode("utf-8", errors="replace"))
        except ValueError as e:
            raise ApiError("не удалось разобрать ответ: %r" % raw[:200]) from e
        if not isinstance(d, dict):
            raise ApiError("неожиданный ответ: %r" % raw[:200])
        return d

    def read(self, cmd: str, param: object = None) -> dict:
        d = self._call({"cmd": cmd, "param": param})
        code = d.get("code")
        if code not in (0, None):
            raise ApiError("%s: %s (code %s)" % (cmd, d.get("msg"), code))
        return d

    def privileged(self, cmd: str, param: object = None, expect_disconnect: bool = False) -> dict:
        info = self.read("get.device.info", "salt").get("msg")
        salt = info.get("salt") if isinstance(info, dict) else None
        if not salt:
            raise ApiError("get.device.info: не получили salt")
        ts = int(time.time())
        digest = hashlib.sha256((cmd + self.password + str(salt) + str(ts)).encode()).digest()
        token = base64.b64encode(digest).decode()[:8]
        payload = {"cmd": cmd, "param": param, "ts": ts, "account": self.account, "token": token}
        try:
            d = self._call(payload)
        except NoReply:
            if expect_disconnect:
                return {"code": 0, "msg": "команда отправлена, асик оборвал связь"}
            raise
        if d.get("code") != 0:
            raise ApiError("%s: %s (code %s)%s" % (cmd, d.get("msg"), d.get("code"), _hint(d.get("msg"))))
        return d

    def snapshot(self) -> Snapshot:
        msg = self.read("get.miner.status", "summary").get("msg")
        s = msg.get("summary", {}) if isinstance(msg, dict) else {}
        snap = Snapshot(api=self.api)
        snap.hashrate_ths = _to_float(s.get("hash-realtime"))
        exp = _to_float(s.get("factory-hash"))
        snap.expected_ths = exp if exp and exp > 0 else None
        up = _to_float(s.get("elapsed"))
        snap.uptime_s = None if up is None else int(up)
        snap.power_w = _to_float(s.get("power-realtime"))
        snap.env_temp = _to_float(s.get("environment-temperature"))
        snap.fan_in = _to_float(s.get("fan-speed-in"))
        snap.fan_out = _to_float(s.get("fan-speed-out"))
        snap.hr_sig = (snap.hashrate_ths,) if "hash-realtime" in s else ()
        try:
            em = self.read("get.miner.status", "edevs").get("msg")
            for b in (em.get("edevs") or []) if isinstance(em, dict) else []:
                v = _to_float(b.get("hash-average")) if isinstance(b, dict) else None
                snap.boards_ths.append(v or 0.0)
        except ApiError as e:
            if isinstance(e, Unreachable):
                raise
            log.debug("%s: edevs: %s", self.host, e)
        try:
            dm = self.read("get.device.info").get("msg")
            if isinstance(dm, dict):
                snap.errors = parse_error_codes(dm.get("error-code"))
                pw = dm.get("power")
                if isinstance(pw, dict):
                    snap.vin = _volts(pw.get("vin"))
        except ApiError as e:
            if isinstance(e, Unreachable):
                raise
            log.debug("%s: get.device.info: %s", self.host, e)
        return snap

    def reboot(self) -> dict:
        return self.privileged("set.system.reboot", expect_disconnect=True)

    def restart(self) -> dict:
        return self.privileged("set.miner.service", "restart", expect_disconnect=True)

    def check_auth(self) -> dict:
        return self.privileged("set.system.led", "auto")

    def power_limit(self, watts: int) -> dict:
        return self.privileged("set.miner.power_limit", int(watts))

    def power_mode(self, mode: str) -> dict:
        raise ApiError("смена режима мощности для API v3 пока не поддерживается — используй power-limit")


class MinerClient:
    """Сам выбирает API и запоминает, какой ответил.

    Сначала пробуем v3 (порт 4433): он есть только на новых прошивках (примерно с конца
    2024), и на них старый порт 4028 часто ещё отвечает на чтение, но команды записи
    принимает уже только v3. На старых прошивках 4433 закрыт — сразу уходим на v2.
    Если команда не прошла по одному API, пробуем другой.
    """

    def __init__(self, host: str, api: str = "auto", password: str = "admin", password_v3: str = "super",
                 port: int = 4028, port_v3: int = 4433, timeout: float = 10.0):
        self.v2 = WhatsminerV2(host, port, password, timeout) if api in ("auto", "v2") else None
        self.v3 = WhatsminerV3(host, port_v3, password_v3, timeout) if api in ("auto", "v3") else None
        self.active = self.v3 or self.v2

    def _order(self) -> list:
        out = []
        for c in (self.active, self.v3, self.v2):
            if c is not None and c not in out:
                out.append(c)
        return out

    def snapshot(self) -> Snapshot:
        errors: List[Unreachable] = []
        for c in self._order():
            try:
                snap = c.snapshot()
                self.active = c
                return snap
            except Unreachable as e:  # порт закрыт/недоступен — пробуем другой API
                errors.append(e)
        if len(errors) == 1:
            raise errors[0]
        raise Unreachable("; ".join(str(e) for e in errors))

    def _action(self, name: str, *args: object) -> dict:
        errors: List[str] = []
        for c in self._order():
            try:
                r = getattr(c, name)(*args)
                self.active = c
                return r
            except ApiError as e:
                errors.append("API %s: %s" % (c.api, e))
        raise ApiError("; ".join(errors))

    def reboot(self) -> dict:
        return self._action("reboot")

    def restart(self) -> dict:
        return self._action("restart")

    def check_auth(self) -> dict:
        return self._action("check_auth")

    def power_limit(self, watts: int) -> dict:
        return self._action("power_limit", watts)

    def power_mode(self, mode: str) -> dict:
        return self._action("power_mode", mode)


# =============================================================================
#  Конфиг
# =============================================================================


@dataclass
class MinerConf:
    name: str
    host: str
    api: str = "auto"
    password: str = "admin"
    password_v3: str = "super"
    port: int = 4028
    port_v3: int = 4433
    expected_ths: Optional[float] = None
    min_hashrate_pct: float = 50.0
    check_dead_boards: bool = True
    min_fan_rpm: float = 600.0
    fault_codes: List[int] = field(default_factory=list)
    actions: List[str] = field(default_factory=lambda: ["reboot"])
    enabled: bool = True


@dataclass
class Settings:
    interval: int = 60
    timeout: float = 10.0
    grace_period: int = 900
    bad_checks: int = 3
    stale_checks: int = 2
    action_cooldown: int = 600
    max_actions_per_hour: int = 3
    unreachable_checks: int = 5
    on_unreachable: str = ""
    hook_cooldown: int = 1800
    min_vin: float = 0.0
    max_vin_wait: int = 3600
    workers: int = 16
    dry_run: bool = False
    log_file: str = "wm_watchdog.log"
    events_file: str = "wm_events.csv"
    telegram_token: str = ""
    telegram_chat_id: str = ""
    telegram_api: str = "https://api.telegram.org"
    notify_recovery: bool = True
    daily_report_hour: Optional[int] = None


VALID_ACTIONS = ("restart", "reboot", "hook")
MINER_KEYS = ("host", "api", "password", "password_v3", "port", "port_v3", "expected_ths",
              "min_hashrate_pct", "check_dead_boards", "min_fan_rpm", "fault_codes", "actions", "enabled")


class ConfigError(Exception):
    pass


def _parse_bool(v: str, key: str) -> bool:
    s = v.strip().lower()
    if s in ("1", "yes", "true", "on", "да"):
        return True
    if s in ("0", "no", "false", "off", "нет"):
        return False
    raise ConfigError("%s: ожидалось yes/no, а не %r" % (key, v))


def _parse_num(v: str, key: str, kind: Callable = int):
    try:
        return kind(v.strip())
    except ValueError:
        raise ConfigError("%s: ожидалось число, а не %r" % (key, v))


def _apply_miner_opts(mc: MinerConf, sect: configparser.SectionProxy, where: str) -> None:
    for key in MINER_KEYS:
        if key not in sect or key == "host":
            continue
        v = sect[key].strip()
        k = "[%s] %s" % (where, key)
        if key == "api":
            if v not in ("auto", "v2", "v3"):
                raise ConfigError("%s: допустимо auto, v2 или v3" % k)
            mc.api = v
        elif key in ("password", "password_v3"):
            setattr(mc, key, sect[key])  # пароль берём как есть, без strip
        elif key in ("port", "port_v3"):
            setattr(mc, key, _parse_num(v, k))
        elif key == "expected_ths":
            mc.expected_ths = _parse_num(v, k, float) if v else None
        elif key in ("min_hashrate_pct", "min_fan_rpm"):
            setattr(mc, key, _parse_num(v, k, float))
        elif key == "fault_codes":
            mc.fault_codes = [_parse_num(x, k) for x in v.replace(";", ",").split(",") if x.strip()]
        elif key in ("check_dead_boards", "enabled"):
            setattr(mc, key, _parse_bool(v, k))
        elif key == "actions":
            acts = [a.strip() for a in v.split(",") if a.strip()]
            bad = [a for a in acts if a not in VALID_ACTIONS]
            if bad or not acts:
                raise ConfigError("%s: допустимые действия: %s" % (k, ", ".join(VALID_ACTIONS)))
            mc.actions = acts


def load_config(path: str) -> Tuple[Settings, List[MinerConf]]:
    if not os.path.exists(path):
        raise ConfigError("нет файла конфига %s (скопируй config.example.ini в config.ini)" % path)
    cp = configparser.ConfigParser(interpolation=None, delimiters=("=",), default_section="__no_defaults__")
    cp.optionxform = str  # type: ignore[assignment]  # имена асиков с учётом регистра
    with open(path, encoding="utf-8-sig") as f:
        cp.read_file(f)
    st = Settings()
    base_dir = os.path.dirname(os.path.abspath(path))
    if cp.has_section("watchdog"):
        w = cp["watchdog"]
        ints = ("interval", "grace_period", "bad_checks", "stale_checks", "action_cooldown", "max_actions_per_hour",
                "unreachable_checks", "hook_cooldown", "max_vin_wait", "workers")
        for key in ints:
            if key in w:
                setattr(st, key, _parse_num(w[key], "[watchdog] " + key))
        if "timeout" in w:
            st.timeout = _parse_num(w["timeout"], "[watchdog] timeout", float)
        if w.get("min_vin", "").strip():
            st.min_vin = _parse_num(w["min_vin"], "[watchdog] min_vin", float)
        for key in ("on_unreachable", "log_file", "events_file"):
            if key in w:
                setattr(st, key, w[key].strip())
        if "dry_run" in w:
            st.dry_run = _parse_bool(w["dry_run"], "[watchdog] dry_run")
    if cp.has_section("telegram"):
        t = cp["telegram"]
        st.telegram_token = t.get("token", "").strip()
        st.telegram_chat_id = t.get("chat_id", "").strip()
        st.telegram_api = (t.get("api_url", "").strip() or st.telegram_api).rstrip("/")
        if "notify_recovery" in t:
            st.notify_recovery = _parse_bool(t["notify_recovery"], "[telegram] notify_recovery")
        h = t.get("daily_report_hour", "").strip()
        st.daily_report_hour = _parse_num(h, "[telegram] daily_report_hour") if h else None
    for key in ("log_file", "events_file"):
        p = getattr(st, key)
        if p and not os.path.isabs(p):
            setattr(st, key, os.path.join(base_dir, p))

    def new_miner(name: str, host: str) -> MinerConf:
        mc = MinerConf(name=name, host=host)
        if cp.has_section("watchdog"):
            _apply_miner_opts(mc, cp["watchdog"], "watchdog")
        return mc

    miners: Dict[str, MinerConf] = {}
    if cp.has_section("miners"):
        for name, host in cp["miners"].items():
            host = host.strip()
            if not host:
                raise ConfigError("[miners] %s: не указан IP" % name)
            miners[name] = new_miner(name, host)
    for sect in cp.sections():
        if not sect.startswith("miner:"):
            continue
        name = sect.split(":", 1)[1].strip()
        s = cp[sect]
        host = s.get("host", "").strip() or (miners[name].host if name in miners else "")
        if not host:
            raise ConfigError("[%s]: не указан host" % sect)
        mc = miners.get(name) or new_miner(name, host)
        mc.host = host
        _apply_miner_opts(mc, s, sect)
        miners[name] = mc
    if not miners:
        raise ConfigError("в конфиге нет ни одного асика (секция [miners])")
    return st, list(miners.values())


# =============================================================================
#  Уведомления и журнал
# =============================================================================


class Notifier:
    """Telegram-уведомления. Отправка в фоне с повторами, чтобы не тормозить проверки."""

    def __init__(self, token: str = "", chat_id: str = "", api_url: str = "https://api.telegram.org"):
        self.token, self.chat_id, self.api_url = token, chat_id, api_url.rstrip("/")
        self.enabled = bool(token and chat_id)
        self._q: "queue.Queue[str]" = queue.Queue()
        if self.enabled:
            threading.Thread(target=self._worker, name="telegram", daemon=True).start()

    def send(self, text: str) -> None:
        log.info("уведомление: %s", text.replace("\n", " | "))
        if self.enabled:
            self._q.put(text)

    def send_now(self, text: str) -> None:
        """Синхронная отправка (для проверки настроек). Бросает исключение при ошибке."""
        url = "%s/bot%s/sendMessage" % (self.api_url, self.token)
        data = urllib.parse.urlencode({"chat_id": self.chat_id, "text": text[:4000],
                                       "disable_web_page_preview": "true"}).encode()
        with urllib.request.urlopen(url, data, timeout=20) as r:
            resp = json.loads(r.read().decode("utf-8", errors="replace"))
        if not resp.get("ok"):
            raise RuntimeError(str(resp))

    def _worker(self) -> None:
        while True:
            text = self._q.get()
            for attempt in range(4):
                try:
                    self.send_now(text)
                    break
                except Exception as e:  # noqa: BLE001 — сеть может быть какой угодно
                    log.warning("Telegram: не отправилось (%s), попытка %d", e, attempt + 1)
                    time.sleep(5 * (attempt + 1))
            self._q.task_done()

    def flush(self, timeout: float = 30.0) -> None:
        end = time.time() + timeout
        while self._q.unfinished_tasks and time.time() < end:
            time.sleep(0.2)


class EventLog:
    FIELDS = ["time", "miner", "host", "event", "details", "hashrate_ths", "uptime_s", "vin", "errors"]

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()

    def write(self, miner: MinerConf, event: str, details: str = "", snap: Optional[Snapshot] = None,
              when: Optional[float] = None) -> None:
        if not self.path:
            return
        row = {
            "time": datetime.fromtimestamp(when if when is not None else time.time()).strftime("%Y-%m-%d %H:%M:%S"),
            "miner": miner.name,
            "host": miner.host,
            "event": event,
            "details": details,
            "hashrate_ths": "" if not snap or snap.hashrate_ths is None else "%.2f" % snap.hashrate_ths,
            "uptime_s": "" if not snap or snap.uptime_s is None else str(snap.uptime_s),
            "vin": "" if not snap or snap.vin is None else "%.0f" % snap.vin,
            "errors": "" if not snap else " ".join(str(c) for c in snap.errors),
        }
        with self._lock:
            new = not os.path.exists(self.path) or os.path.getsize(self.path) == 0
            with open(self.path, "a", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=self.FIELDS)
                if new:
                    w.writeheader()
                w.writerow(row)


def fmt_dur(sec: float) -> str:
    sec = int(max(0, sec))
    h, rem = divmod(sec, 3600)
    m, s = divmod(rem, 60)
    if h:
        return "%d ч %02d мин" % (h, m)
    if m:
        return "%d мин" % m
    return "%d с" % s


def fmt_ths(v: Optional[float]) -> str:
    return "?" if v is None else "%.1f" % v


# =============================================================================
#  Сторож
# =============================================================================

ACTION_NAMES = {"reboot": "перезагрузку", "restart": "перезапуск майнера (btminer)",
                "hook": "внешнюю команду"}
ZERO_THS = 0.05  # меньше этого считаем, что хешрейта нет


@dataclass
class MinerWatch:
    conf: MinerConf
    client: object
    bad_count: int = 0
    nohash_since: Optional[float] = None
    unreach_count: int = 0
    unreach_since: Optional[float] = None
    unreach_alerted: bool = False
    last_action: float = float("-inf")
    last_hook: float = float("-inf")
    attempt: int = 0
    action_times: Deque[float] = field(default_factory=deque)
    limit_alerted: bool = False
    fail_alerted: bool = False
    incident_start: Optional[float] = None
    incident_actions: int = 0
    incident_errors: set = field(default_factory=set)
    last_snapshot: Optional[Snapshot] = None
    warned_no_hashrate: bool = False
    prev_sig: Tuple = ()
    prev_uptime: Optional[int] = None
    prev_time: Optional[float] = None
    stale_count: int = 0
    vin_wait_since: Optional[float] = None


def run_hook(template: str, conf: MinerConf, timeout: int = 120) -> Tuple[bool, str]:
    cmd = template.replace("{name}", conf.name).replace("{host}", conf.host)
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.SubprocessError) as e:
        return False, str(e)
    out = (r.stdout + r.stderr).strip()
    return r.returncode == 0, ("код %d. %s" % (r.returncode, out[:300])).strip()


class Watchdog:
    def __init__(self, settings: Settings, miners: List[MinerConf], notifier: Optional[Notifier] = None,
                 events: Optional[EventLog] = None, clock: Callable[[], float] = time.time,
                 client_factory: Optional[Callable[[MinerConf, Settings], object]] = None):
        self.s = settings
        self.notifier = notifier or Notifier()
        self.events = events or EventLog("")
        self.clock = clock
        factory = client_factory or make_client
        self.watches = [MinerWatch(conf=m, client=factory(m, settings)) for m in miners if m.enabled]
        self._stop = threading.Event()

    # ---- основной цикл ----

    def run_forever(self) -> None:
        names = ", ".join(w.conf.name for w in self.watches)
        self.notifier.send("👀 Сторож запущен%s. Слежу за %d асиками: %s" % (
            " (dry-run, без действий)" if self.s.dry_run else "", len(self.watches), names))
        last_report_day = None
        while not self._stop.is_set():
            started = time.time()
            self.check_all()
            if self.s.daily_report_hour is not None:
                now = datetime.now()
                if now.hour == self.s.daily_report_hour and last_report_day != now.date():
                    last_report_day = now.date()
                    if self.events.path:
                        self.notifier.send(build_report(self.events.path, days=1, compact=True))
            self._stop.wait(max(1.0, self.s.interval - (time.time() - started)))

    def stop(self) -> None:
        self._stop.set()

    def check_all(self) -> None:
        if not self.watches:
            return
        with ThreadPoolExecutor(max_workers=max(1, min(self.s.workers, len(self.watches)))) as ex:
            list(ex.map(self._check_safe, self.watches))

    def _check_safe(self, w: MinerWatch) -> None:
        try:
            self.check_one(w)
        except Exception:  # noqa: BLE001 — один асик не должен ронять сторожа
            log.exception("%s: внутренняя ошибка при проверке", w.conf.name)

    # ---- проверка одного асика ----

    def check_one(self, w: MinerWatch) -> None:
        now = self.clock()
        try:
            snap = w.client.snapshot()  # type: ignore[attr-defined]
        except (Unreachable, NoReply) as e:
            self._on_unreachable(w, now, e)
            return
        except ApiError as e:
            snap = Snapshot(read_error=str(e))
        self._on_reachable(w, now, snap)

    def evaluate(self, w: MinerWatch, snap: Snapshot, now: float) -> Tuple[str, List[str]]:
        """Возвращает ('ok'|'warmup'|'bad', [описание проблем])."""
        c = w.conf
        if snap.read_error:
            return "bad", ["API ответило ошибкой: %s" % snap.read_error]
        hr = snap.hashrate_ths

        # 1) Зависшая статистика: асик ушёл в ошибку, а API продолжает отдавать последний
        #    хешрейт. У живого майнера аптайм растёт, а 5s/1m-хешрейт меняется каждый опрос.
        frozen = self._frozen_reason(w, snap, now)
        if frozen:
            return "bad", [frozen]

        if hr is not None and hr >= ZERO_THS:
            w.nohash_since = None
        elif hr is not None and w.nohash_since is None:
            w.nohash_since = now
        if snap.uptime_s is not None and snap.uptime_s < self.s.grace_period:
            # майнер недавно стартовал — даём разогнаться. Но если он не хеширует дольше
            # grace_period по нашим наблюдениям (зациклился в перезапусках) — это проблема.
            if w.nohash_since is not None and now - w.nohash_since >= self.s.grace_period:
                return "bad", ["не хеширует уже %s (майнер постоянно перезапускается)" % fmt_dur(now - w.nohash_since)]
            return "warmup", []
        problems: List[str] = []
        fans = [f for f in (snap.fan_in, snap.fan_out) if f]
        if c.min_fan_rpm > 0 and fans and max(fans) < c.min_fan_rpm:
            # при майнинге вентиляторы крутятся на тысячи оборотов; 200–300 об/мин —
            # платы стоят (БП отключил выход), даже если хешрейт на экране «живой»
            problems.append("вентиляторы еле крутятся (%s об/мин) — платы, похоже, стоят" %
                            "/".join("%.0f" % f for f in fans))
        hit = [code for code in snap.errors if code in c.fault_codes]
        if hit:
            problems.append("есть ошибка из fault_codes: %s" % format_errors(hit))
        if hr is None:
            if not w.warned_no_hashrate:
                w.warned_no_hashrate = True
                log.warning("%s: асик не отдаёт хешрейт — следить за ним по хешрейту не получится", c.name)
            return ("bad" if problems else "ok"), problems
        if hr < ZERO_THS:
            problems.append("хешрейт 0")
        else:
            ref = c.expected_ths or snap.expected_ths
            if ref and c.min_hashrate_pct > 0 and hr < ref * c.min_hashrate_pct / 100:
                problems.append("хешрейт %.1f TH/s — меньше %g%% от %.1f TH/s" % (hr, c.min_hashrate_pct, ref))
            if c.check_dead_boards and len(snap.boards_ths) > 1:
                dead = [str(i) for i, b in enumerate(snap.boards_ths) if b < ZERO_THS]
                if dead:
                    problems.append("не хешируют платы в слотах %s" % ", ".join(dead))
        return ("bad" if problems else "ok"), problems

    def _frozen_reason(self, w: MinerWatch, snap: Snapshot, now: float) -> Optional[str]:
        gap = None if w.prev_time is None else now - w.prev_time
        sig_same = bool(snap.hr_sig) and any(snap.hr_sig) and snap.hr_sig == w.prev_sig
        up_same = snap.uptime_s is not None and snap.uptime_s == w.prev_uptime
        # 5s-хешрейт обновляется раз в несколько секунд — сравниваем только редкие опросы
        if gap is not None and gap >= 20 and (sig_same or up_same):
            w.stale_count += 1
        elif gap is None or gap >= 20:
            w.stale_count = 0
        if gap is None or gap >= 20:
            w.prev_sig, w.prev_uptime, w.prev_time = snap.hr_sig, snap.uptime_s, now
        if self.s.stale_checks > 0 and w.stale_count >= self.s.stale_checks:
            what = "аптайм" if up_same and not sig_same else "хешрейт"
            fans = [f for f in (snap.fan_in, snap.fan_out) if f]
            fan_txt = ", вентиляторы %s об/мин" % "/".join("%.0f" % f for f in fans) if fans else ""
            return "майнер завис: %s не меняется %d опроса подряд (на экране %s TH/s%s)" % (
                what, w.stale_count + 1, fmt_ths(snap.hashrate_ths), fan_txt)
        return None

    def _on_reachable(self, w: MinerWatch, now: float, snap: Snapshot) -> None:
        c = w.conf
        if w.unreach_alerted:
            self.notifier.send("✅ %s (%s): снова на связи (не отвечал %s)" % (
                c.name, c.host, fmt_dur(now - (w.unreach_since or now))))
            self.events.write(c, "reachable", "не отвечал %s" % fmt_dur(now - (w.unreach_since or now)), snap, now)
        w.unreach_count, w.unreach_since, w.unreach_alerted = 0, None, False
        w.last_snapshot = snap
        status, problems = self.evaluate(w, snap, now)
        log.debug("%s: %s %s TH/s uptime=%s err=%s", c.name, status, fmt_ths(snap.hashrate_ths),
                  snap.uptime_s, snap.errors)

        if status == "warmup":
            w.bad_count = 0
            return
        if status == "ok":
            if w.incident_start is not None:
                dur = fmt_dur(now - w.incident_start)
                log.info("%s: в норме (%s TH/s), инцидент длился %s", c.name, fmt_ths(snap.hashrate_ths), dur)
                self.events.write(c, "recovered", "простой %s, действий %d" % (dur, w.incident_actions), snap, now)
                if w.incident_actions and self.s.notify_recovery:
                    self.notifier.send("✅ %s: снова хеширует %s TH/s. Простой ~%s, действий: %d" % (
                        c.name, fmt_ths(snap.hashrate_ths), dur, w.incident_actions))
            w.bad_count, w.attempt = 0, 0
            w.limit_alerted = w.fail_alerted = False
            w.incident_start, w.incident_actions = None, 0
            w.incident_errors = set()
            w.vin_wait_since = None
            return

        # status == "bad"
        w.bad_count += 1
        w.incident_errors.update(snap.errors)
        reason = "; ".join(problems)
        if w.incident_start is None:
            w.incident_start = now
            log.warning("%s (%s): проблема — %s. Ошибки: %s", c.name, c.host, reason, format_errors(snap.errors))
            self.events.write(c, "fault", reason, snap, now)
        if w.bad_count < self.s.bad_checks:
            return
        # Просадка в сети: пока на входе меньше min_vin, БП после перезагрузки снова уйдёт
        # в защиту (ошибка 206). Ждём, когда напряжение вернётся, и только тогда ребутим.
        if self.s.min_vin > 0 and snap.vin is not None and 100 < snap.vin < self.s.min_vin:
            if w.vin_wait_since is None:
                w.vin_wait_since = now
                self.notifier.send(
                    "⚡ %s (%s): %s. На входе БП %.0f В — ниже %g В. Перезагружать сейчас бесполезно, "
                    "жду, когда напряжение поднимется. Ошибки: %s" % (
                        c.name, c.host, reason, snap.vin, self.s.min_vin, format_errors(snap.errors)))
                self.events.write(c, "low_voltage_wait", reason, snap, now)
            if now - w.vin_wait_since < self.s.max_vin_wait:
                return
            reason += "; напряжение так и не поднялось за %s — пробую всё равно" % fmt_dur(now - w.vin_wait_since)
        elif w.vin_wait_since is not None:
            reason += "; напряжение вернулось (%s В, ждал %s)" % (fmt_ths(snap.vin).replace(".0", ""),
                                                                fmt_dur(now - w.vin_wait_since))
        if now - w.last_action < self.s.action_cooldown:
            return
        while w.action_times and now - w.action_times[0] >= 3600:
            w.action_times.popleft()
        if len(w.action_times) >= self.s.max_actions_per_hour:
            if not w.limit_alerted:
                w.limit_alerted = True
                self.notifier.send(
                    "⛔ %s (%s): уже %d попыток за час, не помогает. Похоже, нужен осмотр "
                    "(БП, проводка, напряжение в сети). Повторю позже. Последние ошибки: %s" % (
                        c.name, c.host, len(w.action_times), format_errors(sorted(w.incident_errors))))
                self.events.write(c, "give_up", reason, snap, now)
            return
        action = c.actions[min(w.attempt, len(c.actions) - 1)]
        self._do_action(w, action, now, reason, snap)

    def _do_action(self, w: MinerWatch, action: str, now: float, reason: str, snap: Snapshot) -> None:
        c = w.conf
        w.last_action = now
        w.action_times.append(now)
        w.attempt += 1
        w.incident_actions += 1
        w.bad_count = 0
        w.nohash_since = now  # отсчёт «не хеширует» заново — после действия ему нужно время
        w.vin_wait_since = None
        errs = format_errors(snap.errors)
        vin = " Вход БП: %.0f В." % snap.vin if snap.vin is not None else ""
        head = "%s (%s): %s. Ошибки: %s.%s" % (c.name, c.host, reason, errs, vin)
        if self.s.dry_run:
            self.notifier.send("🧪 [dry-run] %s Сделал бы %s." % (head, ACTION_NAMES[action]))
            self.events.write(c, "action_dry_run", action, snap, now)
            return
        ok, info = True, ""
        try:
            if action == "reboot":
                w.client.reboot()  # type: ignore[attr-defined]
            elif action == "restart":
                w.client.restart()  # type: ignore[attr-defined]
            elif action == "hook":
                if not self.s.on_unreachable:
                    raise ApiError("действие hook, но on_unreachable в конфиге пустой")
                ok, info = run_hook(self.s.on_unreachable, c)
        except ApiError as e:
            ok, info = False, str(e)
        if ok:
            self.notifier.send("🔄 %s Отправил %s (попытка %d)." % (head, ACTION_NAMES[action], w.attempt))
            self.events.write(c, "action", action + (" " + info if info else ""), snap, now)
        else:
            log.error("%s: не удалось выполнить %s: %s", c.name, action, info)
            self.events.write(c, "action_failed", "%s: %s" % (action, info), snap, now)
            if not w.fail_alerted:
                w.fail_alerted = True
                self.notifier.send("❌ %s Не смог отправить %s: %s" % (head, ACTION_NAMES[action], info))

    def _on_unreachable(self, w: MinerWatch, now: float, err: Exception) -> None:
        c = w.conf
        w.unreach_count += 1
        if w.unreach_since is None:
            w.unreach_since = now
        if now - w.last_action < self.s.action_cooldown:
            log.info("%s: не отвечает — видимо, ещё перезагружается (%s)", c.name, err)
            return
        log.warning("%s: не отвечает (%d раз подряд): %s", c.name, w.unreach_count, err)
        if w.unreach_count < self.s.unreachable_checks:
            return
        if not w.unreach_alerted:
            w.unreach_alerted = True
            hint = "" if self.s.on_unreachable else " Перезагрузить по API нельзя — нужен ручной ребут/передёрнуть питание."
            self.notifier.send("📵 %s (%s) не отвечает уже %s: %s.%s" % (
                c.name, c.host, fmt_dur(now - w.unreach_since), err, hint))
            self.events.write(c, "unreachable", str(err), None, now)
        if self.s.on_unreachable and now - w.last_hook >= self.s.hook_cooldown:
            w.last_hook = now
            w.last_action = now
            if self.s.dry_run:
                self.notifier.send("🧪 [dry-run] %s: запустил бы внешнюю команду" % c.name)
                return
            ok, info = run_hook(self.s.on_unreachable, c)
            self.events.write(c, "hook" if ok else "hook_failed", info, None, now)
            self.notifier.send("%s %s: внешняя команда %s. %s" % (
                "🔌" if ok else "❌", c.name, "выполнена" if ok else "не сработала", info))


def make_client(m: MinerConf, s: Settings) -> MinerClient:
    return MinerClient(m.host, api=m.api, password=m.password, password_v3=m.password_v3,
                       port=m.port, port_v3=m.port_v3, timeout=s.timeout)


# =============================================================================
#  Отчёт по журналу
# =============================================================================


def build_report(path: str, days: float = 7, compact: bool = False) -> str:
    if not os.path.exists(path):
        return "Журнал %s пока пуст." % path
    since = datetime.now() - timedelta(days=days)
    per: Dict[str, Counter] = {}
    vin_fault: Dict[str, List[float]] = {}
    vin_ok: Dict[str, List[float]] = {}
    codes: Counter = Counter()
    hours: Counter = Counter()
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            try:
                t = datetime.strptime(row["time"], "%Y-%m-%d %H:%M:%S")
            except (KeyError, ValueError):
                continue
            if t < since:
                continue
            ev = row.get("event", "")
            name = row.get("miner", "?")
            per.setdefault(name, Counter())[ev] += 1
            v = _to_float(row.get("vin"))
            if v:
                (vin_fault if ev in ("fault", "action") else vin_ok if ev == "recovered" else {}) \
                    .setdefault(name, []).append(v)
            if ev == "fault":
                hours[t.hour] += 1
                for c in (row.get("errors") or "").split():
                    if c.isdigit():
                        codes[int(c)] += 1
    period = "сутки" if days == 1 else "%g дн." % days
    if not per:
        return "📊 За %s событий нет — все асики работали без происшествий." % period
    lines = ["📊 Отчёт за %s" % period]
    for name in sorted(per, key=lambda n: -per[n]["fault"]):
        cnt = per[name]
        lines.append("• %s: падений %d, перезагрузок %d, не отвечал %d раз%s" % (
            name, cnt["fault"], cnt["action"], cnt["unreachable"],
            ", ⛔ сдавался %d" % cnt["give_up"] if cnt["give_up"] else ""))
        if name in vin_fault:
            vf = vin_fault[name]
            line = "    вход БП при падениях: %.0f–%.0f В" % (min(vf), max(vf))
            if name in vin_ok:
                line += ", после восстановления: %.0f–%.0f В" % (min(vin_ok[name]), max(vin_ok[name]))
            lines.append(line)
    if codes:
        power = sum(n for c, n in codes.items() if is_power_error(c))
        total = sum(codes.values())
        if power and power * 2 >= total:
            lines.append("⚡ %d из %d кодов ошибок — питание (БП/сеть). См. README → «Почему отваливаются»."
                         % (power, total))
        lines.append("Частые ошибки при падениях:")
        for code, n in codes.most_common(5 if compact else 15):
            lines.append("  %d × %d — %s" % (n, code, describe_error(code)))
    if hours and not compact:
        lines.append("Падения по часам суток:")
        peak = max(hours.values())
        for h in range(24):
            if hours[h]:
                lines.append("  %02d:00  %s %d" % (h, "█" * max(1, round(20 * hours[h] / peak)), hours[h]))
    return "\n".join(lines)


# =============================================================================
#  CLI
# =============================================================================


def setup_logging(log_file: str, verbose: bool) -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")  # type: ignore[attr-defined]
        except (AttributeError, ValueError):
            pass
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%Y-%m-%d %H:%M:%S")
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    root.addHandler(sh)
    if log_file:
        fh = logging.handlers.RotatingFileHandler(log_file, maxBytes=5_000_000, backupCount=3, encoding="utf-8")
        fh.setFormatter(fmt)
        root.addHandler(fh)


def _select(miners: List[MinerConf], target: str) -> List[MinerConf]:
    if target == "all":
        return miners
    found = [m for m in miners if target in (m.name, m.host)]
    if found:
        return found
    # асика нет в конфиге — работаем по IP с настройками по умолчанию
    try:
        ipaddress.ip_address(target)
    except ValueError:
        raise ConfigError("асик %r не найден в конфиге" % target)
    base = miners[0] if miners else MinerConf(name=target, host=target)
    return [MinerConf(name=target, host=target, api="auto", password=base.password, password_v3=base.password_v3)]


def cmd_status(st: Settings, miners: List[MinerConf]) -> int:
    def probe(m: MinerConf):
        try:
            return m, make_client(m, st).snapshot(), None
        except ApiError as e:
            return m, None, e

    with ThreadPoolExecutor(max_workers=max(1, min(st.workers, len(miners)))) as ex:
        results = list(ex.map(probe, miners))
    hdr = "%-14s %-15s %-3s %9s %9s %10s %6s %6s %11s  %s" % ("асик", "IP", "API", "TH/s", "норма", "аптайм",
                                                              "Вт", "вход В", "вент.", "ошибки")
    print(hdr)
    print("-" * len(hdr))
    for m, snap, err in results:
        if snap is None:
            what = "НЕ ОТВЕЧАЕТ" if isinstance(err, (Unreachable, NoReply)) else "ОШИБКА API"
            print("%-14s %-15s %-3s  %s: %s" % (m.name, m.host, "-", what, err))
            continue
        boards = ""
        if snap.boards_ths:
            boards = " [платы: %s]" % " / ".join("%.0f" % b for b in snap.boards_ths)
        fans = "/".join("%.0f" % f for f in (snap.fan_in, snap.fan_out) if f is not None) or "?"
        print("%-14s %-15s %-3s %9s %9s %10s %6s %6s %11s  %s%s" % (
            m.name, m.host, snap.api, fmt_ths(snap.hashrate_ths), fmt_ths(m.expected_ths or snap.expected_ths),
            fmt_dur(snap.uptime_s) if snap.uptime_s is not None else "?",
            "%.0f" % snap.power_w if snap.power_w is not None else "?",
            "%.0f" % snap.vin if snap.vin is not None else "?", fans,
            format_errors(snap.errors, limit=3) if not snap.read_error else "ошибка API: " + snap.read_error,
            boards))
    return 0


def _run_priv(miners: List[MinerConf], st: Settings, what: str, fn: Callable[[MinerClient], dict]) -> int:
    rc = 0
    for m in miners:
        cl = make_client(m, st)
        try:
            cl.snapshot()  # определяем версию API
        except ApiError as e:
            print("%s (%s): не отвечает — %s" % (m.name, m.host, e))
            rc = 1
            continue
        try:
            r = fn(cl)
            print("%s (%s, API %s): %s — OK (%s)" % (m.name, m.host, cl.active.api, what,
                                                   r.get("Msg") or r.get("msg") or "ok"))
        except ApiError as e:
            print("%s (%s, API %s): %s — ОШИБКА: %s" % (m.name, m.host, cl.active.api, what, e))
            rc = 1
    return rc


def cmd_scan(network: str, timeout: float, workers: int) -> int:
    try:
        net = ipaddress.ip_network(network, strict=False)
    except ValueError as e:
        print("Неверная сеть %r: %s (пример: 192.168.1.0/24)" % (network, e))
        return 2
    if net.num_addresses > 4096:
        print("Слишком большая сеть, максимум /20")
        return 2

    def probe(ip: str):
        cl = MinerClient(ip, timeout=timeout)
        try:
            return ip, cl.snapshot(), cl.active.api
        except ApiError:
            return ip, None, None

    hosts = [str(h) for h in net.hosts()] or [str(net.network_address)]
    print("Сканирую %s (%d адресов)…" % (network, len(hosts)))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        found = [r for r in ex.map(probe, hosts) if r[1] is not None]
    if not found:
        print("Ничего не нашёл. Если асики точно в этой сети — включи API в WhatsMinerTool.")
        return 1
    print("\nНашёл %d. Строки для секции [miners] в config.ini:\n" % len(found))
    print("[miners]")
    for ip, snap, api in found:
        print("# API %s, сейчас %s TH/s" % (api, fmt_ths(snap.hashrate_ths)))
        print("wm-%s = %s" % (ip.split(".")[-1], ip))
    return 0


# =============================================================================
#  Разведка веб-морды: один раз заходит в веб-интерфейс асика (как ты в браузере),
#  ничего не нажимает и сохраняет в файл, как устроены страницы (меню, формы,
#  адреса автообновления). Пароль, cookie и токены в файле скрываются.
#  Нужно, чтобы научить сторожа работать через веб, когда до API не достучаться.
# =============================================================================

# Эти адреса разведчик никогда не открывает: по ним асик может что-то сделать.
_PROBE_DANGER = ("reboot/call", "reboot=", "restart", "reset", "factory", "upgrade", "flash", "logout",
                 "poweroff", "power_off", "power-off", "backup", "passw", "apply", "save", "delete",
                 "remove", "/led", "update", "set_", "set.", "/call", "action=", "submit", "commit",
                 "shutdown", "stop", "start", "kill", "format")
_PROBE_INTEREST = ("status", "overview", "miner", "btminer", "cgminer", "log", "system", "reboot", "summary",
                   "pool", "device", "info")


def _probe_is_dangerous(url: str) -> bool:
    u = url.lower()
    return any(d in u for d in _PROBE_DANGER)


class _PageInfo(html.parser.HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.links: List[str] = []
        self.forms: List[dict] = []
        self.loose_inputs: List[dict] = []
        self.script_src: List[str] = []
        self.inline_js: List[str] = []
        self.text: List[str] = []
        self._form: Optional[dict] = None
        self._in_title = self._in_script = self._in_style = False

    def handle_starttag(self, tag: str, attrs: list) -> None:
        a = {k: (v or "") for k, v in attrs}
        if tag == "title":
            self._in_title = True
        elif tag == "a" and a.get("href"):
            self.links.append(a["href"])
        elif tag == "form":
            self._form = {"action": a.get("action", ""), "method": a.get("method", "get").lower(), "inputs": []}
            self.forms.append(self._form)
        elif tag in ("input", "button", "select", "textarea"):
            item = {"tag": tag, "type": a.get("type", "").lower(), "name": a.get("name", ""),
                    "value": a.get("value", ""), "onclick": a.get("onclick", "")}
            (self._form["inputs"] if self._form is not None else self.loose_inputs).append(item)
        elif tag == "script":
            self._in_script = True
            if a.get("src"):
                self.script_src.append(a["src"])
        elif tag == "style":
            self._in_style = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        elif tag == "form":
            self._form = None
        elif tag == "script":
            self._in_script = False
        elif tag == "style":
            self._in_style = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data
        if self._in_script:
            self.inline_js.append(data)
            return
        if self._in_style:
            return
        d = " ".join(data.split())
        if d:
            self.text.append(d)


def cmd_web_probe(url: str, user: str, password: str, out_path: Optional[str] = None) -> int:
    base = url.strip().rstrip("/")
    if "://" not in base:
        base = "http://" + base
    sp = urllib.parse.urlsplit(base)
    origin = "%s://%s" % (sp.scheme, sp.netloc)
    jar = http.cookiejar.CookieJar()
    # напрямую, без системных прокси: асик доступен по своему адресу
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
                                         urllib.request.HTTPCookieProcessor(jar))
    lines: List[str] = []
    secrets = [x for x in (password,) if x]

    def redact(text: str) -> str:
        for sec in secrets:
            text = text.replace(sec, "<пароль>")
        for c in jar:
            if c.value and len(c.value) >= 4:
                text = text.replace(c.value, "<cookie>")
        text = re.sub(r"(stok=)[0-9A-Za-z]+", r"\1<скрыто>", text)
        text = re.sub(r"(?i)(token[\"']?\s*[:=]\s*[\"']?)[0-9A-Za-z+/=_-]{6,}", r"\1<скрыто>", text)
        return text

    def fetch(u: str, data: Optional[bytes] = None):
        req = urllib.request.Request(u, data=data, headers={"User-Agent": "Mozilla/5.0 wm_watchdog-probe"})
        try:
            with opener.open(req, timeout=20) as r:
                return r.getcode(), r.geturl(), r.headers.get("Content-Type", ""), r.read(500_000)
        except urllib.error.HTTPError as e:
            return e.code, u, (e.headers.get("Content-Type", "") if e.headers else ""), (e.read(100_000) if e.fp else b"")
        except Exception as e:  # noqa: BLE001
            return None, u, "", ("ошибка: %s" % e).encode()

    visited: set = set()

    def report(label: str, u: str, data: Optional[bytes] = None):
        visited.add(u)
        code, final, ctype, body = fetch(u, data)
        lines.append("=" * 72)
        lines.append("%s: %s %s" % (label, "POST" if data else "GET", redact(u)))
        lines.append("  ответ: %s, итоговый адрес: %s, тип: %s, размер: %d" % (code, redact(final), ctype, len(body)))
        text = body.decode("utf-8", errors="replace")
        if "html" not in ctype.lower() and not text.lstrip().startswith("<"):
            lines.append("  содержимое: " + redact(text[:4000]))
            return None, final
        pg = _PageInfo()
        try:
            pg.feed(text)
        except Exception as e:  # noqa: BLE001
            lines.append("  не разобрал HTML: %s" % e)
        lines.append("  заголовок: %s" % " ".join(pg.title.split()))
        for f in pg.forms:
            lines.append("  форма: action=%s method=%s" % (redact(f["action"]), f["method"]))
            for i in f["inputs"]:
                hidden = i["type"] == "password" or "token" in i["name"].lower() or "pass" in i["name"].lower()
                lines.append("    <%s type=%s name=%s value=%s%s>" % (
                    i["tag"], i["type"], i["name"], "<скрыто>" if hidden else redact(i["value"])[:80],
                    (" onclick=" + redact(i["onclick"])[:200]) if i["onclick"] else ""))
        for i in pg.loose_inputs:
            lines.append("  кнопка/поле вне формы: <%s type=%s name=%s value=%s onclick=%s>" % (
                i["tag"], i["type"], i["name"], redact(i["value"])[:80], redact(i["onclick"])[:200]))
        links = list(dict.fromkeys(pg.links))
        if links:
            lines.append("  ссылки (%d):" % len(links))
            for ln in links[:80]:
                lines.append("    " + redact(ln))
        js = "\n".join(pg.inline_js)
        js_urls = list(dict.fromkeys(re.findall(
            r"""["']((?:https?://[^"'\s]+)?/(?:cgi-bin|api|luci|admin)[^"'\s]*)["']""", js)))
        if pg.script_src:
            lines.append("  скрипты: " + ", ".join(redact(x) for x in pg.script_src[:20]))
        if js_urls:
            lines.append("  адреса из скриптов: " + ", ".join(redact(x) for x in js_urls[:40]))
        last_end = -1
        frags = 0
        for m in re.finditer(r"(?i)(xhr|poll|ajax|fetch\(|reboot|token|json)", js):
            if m.start() < last_end or frags >= 12:
                continue
            frag = js[max(0, m.start() - 150): m.end() + 250]
            last_end = m.end() + 250
            frags += 1
            lines.append("  фрагмент скрипта: " + redact(" ".join(frag.split()))[:420])
        if pg.text:
            lines.append("  текст страницы: " + redact(" | ".join(pg.text))[:4000])
        pg.links = [urllib.parse.urljoin(final, x) for x in links] + \
                   [urllib.parse.urljoin(final, x) for x in js_urls]
        return pg, final

    lines.append("wm_watchdog %s web-probe, %s" % (__version__, datetime.now().strftime("%Y-%m-%d %H:%M")))
    lines.append("Ничего на асике не нажималось: только вход и просмотр страниц.")
    p0, f0 = report("Главная", origin + "/")
    p1, f1 = report("Страница входа", origin + "/cgi-bin/luci")

    form, form_page = None, f1
    for pg, fin in ((p1, f1), (p0, f0)):
        for f in (pg.forms if pg else []):
            if any(i["type"] == "password" for i in f["inputs"]):
                form, form_page = f, fin
                break
        if form:
            break
    if form:
        action = urllib.parse.urljoin(form_page, form["action"] or form_page)
        fields: Dict[str, str] = {}
        for i in form["inputs"]:
            n = i["name"]
            if not n:
                continue
            if i["type"] == "password" or "pass" in n.lower():
                fields[n] = password
            elif "user" in n.lower() or "login" in n.lower() or i["type"] in ("text", "email", ""):
                fields[n] = user if i["tag"] == "input" else i["value"]
            elif i["type"] == "hidden":
                fields[n] = i["value"]
    else:
        action = origin + "/cgi-bin/luci"
        fields = {"luci_username": user, "luci_password": password}
    p2, f2 = report("Вход (логин %s)" % user, action, urllib.parse.urlencode(fields).encode())
    lines.append("  cookie после входа: %s" % (", ".join(c.name for c in jar) or "нет"))
    logged_in = bool(list(jar)) or "stok=" in f2

    # обходим страницы меню, сначала самые интересные (статус, логи, перезагрузка)
    prefix = f2.split("/admin")[0] if "/admin" in f2 else origin + "/cgi-bin/luci"
    guesses = [prefix + x for x in ("/admin/status/overview", "/admin/status/btminerstatus",
                                    "/admin/status/cgminerstatus", "/admin/status/minerstatus",
                                    "/admin/status/syslog", "/admin/status/btminerlog",
                                    "/admin/system/reboot")]
    todo: List[str] = []
    for u in (p2.links if p2 else []) + guesses:
        u = u.split("#")[0]
        if not u.startswith(origin) or _probe_is_dangerous(u) or u in todo:
            continue
        todo.append(u)
    todo.sort(key=lambda u: -sum(k in u.lower() for k in _PROBE_INTEREST))
    pages = 0
    while todo and pages < 25:
        u = todo.pop(0)
        if u in visited:
            continue
        pages += 1
        pg, _ = report("Страница", u)
        for v in (pg.links if pg else []):
            v = v.split("#")[0]
            if v.startswith(origin) and not _probe_is_dangerous(v) and v not in visited and v not in todo:
                if "?" in v or any(k in v.lower() for k in ("status", "log", "json", "summary")):
                    todo.insert(0, v)  # адреса автообновления статуса — в приоритет

    out = out_path or "web_probe_%s.txt" % re.sub(r"[^0-9A-Za-z._-]+", "_", sp.netloc)
    with open(out, "w", encoding="utf-8") as f:
        f.write(redact("\n".join(lines)) + "\n")
    print("Готово: %s (страниц: %d). Пароль, cookie и токены в файле скрыты." % (os.path.abspath(out), len(visited)))
    if not logged_in:
        print("Похоже, войти не удалось — проверь логин/пароль (в файле всё равно есть страница входа).")
    print("Пришли этот файл мне — по нему я научу сторожа перезагружать асик через веб-морду.")
    return 0



def default_config_path() -> str:
    here = os.path.join(os.getcwd(), "config.ini")
    if os.path.exists(here):
        return here
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.ini")


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(
        prog="wm_watchdog",
        description="Сторож для асиков Whatsminer: следит по API и сам перезагружает упавшие.")
    p.add_argument("-c", "--config", default=None, help="путь к config.ini (по умолчанию рядом со скриптом)")
    p.add_argument("-v", "--verbose", action="store_true", help="подробный лог")
    p.add_argument("--version", action="version", version="%(prog)s " + __version__)
    sub = p.add_subparsers(dest="cmd")
    r = sub.add_parser("run", help="следить и чинить (основной режим)")
    r.add_argument("--dry-run", action="store_true", help="только смотреть и писать, ничего не перезагружать")
    sub.add_parser("status", help="показать состояние всех асиков")
    sub.add_parser("check-auth", help="проверить, что асики принимают команды записи (мигнёт LED → авто)")
    for name, hlp in (("reboot", "перезагрузить асик"), ("restart", "перезапустить только майнер (btminer)")):
        sp = sub.add_parser(name, help=hlp)
        sp.add_argument("target", help="имя из конфига, IP или all")
    sp = sub.add_parser("power-limit", help="ограничить мощность, Вт (асик перезагрузится)")
    sp.add_argument("target")
    sp.add_argument("watts", type=int)
    sp = sub.add_parser("power-mode", help="режим мощности low/normal/high (API v2)")
    sp.add_argument("target")
    sp.add_argument("mode", choices=["low", "normal", "high"])
    rp = sub.add_parser("report", help="статистика падений из журнала")
    rp.add_argument("--days", type=float, default=7)
    sub.add_parser("telegram-test", help="отправить тестовое сообщение в Telegram")
    sc = sub.add_parser("scan", help="найти асики в сети, напр. scan 192.168.1.0/24")
    sc.add_argument("network")
    sc.add_argument("--timeout", type=float, default=2.0)
    wp = sub.add_parser("web-probe", help="разведать веб-морду асика (ничего не нажимает), напр. "
                                          "web-probe http://1.2.3.4:1001")
    wp.add_argument("url")
    wp.add_argument("--user", default="admin")
    wp.add_argument("--password", default=None, help="если не указать — спросит")
    wp.add_argument("--out", default=None, help="куда сохранить отчёт")

    args = p.parse_args(argv)
    cmd = args.cmd or "run"

    if cmd == "scan":
        setup_logging("", args.verbose)
        return cmd_scan(args.network, args.timeout, 64)
    if cmd == "web-probe":
        pwd = args.password if args.password is not None else getpass.getpass("Пароль веб-морды: ")
        return cmd_web_probe(args.url, args.user, pwd, args.out)

    cfg_path = args.config or default_config_path()
    try:
        st, miners = load_config(cfg_path)
    except (ConfigError, configparser.Error) as e:
        print("Ошибка конфига: %s" % e, file=sys.stderr)
        return 2

    setup_logging(st.log_file if cmd == "run" else "", args.verbose)
    try:
        if cmd == "run":
            if getattr(args, "dry_run", False):
                st.dry_run = True
            notifier = Notifier(st.telegram_token, st.telegram_chat_id, st.telegram_api)
            wd = Watchdog(st, miners, notifier, EventLog(st.events_file))
            log.info("wm_watchdog %s: %d асиков, опрос каждые %d с%s", __version__, len(wd.watches),
                     st.interval, ", DRY-RUN" if st.dry_run else "")
            try:
                wd.run_forever()
            except KeyboardInterrupt:
                log.info("остановлен")
                notifier.flush(5)
            return 0
        if cmd == "status":
            return cmd_status(st, miners)
        if cmd == "check-auth":
            return _run_priv(miners, st, "доступ на запись", lambda c: c.check_auth())
        if cmd in ("reboot", "restart"):
            fn = (lambda c: c.reboot()) if cmd == "reboot" else (lambda c: c.restart())
            return _run_priv(_select(miners, args.target), st, ACTION_NAMES[cmd], fn)
        if cmd == "power-limit":
            return _run_priv(_select(miners, args.target), st, "лимит %d Вт" % args.watts,
                             lambda c: c.power_limit(args.watts))
        if cmd == "power-mode":
            return _run_priv(_select(miners, args.target), st, "режим %s" % args.mode,
                             lambda c: c.power_mode(args.mode))
        if cmd == "report":
            print(build_report(st.events_file, days=args.days))
            return 0
        if cmd == "telegram-test":
            n = Notifier(st.telegram_token, st.telegram_chat_id, st.telegram_api)
            if not n.enabled:
                print("В конфиге не заданы [telegram] token и chat_id")
                return 2
            n.send_now("✅ wm_watchdog: тестовое сообщение, уведомления работают")
            print("Отправлено.")
            return 0
    except ConfigError as e:
        print("Ошибка: %s" % e, file=sys.stderr)
        return 2
    except Exception as e:  # noqa: BLE001
        log.exception("ошибка: %s", e)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
