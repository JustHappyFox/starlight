# -*- coding: utf-8 -*-
"""Тесты wm_watchdog: криптография, протокол (на эмуляторе асика), логика сторожа, конфиг.

Запуск из папки whatsminer-watchdog:  python3 -m unittest discover -s tests -v
Если установлены passlib и cryptography, эмулятор асика использует их — тогда
это независимая сверка нашей встроенной криптографии с эталонными библиотеками.
"""
import base64
import hashlib
import json
import os
import socketserver
import struct
import sys
import tempfile
import logging
import threading
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import wm_watchdog as wm  # noqa: E402

logging.getLogger("wm_watchdog").setLevel(logging.CRITICAL)  # не засорять вывод тестов

try:
    from passlib.hash import md5_crypt as _pl_md5

    def ref_md5_crypt(pw, salt):
        return _pl_md5.using(salt=salt).hash(pw)

    HAVE_PASSLIB = True
except Exception:  # noqa: BLE001
    ref_md5_crypt = wm.md5_crypt
    HAVE_PASSLIB = False

try:
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    def ref_aes_enc(key, data):
        e = Cipher(algorithms.AES(key), modes.ECB()).encryptor()
        return e.update(data) + e.finalize()

    def ref_aes_dec(key, data):
        d = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
        return d.update(data) + d.finalize()

    HAVE_CRYPTOGRAPHY = True
except Exception:  # noqa: BLE001
    def ref_aes_enc(key, data):
        return wm.AES256ECB(key).encrypt(data)

    def ref_aes_dec(key, data):
        return wm.AES256ECB(key).decrypt(data)

    HAVE_CRYPTOGRAPHY = False


# --------------------------------------------------------------------------- crypto


class CryptoTests(unittest.TestCase):
    def test_md5_crypt_openssl_vectors(self):
        # получены через `openssl passwd -1 -salt ... <пароль>`
        vectors = [
            ("admin", "BQ5hoXV9", "$1$BQ5hoXV9$RxmaDUO33TS7O26yeMHZ81"),
            ("", "BQ5hoXV9", "$1$BQ5hoXV9$CYfwenQM4xmKGmSJJ/al11"),
            ("p@ss wörd", "BQ5hoXV9", "$1$BQ5hoXV9$0Ugh1wy7C466QFIhU5pYw1"),
            ("averyveryverylongpassword_more_than_16_chars", "BQ5hoXV9", "$1$BQ5hoXV9$rQ0/OGU7dRrkIRD9ScKeY."),
            ("admin", "a./Z9", "$1$a./Z9$DnkuSthVBQId.bUsdmhwg1"),
        ]
        for pw, salt, expected in vectors:
            self.assertEqual(wm.md5_crypt(pw, salt), expected, pw)

    @unittest.skipUnless(HAVE_PASSLIB, "passlib не установлен")
    def test_md5_crypt_vs_passlib(self):
        for pw in ("admin", "x", "12345678901234567", "Пароль"):
            for salt in ("abcdefgh", "Zz09./aa", "s"):
                self.assertEqual(wm.md5_crypt(pw, salt), ref_md5_crypt(pw, salt))

    def test_aes_fips197_vector(self):
        key = bytes(range(32))
        pt = bytes.fromhex("00112233445566778899aabbccddeeff")
        aes = wm.AES256ECB(key)
        ct = aes.encrypt(pt)
        self.assertEqual(ct.hex(), "8ea2b7ca516745bfeafc49904b496089")
        self.assertEqual(aes.decrypt(ct), pt)

    def test_sbox(self):
        self.assertEqual(wm._SBOX[0x00], 0x63)
        self.assertEqual(wm._SBOX[0x01], 0x7C)
        self.assertEqual(wm._SBOX[0x53], 0xED)
        self.assertEqual(sorted(wm._SBOX), list(range(256)))

    @unittest.skipUnless(HAVE_CRYPTOGRAPHY, "cryptography не установлен")
    def test_aes_vs_cryptography(self):
        for i in range(20):
            key = hashlib.sha256(b"k%d" % i).digest()
            data = hashlib.sha512(b"d%d" % i).digest() * (i % 3 + 1)
            self.assertEqual(wm.AES256ECB(key).encrypt(data), ref_aes_enc(key, data))
            self.assertEqual(wm.AES256ECB(key).decrypt(data), ref_aes_dec(key, data))


# --------------------------------------------------------------------------- эмулятор асика


class FakeMinerState:
    def __init__(self):
        self.password = "secret"
        self.hashrate_ths = 100.0
        self.factory_ths = 100.0
        self.uptime = 7200
        self.errors = []
        self.boards = [33.3, 33.3, 33.4]
        self.vin = 225.0
        self.fans = (4500, 4400)
        self.frozen = False  # асик «завис»: аптайм и хешрейт не меняются
        self.polls = 0
        self.write_enabled = True
        self.drop_on_reboot = True
        self.commands = []  # принятые привилегированные команды
        self.lock = threading.Lock()


def _v2_handler(state):
    class H(socketserver.BaseRequestHandler):
        def handle(self):
            raw = b""
            self.request.settimeout(2)
            while True:
                try:
                    chunk = self.request.recv(65536)
                except OSError:
                    break
                if not chunk:
                    break
                raw += chunk
                try:
                    req = json.loads(raw.decode())
                    break
                except ValueError:
                    continue
            else:
                return
            reply = self.process(req)
            if reply is not None:
                self.request.sendall(json.dumps(reply).encode() + b"\x00")

        def process(self, req):
            st = state
            if "enc" in req:
                return self.privileged(req)
            cmd = req.get("command") or req.get("cmd")
            if cmd == "summary":
                if not st.frozen:
                    st.polls += 1
                    st.uptime += 60
                jit = (st.polls % 7) * 1000.0 if st.hashrate_ths else 0.0
                return {"STATUS": [{"STATUS": "S", "Msg": "Summary"}], "SUMMARY": [{
                    "Elapsed": st.uptime, "MHS av": st.hashrate_ths * 1e6, "MHS 5s": st.hashrate_ths * 1e6 + jit,
                    "MHS 1m": st.hashrate_ths * 1e6 + jit / 2, "Factory GHS": st.factory_ths * 1000, "Power": 3300,
                    "Env Temp": 25.0, "Fan Speed In": st.fans[0], "Fan Speed Out": st.fans[1]}]}
            if cmd == "devs":
                return {"STATUS": [{"STATUS": "S"}],
                        "DEVS": [{"Slot": i, "MHS 1m": b * 1e6} for i, b in enumerate(st.boards)]}
            if cmd == "get_error_code":
                return {"STATUS": "S", "Code": 133,
                        "Msg": {"error_code": [{str(c): "2026-11-11 03:00:00"} for c in st.errors]}}
            if cmd == "get_psu":
                return {"STATUS": "S", "Code": 131, "Msg": {"name": "P21", "vin": str(int(st.vin * 100))}}
            if cmd == "get_token":
                if not st.write_enabled:
                    return {"STATUS": "E", "When": 1, "Code": 45, "Msg": "can't access write cmd"}
                self.server.token_info = {"time": "1234", "salt": "BQ5hoXV9", "newsalt": "YpgfCkjT"}
                return {"STATUS": "S", "Code": 134, "Msg": self.server.token_info}
            return {"STATUS": "E", "Code": 14, "Msg": "invalid cmd"}

        def privileged(self, req):
            st = state
            ti = getattr(self.server, "token_info", None)
            key = ref_md5_crypt(st.password, ti["salt"]).split("$")[3]
            sign = ref_md5_crypt(key + ti["time"], ti["newsalt"]).split("$")[3]
            aeskey = hashlib.sha256(key.encode()).digest()
            try:
                plain = ref_aes_dec(aeskey, base64.b64decode(req["data"])).rstrip(b"\0")
                cmd = json.loads(plain.decode())
            except Exception:  # noqa: BLE001 — неверный пароль → мусор после расшифровки
                return {"STATUS": "E", "Code": 135, "Msg": "check token err"}
            if cmd.get("token") != sign:
                return {"STATUS": "E", "Code": 135, "Msg": "check token err"}
            with st.lock:
                st.commands.append(cmd)
            if cmd["cmd"] == "reboot":
                st.uptime = 30
                if st.drop_on_reboot:
                    return None  # настоящий асик часто рвёт связь, не ответив
            resp = {"STATUS": "S", "When": 1, "Code": 131, "Msg": "API command OK", "Description": ""}
            text = json.dumps(resp)
            text += "\0" * (-len(text) % 16)
            return {"enc": base64.b64encode(ref_aes_enc(aeskey, text.encode())).decode()}

    return H


def _v3_handler(state):
    class H(socketserver.BaseRequestHandler):
        def handle(self):
            hdr = self.request.recv(4)
            (n,) = struct.unpack("<I", hdr)
            body = b""
            while len(body) < n:
                body += self.request.recv(n - len(body))
            req = json.loads(body.decode())
            reply = self.process(req)
            data = json.dumps(reply).encode()
            self.request.sendall(struct.pack("<I", len(data)) + data)

        def process(self, req):
            st = state
            cmd, param = req.get("cmd"), req.get("param")
            if cmd == "get.device.info":
                if param == "salt":
                    return {"code": 0, "msg": {"salt": "SALT1234"}}
                return {"code": 0, "msg": {"error-code": [{str(c): "t"} for c in st.errors],
                                           "power": {"vin": st.vin}}}
            if cmd == "get.miner.status" and param == "summary":
                if not st.frozen:
                    st.polls += 1
                    st.uptime += 60
                hr = st.hashrate_ths + ((st.polls % 7) * 0.01 if st.hashrate_ths else 0)
                return {"code": 0, "msg": {"summary": {"elapsed": st.uptime, "hash-realtime": hr,
                                                       "factory-hash": st.factory_ths, "power-realtime": 3400,
                                                       "fan-speed-in": st.fans[0], "fan-speed-out": st.fans[1]}}}
            if cmd == "get.miner.status" and param == "edevs":
                return {"code": 0, "msg": {"edevs": [{"hash-average": b} for b in st.boards]}}
            if cmd.startswith("set."):
                tok = base64.b64encode(hashlib.sha256(
                    (cmd + st.password + "SALT1234" + str(req["ts"])).encode()).digest()).decode()[:8]
                if req.get("token") != tok or req.get("account") != "super":
                    return {"code": -2, "msg": "invalid token"}
                with st.lock:
                    st.commands.append(req)
                if cmd == "set.system.reboot":
                    st.uptime = 30
                return {"code": 0, "msg": "ok"}
            return {"code": -1, "msg": "unknown"}

    return H


class _Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_server(handler):
    srv = _Server(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


def closed_port():
    import socket
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class ProtocolV2Tests(unittest.TestCase):
    def setUp(self):
        self.state = FakeMinerState()
        self.srv, self.port = start_server(_v2_handler(self.state))

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def client(self, password="secret"):
        return wm.WhatsminerV2("127.0.0.1", self.port, password, timeout=3)

    def test_snapshot(self):
        self.state.errors = [202, 2010]
        snap = self.client().snapshot()
        self.assertAlmostEqual(snap.hashrate_ths, 100.0, places=2)
        self.assertAlmostEqual(snap.expected_ths, 100.0)
        self.assertEqual(snap.uptime_s, 7260)
        self.assertEqual((snap.fan_in, snap.fan_out), (4500, 4400))
        self.assertEqual(len(snap.hr_sig), 2)
        self.assertEqual(snap.errors, [202, 2010])
        self.assertEqual(len(snap.boards_ths), 3)
        self.assertEqual(snap.vin, 225.0)

    def test_privileged_roundtrip(self):
        r = self.client().check_auth()
        self.assertEqual(r["Msg"], "API command OK")
        self.assertEqual(self.state.commands[-1]["cmd"], "set_led")
        self.assertEqual(self.state.commands[-1]["param"], "auto")

    def test_reboot_without_reply(self):
        self.client().reboot()
        self.assertEqual(self.state.commands[-1]["cmd"], "reboot")

    def test_restart(self):
        self.client().restart()
        self.assertEqual(self.state.commands[-1]["cmd"], "restart_btminer")

    def test_wrong_password(self):
        with self.assertRaises(wm.ApiError) as cm:
            self.client("admin").reboot()
        self.assertIn("пароль", str(cm.exception))
        self.assertEqual(self.state.commands, [])

    def test_write_disabled_hint(self):
        self.state.write_enabled = False
        with self.assertRaises(wm.ApiError) as cm:
            self.client().reboot()
        self.assertIn("WhatsMinerTool", str(cm.exception))

    def test_auto_client_picks_v2(self):
        c = wm.MinerClient("127.0.0.1", port=self.port, port_v3=closed_port(), password="secret", timeout=3)
        snap = c.snapshot()
        self.assertEqual(snap.api, "v2")


class ProtocolV3Tests(unittest.TestCase):
    def setUp(self):
        self.state = FakeMinerState()
        self.state.password = "super"
        self.srv, self.port = start_server(_v3_handler(self.state))

    def tearDown(self):
        self.srv.shutdown()
        self.srv.server_close()

    def test_auto_falls_back_to_v3(self):
        c = wm.MinerClient("127.0.0.1", port=closed_port(), port_v3=self.port, timeout=3)
        self.state.errors = [206]
        snap = c.snapshot()
        self.assertEqual(snap.api, "v3")
        self.assertAlmostEqual(snap.hashrate_ths, 100.0, places=1)
        self.assertEqual((snap.fan_in, snap.fan_out), (4500, 4400))
        self.assertEqual(snap.errors, [206])
        self.assertEqual(snap.boards_ths, [33.3, 33.3, 33.4])
        self.assertEqual(snap.vin, 225.0)
        c.reboot()
        self.assertEqual(self.state.commands[-1]["cmd"], "set.system.reboot")
        c.restart()
        self.assertEqual(self.state.commands[-1]["param"], "restart")

    def test_v3_wrong_password(self):
        c = wm.WhatsminerV3("127.0.0.1", self.port, password="nope", timeout=3)
        with self.assertRaises(wm.ApiError):
            c.reboot()


class BothApisTests(unittest.TestCase):
    """Новая прошивка: открыты оба порта, а запись может работать только по одному API."""

    def setUp(self):
        self.s2, self.s3 = FakeMinerState(), FakeMinerState()
        self.s2.password, self.s3.password = "secret", "super"
        self.srv2, self.p2 = start_server(_v2_handler(self.s2))
        self.srv3, self.p3 = start_server(_v3_handler(self.s3))

    def tearDown(self):
        for srv in (self.srv2, self.srv3):
            srv.shutdown()
            srv.server_close()

    def test_prefers_v3(self):
        c = wm.MinerClient("127.0.0.1", port=self.p2, port_v3=self.p3, password="secret", timeout=3)
        self.assertEqual(c.snapshot().api, "v3")
        c.reboot()
        self.assertEqual([x["cmd"] for x in self.s3.commands], ["set.system.reboot"])
        self.assertEqual(self.s2.commands, [])

    def test_action_falls_back_to_other_api(self):
        self.s3.password = "changed"  # v3 не пускает — должен сработать v2
        c = wm.MinerClient("127.0.0.1", port=self.p2, port_v3=self.p3, password="secret", timeout=3)
        c.snapshot()
        c.reboot()
        self.assertEqual([x["cmd"] for x in self.s2.commands], ["reboot"])

    def test_both_fail_reports_both(self):
        self.s3.password = "changed"
        c = wm.MinerClient("127.0.0.1", port=self.p2, port_v3=self.p3, password="wrong", timeout=3)
        with self.assertRaises(wm.ApiError) as cm:
            c.reboot()
        self.assertIn("API v3", str(cm.exception))
        self.assertIn("API v2", str(cm.exception))


class ParsingTests(unittest.TestCase):
    def test_broken_error_code_list(self):
        raw = b'{"STATUS":"S","When":1,"Code":133,"Msg":{"error_code":["110":"2021-01-01","203":"2021-01-01"]},' \
              b'"Description":""}\x00'
        d = wm.parse_v2_json(raw)
        self.assertEqual(wm.parse_error_codes(d["Msg"]["error_code"]), [110, 203])

    def test_error_formats(self):
        self.assertEqual(wm.parse_error_codes(["202", 206]), [202, 206])
        self.assertEqual(wm.parse_error_codes([{"202": "t", "reason": "x"}]), [202])
        self.assertEqual(wm.parse_error_codes(None), [])

    def test_volts(self):
        self.assertEqual(wm._volts("22500"), 225.0)
        self.assertEqual(wm._volts(225), 225.0)
        self.assertEqual(wm._volts("231.5"), 231.5)
        self.assertIsNone(wm._volts(None))
        self.assertIsNone(wm._volts("0"))

    def test_describe(self):
        self.assertIn("напряжен", wm.describe_error(202))
        self.assertIn("пулы", wm.describe_error(2010))
        self.assertIn("слот 1", wm.describe_error(531))
        self.assertTrue(wm.is_power_error(206))
        self.assertFalse(wm.is_power_error(2010))


# --------------------------------------------------------------------------- логика сторожа


class FakeClock:
    def __init__(self):
        self.t = time.time() - 6 * 3600  # «сейчас минус 6 часов», чтобы отчёт за сутки видел события

    def __call__(self):
        return self.t


class FakeClient:
    """Живой асик: аптайм растёт, хешрейт чуть «гуляет». frozen=True — статистика застыла."""

    def __init__(self):
        self.snap = wm.Snapshot(api="v2", hashrate_ths=100, expected_ths=100, uptime_s=7200,
                                boards_ths=[33, 33, 34], fan_in=4500, fan_out=4400)
        self.raise_exc = None
        self.calls = []
        self.fail_actions = False
        self.reset_on_action = True  # False — «ребут не помог», аптайм не сбрасывается
        self.frozen = False
        self.n = 0

    def snapshot(self):
        if self.raise_exc:
            raise self.raise_exc
        if not self.frozen:
            self.n += 1
            if self.snap.uptime_s is not None:
                self.snap.uptime_s += 60
        snap = wm.Snapshot(**self.snap.__dict__)
        hr = self.snap.hashrate_ths or 0.0
        snap.hr_sig = (hr * 1e6 + (self.n % 7) * 1000 if hr else 0.0,)
        return snap

    def _act(self, name):
        self.calls.append(name)
        if self.fail_actions:
            raise wm.ApiError("can't access write cmd")
        if self.reset_on_action:
            self.snap.uptime_s = 30
            self.frozen = False

    def reboot(self):
        self._act("reboot")
        return {}

    def restart(self):
        self._act("restart")
        return {}


class CollectNotifier(wm.Notifier):
    def __init__(self):
        super().__init__()
        self.msgs = []

    def send(self, text):
        self.msgs.append(text)


class WatchdogTests(unittest.TestCase):
    def make(self, **kw):
        miner_kw = {k: kw.pop(k) for k in list(kw)
                    if k in ("actions", "expected_ths", "min_hashrate_pct", "min_fan_rpm", "fault_codes")}
        st = wm.Settings(interval=60, grace_period=900, bad_checks=3, action_cooldown=600,
                         max_actions_per_hour=3, unreachable_checks=5, **kw)
        self.clock = FakeClock()
        self.client = FakeClient()
        self.notes = CollectNotifier()
        self.tmp = tempfile.TemporaryDirectory()
        self.events = wm.EventLog(os.path.join(self.tmp.name, "ev.csv"))
        miner = wm.MinerConf(name="m1", host="10.0.0.1", **miner_kw)
        self.wd = wm.Watchdog(st, [miner], self.notes, self.events, clock=self.clock,
                              client_factory=lambda m, s: self.client)
        return self.wd

    def tearDown(self):
        if hasattr(self, "tmp"):
            self.tmp.cleanup()

    def tick(self, n=1, step=60):
        for _ in range(n):
            self.wd.check_all()
            self.clock.t += step

    def events_list(self):
        import csv
        if not os.path.exists(self.events.path):
            return []
        with open(self.events.path, encoding="utf-8") as f:
            return [r["event"] for r in csv.DictReader(f)]

    def test_healthy_no_action(self):
        self.make()
        self.tick(10)
        self.assertEqual(self.client.calls, [])
        self.assertEqual(self.notes.msgs, [])

    def test_power_fault_reboot_and_recovery(self):
        self.make()
        self.tick(2)
        self.client.snap.hashrate_ths = 0
        self.client.snap.errors = [202]
        self.client.snap.boards_ths = [0, 0, 0]
        self.client.snap.vin = 198.0
        self.tick(2)
        self.assertEqual(self.client.calls, [])  # 2 плохие проверки — ещё ждём
        self.tick(1)
        self.assertEqual(self.client.calls, ["reboot"])
        self.assertIn("202", self.notes.msgs[-1])
        self.assertIn("напряжения", self.notes.msgs[-1])
        self.assertIn("Вход БП: 198 В", self.notes.msgs[-1])
        # перезагрузка: аптайм маленький, хешрейта ещё нет — это прогрев, не трогаем
        self.tick(8)
        self.assertEqual(self.client.calls, ["reboot"])
        # асик поднялся
        self.client.snap.uptime_s = 1000
        self.client.snap.hashrate_ths = 99
        self.client.snap.boards_ths = [33, 33, 33]
        self.client.snap.errors = []
        self.client.snap.vin = 226.0
        self.tick(1)
        self.assertIn("снова хеширует", self.notes.msgs[-1])
        self.assertEqual(self.events_list(), ["fault", "action", "recovered"])
        rep = wm.build_report(self.events.path, days=1)
        self.assertIn("m1: падений 1, перезагрузок 1", rep)
        self.assertIn("202", rep)
        self.assertIn("вход БП при падениях: 198–198 В, после восстановления: 226–226 В", rep)

    def test_rate_limit_and_give_up(self):
        self.make()
        self.client.snap.hashrate_ths = 0
        self.client.reset_on_action = False  # перезагрузки не помогают
        self.tick(60)
        self.assertEqual(len(self.client.calls), 3)
        give_up = [m for m in self.notes.msgs if "⛔" in m]
        self.assertEqual(len(give_up), 1)

    def test_escalation_restart_then_reboot(self):
        self.make(actions=["restart", "reboot"])
        self.client.snap.hashrate_ths = 0
        self.client.reset_on_action = False
        self.tick(30)
        self.assertEqual(self.client.calls[:2], ["restart", "reboot"])

    def test_crash_loop_in_warmup_is_detected(self):
        self.make()
        self.client.snap.hashrate_ths = 0
        for i in range(20):  # майнер сам перезапускается каждые 5 минут и не хеширует
            if not self.client.calls:
                self.client.snap.uptime_s = 30 + 60 * (i % 5)
            self.tick(1)
            if i == 14:
                self.assertEqual(self.client.calls, [])
        self.assertEqual(self.client.calls, ["reboot"])
        self.assertIn("постоянно перезапускается", self.notes.msgs[-1])

    def test_frozen_stats_after_error(self):
        # асик ушёл в ошибку по БП: на экране последний хешрейт, вентиляторы 250 об/мин
        self.make()
        self.tick(3)
        self.client.frozen = True
        self.client.snap.errors = [202, 206]
        self.client.snap.fan_in, self.client.snap.fan_out = 250, 300
        self.tick(2)
        self.assertEqual(self.client.calls, [])
        self.tick(1)  # 3-й плохой опрос подряд — ребут
        self.assertEqual(self.client.calls, ["reboot"])
        msg = self.notes.msgs[-1]
        self.assertIn("майнер завис", msg)
        self.assertIn("250/300", msg)
        self.assertIn("206", msg)
        # после ребута снова живой
        self.client.snap.errors = []
        self.client.snap.fan_in, self.client.snap.fan_out = 4500, 4400
        self.tick(20)
        self.assertEqual(self.client.calls, ["reboot"])
        self.assertIn("снова хеширует", self.notes.msgs[-1])

    def test_frozen_hashrate_with_running_uptime(self):
        self.make()
        self.tick(2)

        def frozen_hr():
            self.client.snap.uptime_s += 60
            return wm.Snapshot(**dict(self.client.snap.__dict__, hr_sig=(1.0e8, 1.0e8)))

        self.client.snapshot = frozen_hr
        self.tick(5)
        self.assertEqual(self.client.calls, ["reboot"])
        self.assertIn("хешрейт не меняется", self.notes.msgs[-1])

    def test_short_interval_does_not_count_as_frozen(self):
        # при опросе раз в 5 с 5s-хешрейт может не успеть обновиться — это не зависание
        self.make()

        def live_but_slow_refresh():
            self.client.snap.uptime_s += 5
            sig = (1.0e8 + (int(self.clock.t) // 20) * 1000,)
            return wm.Snapshot(**dict(self.client.snap.__dict__, hr_sig=sig))

        self.client.snapshot = live_but_slow_refresh
        self.tick(60, step=5)
        self.assertEqual(self.client.calls, [])

    def test_slow_fans_with_live_looking_hashrate(self):
        self.make()
        self.client.snap.fan_in, self.client.snap.fan_out = 250, 280
        self.tick(3)
        self.assertEqual(self.client.calls, ["reboot"])
        self.assertIn("вентиляторы еле крутятся", self.notes.msgs[-1])

    def test_no_fans_hydro_is_ok(self):
        self.make()
        self.client.snap.fan_in, self.client.snap.fan_out = 0, 0
        self.tick(10)
        self.assertEqual(self.client.calls, [])

    def test_fan_check_can_be_disabled(self):
        self.make(min_fan_rpm=0)
        self.client.snap.fan_in, self.client.snap.fan_out = 250, 280
        self.tick(10)
        self.assertEqual(self.client.calls, [])

    def test_fault_codes(self):
        self.make(fault_codes=[206])
        self.client.snap.errors = [206]
        self.tick(3)
        self.assertEqual(self.client.calls, ["reboot"])
        self.assertIn("fault_codes", self.notes.msgs[-1])

    def test_low_voltage_waits_then_reboots(self):
        # как в реальном логе: 206, vin 199.75 В — ребутить бесполезно, пока сеть не поднимется
        self.make(min_vin=205)
        self.client.frozen = True
        self.client.snap.errors = [206]
        self.client.snap.fan_in, self.client.snap.fan_out = 250, 300
        self.client.snap.vin = 199.75
        self.tick(20)
        self.assertEqual(self.client.calls, [])
        waits = [m for m in self.notes.msgs if "⚡" in m]
        self.assertEqual(len(waits), 1)
        self.assertIn("200 В", waits[0])
        self.client.snap.vin = 218.0  # напряжение вернулось
        self.tick(1)
        self.assertEqual(self.client.calls, ["reboot"])
        self.assertIn("напряжение вернулось", self.notes.msgs[-1])
        self.assertIn("low_voltage_wait", self.events_list())

    def test_low_voltage_wait_is_capped(self):
        self.make(min_vin=205, max_vin_wait=1800)
        self.client.snap.hashrate_ths = 0
        self.client.snap.vin = 199.0
        self.tick(30)
        self.assertEqual(self.client.calls, [])
        self.tick(5)
        self.assertEqual(self.client.calls, ["reboot"])
        self.assertIn("так и не поднялось", self.notes.msgs[-1])

    def test_dead_board(self):
        self.make()
        self.client.snap.hashrate_ths = 66
        self.client.snap.boards_ths = [33, 0, 33]
        self.tick(3)
        self.assertEqual(self.client.calls, ["reboot"])
        self.assertIn("слотах 1", self.notes.msgs[-1])

    def test_low_hashrate_pct(self):
        self.make(min_hashrate_pct=80, expected_ths=110)
        self.client.snap.hashrate_ths = 80
        self.tick(3)
        self.assertEqual(self.client.calls, ["reboot"])

    def test_dry_run(self):
        self.make(dry_run=True)
        self.client.snap.hashrate_ths = 0
        self.tick(3)
        self.assertEqual(self.client.calls, [])
        self.assertIn("dry-run", self.notes.msgs[-1])

    def test_action_failure_notified_once(self):
        self.make()
        self.client.fail_actions = True
        self.client.snap.hashrate_ths = 0
        self.tick(40)
        self.assertEqual(len(self.client.calls), 3)
        fails = [m for m in self.notes.msgs if "❌" in m]
        self.assertEqual(len(fails), 1)
        self.assertIn("can't access write cmd", fails[0])

    def test_unreachable_alert_and_back(self):
        self.make()
        self.client.raise_exc = wm.Unreachable("10.0.0.1:4028 — нет связи")
        self.tick(4)
        self.assertEqual(self.notes.msgs, [])
        self.tick(10)
        alerts = [m for m in self.notes.msgs if "📵" in m]
        self.assertEqual(len(alerts), 1)
        self.client.raise_exc = None
        self.tick(1)
        self.assertIn("снова на связи", self.notes.msgs[-1])

    def test_unreachable_right_after_reboot_is_quiet(self):
        self.make()
        self.client.snap.hashrate_ths = 0
        self.tick(3)
        self.assertEqual(self.client.calls, ["reboot"])
        self.client.raise_exc = wm.Unreachable("перезагружается")
        self.tick(8)  # 8 минут < action_cooldown
        self.assertFalse(any("📵" in m for m in self.notes.msgs))

    def test_unreachable_hook(self):
        flag = os.path.join(tempfile.gettempdir(), "wm_hook_%d" % os.getpid())
        if os.path.exists(flag):
            os.remove(flag)
        cmd = '"%s" -c "open(r\'%s\', \'w\').write(\'{name} {host}\')"' % (sys.executable, flag)
        self.make(on_unreachable=cmd)
        self.client.raise_exc = wm.Unreachable("нет связи")
        self.tick(6)
        with open(flag) as f:
            self.assertEqual(f.read(), "m1 10.0.0.1")
        os.remove(flag)
        self.assertTrue(any("🔌" in m for m in self.notes.msgs))


class EndToEndTests(unittest.TestCase):
    """Сторож + настоящий клиент + эмулятор асика по TCP."""

    def test_fault_triggers_encrypted_reboot(self):
        state = FakeMinerState()
        srv, port = start_server(_v2_handler(state))
        try:
            st = wm.Settings(bad_checks=2, timeout=3)
            miner = wm.MinerConf(name="m1", host="127.0.0.1", port=port, port_v3=closed_port(),
                                 password="secret")
            clock = FakeClock()
            notes = CollectNotifier()
            wd = wm.Watchdog(st, [miner], notes, wm.EventLog(""), clock=clock)
            wd.check_all()
            state.hashrate_ths = 0
            state.errors = [206]
            for _ in range(2):
                clock.t += 60
                wd.check_all()
            self.assertEqual([c["cmd"] for c in state.commands], ["reboot"])
            self.assertIn("206", notes.msgs[-1])
        finally:
            srv.shutdown()
            srv.server_close()

    def test_frozen_miner_is_rebooted(self):
        state = FakeMinerState()
        srv, port = start_server(_v2_handler(state))
        try:
            st = wm.Settings(bad_checks=2, timeout=3)
            miner = wm.MinerConf(name="m1", host="127.0.0.1", port=port, port_v3=closed_port(),
                                 password="secret")
            clock = FakeClock()
            notes = CollectNotifier()
            wd = wm.Watchdog(st, [miner], notes, wm.EventLog(""), clock=clock)
            for _ in range(3):
                wd.check_all()
                clock.t += 60
            self.assertEqual(state.commands, [])  # живой асик не трогаем
            state.frozen = True
            state.errors = [206, 202]
            state.fans = (250, 300)
            for _ in range(4):
                wd.check_all()
                clock.t += 60
            self.assertEqual([c["cmd"] for c in state.commands], ["reboot"])
            self.assertIn("майнер завис", notes.msgs[-1])
        finally:
            srv.shutdown()
            srv.server_close()


class FakeLuci:
    """Похоже на веб-морду Whatsminer (OpenWrt LuCI): вход, stok, меню, статус с автообновлением."""

    STOK = "abc123def456"
    SID = "SECRETSESSIONID42"
    CSRF = "CSRFTOKEN1234567890"

    def __init__(self):
        import http.server
        fake = self
        self.requests = []

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body, ctype="text/html", headers=None):
                data = body.encode()
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(data)

            def authed(self):
                return ("sysauth=%s" % fake.SID) in (self.headers.get("Cookie") or "")

            def do_GET(self):
                fake.requests.append(("GET", self.path))
                pre = "/cgi-bin/luci/;stok=%s" % fake.STOK
                if self.path == "/":
                    return self._send(302, "", headers={"Location": "/cgi-bin/luci"})
                if self.path == "/cgi-bin/luci":
                    return self._send(200, "<html><head><title>WhatsMiner - LuCI</title></head><body>"
                                      "<form method='post' action='/cgi-bin/luci'>"
                                      "<input type='text' name='luci_username' value='admin'>"
                                      "<input type='password' name='luci_password'>"
                                      "<input type='submit' value='Login'></form></body></html>")
                if not self.authed():
                    return self._send(403, "denied")
                if self.path == pre + "/admin/status/overview":
                    return self._send(200, "<html><title>Overview</title><body>"
                                      "<a href='%s/admin/status/btminerstatus'>Miner Status</a>"
                                      "<a href='%s/admin/system/reboot'>Reboot</a>"
                                      "<a href='%s/admin/system/flashops'>Upgrade</a>"
                                      "<a href='%s/admin/logout'>Logout</a>"
                                      "<p>Model WhatsMiner M30S++_VH95</p></body></html>" % (pre, pre, pre, pre))
                if self.path == pre + "/admin/status/btminerstatus":
                    return self._send(200, "<html><title>Miner Status</title><body><table><tr><td>MHS av</td>"
                                      "<td>104000000</td></tr></table><script>XHR.poll(5, '%s/admin/status/"
                                      "btminerstatus?status=1', null, function(x, st) { update(st); });"
                                      "</script></body></html>" % pre)
                if self.path == pre + "/admin/status/btminerstatus?status=1":
                    return self._send(200, '{"summary":{"MHS 5s":"103512345.1","Fan Speed In":"280"},'
                                      '"error_code":["206"]}', ctype="application/json")
                if self.path == pre + "/admin/system/reboot":
                    return self._send(200, "<html><title>Reboot</title><body>"
                                      "<input type='button' value='Perform reboot' onclick='reboot()'>"
                                      "<script>var token = '%s'; function reboot(){ (new XHR()).post("
                                      "'/cgi-bin/luci/admin/system/reboot/call', {token: token}); }</script>"
                                      "</body></html>" % fake.CSRF)
                return self._send(404, "not found")

            def do_POST(self):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n).decode()
                fake.requests.append(("POST", self.path))
                if self.path == "/cgi-bin/luci" and "luci_password=s3cret%21" in body:
                    return self._send(302, "", headers={
                        "Location": "/cgi-bin/luci/;stok=%s/admin/status/overview" % fake.STOK,
                        "Set-Cookie": "sysauth=%s; path=/" % fake.SID})
                return self._send(403, "bad login")

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


class WebProbeTests(unittest.TestCase):
    def test_probe_is_safe_and_redacted(self):
        fake = FakeLuci()
        try:
            with tempfile.TemporaryDirectory() as d:
                out = os.path.join(d, "probe.txt")
                import contextlib
                import io
                with contextlib.redirect_stdout(io.StringIO()):
                    wm.cmd_web_probe(fake.url, "admin", "s3cret!", out)
                with open(out, encoding="utf-8") as f:
                    report = f.read()
        finally:
            fake.close()
        paths = [p for _, p in fake.requests]
        # нашёл статус, адрес автообновления и страницу перезагрузки
        self.assertIn("Miner Status", report)
        self.assertIn("btminerstatus?status=1", report)
        self.assertIn("Fan Speed In", report)
        self.assertIn("reboot/call", report)  # адрес кнопки записан...
        self.assertTrue(any(p.endswith("btminerstatus?status=1") for p in paths))
        # ...но опасные адреса никогда не открывались
        for p in paths:
            self.assertNotIn("reboot/call", p)
            self.assertNotIn("flashops", p)
            self.assertNotIn("logout", p)
        # секреты скрыты
        for secret in ("s3cret!", FakeLuci.SID, FakeLuci.STOK, FakeLuci.CSRF):
            self.assertNotIn(secret, report)


class FakeWebMiner:
    """Веб-морда Whatsminer на старом LuCI: вход → ;stok=, таблицы статуса, System → Reboot."""

    STOK = "0123456789abcdef0123456789abcdef"
    SID = "f00dfeedf00dfeedf00dfeedf00dfeed"
    TOKEN = "c0ffee00c0ffee00c0ffee00c0ffee00"

    def __init__(self, password="test-pass", reboot_style="old", with_data=True):
        import http.server
        fake = self
        self.password, self.reboot_style, self.with_data = password, reboot_style, with_data
        self.requests, self.reboots, self.logins = [], 0, 0
        self.session_valid = False
        self.uptime, self.hashrate, self.fans, self.frozen, self.polls = 15134, 104.1, (4500, 4400), False, 0

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body="", headers=None, ctype="text/html"):
                data = body.encode()
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(data)

            def login_page(self):
                return self._send(200, "<html><body><h2>Authorization Required</h2><form method='post' "
                                  "action='/cgi-bin/luci'><input name='luci_username' value='admin'>"
                                  "<input type='password' name='luci_password'><input type='submit' "
                                  "value='Login'></form></body></html>")

            def ok_session(self):
                return fake.session_valid and ("sysauth=" + fake.SID) in (self.headers.get("Cookie") or "") \
                    and (";stok=%s/" % fake.STOK) in self.path + "/"

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
                fake.requests.append(("POST", self.path, body))
                if self.path == "/cgi-bin/luci":
                    if ("luci_password=" + fake.password) in body:
                        fake.logins += 1
                        fake.session_valid = True
                        return self._send(302, headers={
                            "Location": "/cgi-bin/luci/;stok=%s" % fake.STOK,
                            "Set-Cookie": "sysauth=%s; path=/cgi-bin/luci/;stok=%s" % (fake.SID, fake.STOK)})
                    return self.login_page()
                if self.path.endswith("/admin/system/reboot/call") and self.ok_session() \
                        and ("token=" + fake.TOKEN) in body and fake.reboot_style == "new":
                    fake.reboots += 1
                    return self._send(200, "{}", ctype="application/json")
                return self._send(403, "forbidden")

            def do_GET(self):
                fake.requests.append(("GET", self.path, ""))
                if not self.ok_session():
                    return self.login_page()
                pre = "/cgi-bin/luci/;stok=%s" % fake.STOK
                path = self.path
                if path in (pre, pre + "/"):
                    return self._send(302, headers={"Location": pre + "/admin/status/overview"})
                if path == pre + "/admin/status/overview":
                    return self._send(200, "<html><title>Overview</title><ul class='nav'>"
                                      "<li><a href='%s/admin/status/overview'>Overview</a></li>"
                                      "<li><a href='%s/admin/status/btminerstatus'>Miner Status</a></li>"
                                      "<li><a href='%s/admin/system/reboot'>Reboot</a></li>"
                                      "<li><a href='%s/admin/logout'>Logout</a></li></ul>"
                                      "<table><tr><td>Model</td><td>WhatsMiner M30S++_VH95</td></tr></table>"
                                      "</html>" % (pre, pre, pre, pre))
                if path == pre + "/admin/status/btminerstatus":
                    if not fake.with_data:
                        return self._send(200, "<html><title>Miner Status</title><p>loading…</p></html>")
                    if not fake.frozen:
                        fake.polls += 1
                        fake.uptime += 60
                    jit = (fake.polls % 7) * 1000 if fake.hashrate else 0
                    mhs = fake.hashrate * 1e6 + jit
                    up = fake.uptime
                    el = "%dd %dh %dm %ds" % (up // 86400, up % 86400 // 3600, up % 3600 // 60, up % 60)
                    b = mhs / 3
                    return self._send(200, (
                        "<html><title>Miner Status</title><h3>Summary</h3><table class='cbi-section-table'>"
                        "<tr><th>Elapsed</th><th>MHS av</th><th>MHS 5s</th><th>MHS 1m</th><th>Fan Speed In</th>"
                        "<th>Fan Speed Out</th><th>Power</th><th>Factory GHS</th></tr>"
                        "<tr><td>%s</td><td>%.2f</td><td>%.2f</td><td>%.2f</td><td>%d</td><td>%d</td><td>3412</td>"
                        "<td>104000</td></tr></table><h3>Devices</h3><table>"
                        "<tr><th>Slot</th><th>Temperature</th><th>MHS av</th><th>MHS 1m</th></tr>"
                        "<tr><td>0</td><td>67.1</td><td>%.2f</td><td>%.2f</td></tr>"
                        "<tr><td>1</td><td>58.2</td><td>%.2f</td><td>%.2f</td></tr>"
                        "<tr><td>2</td><td>65.4</td><td>%.2f</td><td>%.2f</td></tr></table>"
                        "<h3>Pools</h3><table><tr><th>URL</th><th>Status</th><th>Accepted</th></tr>"
                        "<tr><td>stratum+tcp://pool.example:3333</td><td>Alive</td><td>1234</td></tr></table>"
                        "</html>") % (el, mhs, mhs, mhs, fake.fans[0], fake.fans[1], b, b, b, b, b, b))
                if path == pre + "/admin/system/reboot":
                    if fake.reboot_style == "new":
                        return self._send(200, "<html><title>Reboot</title><input type='button' "
                                          "value='Perform reboot' onclick='reboot()'><script>function reboot(){"
                                          "XHR.post('%s/admin/system/reboot/call', { token: '%s' });}</script>"
                                          "</html>" % (pre, fake.TOKEN))
                    return self._send(200, "<html><title>Reboot</title><p><a href='%s/admin/system/reboot"
                                      "?reboot=1'>Perform reboot</a></p></html>" % pre)
                if path == pre + "/admin/system/reboot?reboot=1" and fake.reboot_style == "old":
                    fake.reboots += 1
                    fake.uptime = 30
                    return self._send(200, "<html>Rebooting…</html>")
                return self._send(404, "not found")

        self.srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def close(self):
        self.srv.shutdown()
        self.srv.server_close()


class WebClientTests(unittest.TestCase):
    def make(self, **kw):
        self.fake = FakeWebMiner(**kw)
        self.addCleanup(self.fake.close)
        return wm.WhatsminerWeb(self.fake.url + "/cgi-bin/luci", "admin", "test-pass", timeout=5)

    def test_snapshot_from_status_tables(self):
        c = self.make()
        snap = c.snapshot()
        self.assertEqual(snap.api, "web")
        self.assertAlmostEqual(snap.hashrate_ths, 104.1, places=1)
        self.assertAlmostEqual(snap.expected_ths, 104.0)
        self.assertEqual(snap.uptime_s, 15194)
        self.assertEqual((snap.fan_in, snap.fan_out), (4500, 4400))
        self.assertEqual(len(snap.boards_ths), 3)
        self.assertTrue(snap.hr_sig)
        self.assertEqual(self.fake.reboots, 0)

    def test_reboot_old_luci(self):
        c = self.make(reboot_style="old")
        c.snapshot()
        c.reboot()
        self.assertEqual(self.fake.reboots, 1)

    def test_reboot_new_luci_with_token(self):
        c = self.make(reboot_style="new")
        c.reboot()
        self.assertEqual(self.fake.reboots, 1)

    def test_check_auth_does_not_reboot(self):
        c = self.make()
        self.assertIn("найдена", c.check_auth()["Msg"])
        self.assertEqual(self.fake.reboots, 0)
        self.assertFalse(any("reboot=1" in p for _, p, _ in self.fake.requests))

    def test_wrong_password(self):
        self.fake = FakeWebMiner(password="other")
        self.addCleanup(self.fake.close)
        c = wm.WhatsminerWeb(self.fake.url, "admin", "test-pass", timeout=5)
        with self.assertRaises(wm.ApiError) as cm:
            c.snapshot()
        self.assertIn("пароль", str(cm.exception))

    def test_session_expiry_relogin(self):
        c = self.make()
        c.snapshot()
        self.fake.session_valid = False  # сессия протухла
        c.snapshot()
        self.assertEqual(self.fake.logins, 2)

    def test_no_data_is_nodata(self):
        c = self.make(with_data=False)
        with self.assertRaises(wm.NoData):
            c.snapshot()

    def test_unreachable(self):
        c = wm.WhatsminerWeb("http://127.0.0.1:%d" % closed_port(), "admin", "x", timeout=3)
        with self.assertRaises(wm.Unreachable):
            c.snapshot()

    def test_duration_parsing(self):
        self.assertEqual(wm._parse_duration("4h 12m 14s"), 15134)
        self.assertEqual(wm._parse_duration("1d 0h 0m 5s"), 86405)
        self.assertEqual(wm._parse_duration("04:12:14"), 15134)
        self.assertEqual(wm._parse_duration("15134"), 15134)
        self.assertIsNone(wm._parse_duration("n/a"))


class WebWatchdogTests(unittest.TestCase):
    def run_wd(self, fake, ticks, miner_kw=None):
        st = wm.Settings(bad_checks=3, timeout=5)
        miner = wm.MinerConf(name="m1", host="127.0.0.1", password="test-pass", **(miner_kw or {}))
        wm._set_web(miner, fake.url)
        clock = FakeClock()
        notes = CollectNotifier()
        wd = wm.Watchdog(st, [miner], notes, wm.EventLog(""), clock=clock)
        for step in ticks:
            step(fake)
            wd.check_all()
            clock.t += 60
        return notes

    def test_frozen_miner_rebooted_via_web(self):
        fake = FakeWebMiner()
        self.addCleanup(fake.close)

        def healthy(f):
            pass

        def frozen(f):  # ошибка по БП: цифры застыли, вентиляторы еле крутятся
            f.frozen, f.fans = True, (250, 300)

        notes = self.run_wd(fake, [healthy] * 3 + [frozen] * 3)
        self.assertEqual(fake.reboots, 1)
        self.assertIn("майнер завис", notes.msgs[-1])

    def test_unparseable_page_never_reboots(self):
        fake = FakeWebMiner(with_data=False)
        self.addCleanup(fake.close)
        notes = self.run_wd(fake, [lambda f: None] * 15)
        self.assertEqual(fake.reboots, 0)
        self.assertEqual(len([m for m in notes.msgs if "⚠️" in m]), 1)


class ConfigTests(unittest.TestCase):
    def test_load(self):
        ini = """
[watchdog]
interval = 30
password = pw1
min_vin = 205
actions = restart, reboot

[telegram]
token = 123:ABC
chat_id = 42
daily_report_hour = 9

[miners]
asic-01 = 192.168.1.101
asic-02 = 192.168.1.102
tochka1 = https://203.0.113.5:1002

[miner:asic-02]
password = p#ss;word
fault_codes = 206, 202
min_fan_rpm = 0
expected_ths = 110
enabled = no

[miner:asic-03]
host = 192.168.1.103
api = v3
"""
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "config.ini")
            with open(p, "w", encoding="utf-8") as f:
                f.write(ini)
            st, miners = wm.load_config(p)
        self.assertEqual(st.interval, 30)
        self.assertEqual(st.min_vin, 205)
        self.assertEqual(st.telegram_token, "123:ABC")
        self.assertEqual(st.daily_report_hour, 9)
        self.assertTrue(st.events_file.endswith("wm_events.csv"))
        by = {m.name: m for m in miners}
        self.assertEqual(set(by), {"asic-01", "asic-02", "asic-03", "tochka1"})
        self.assertEqual(by["tochka1"].api, "web")
        self.assertEqual(by["tochka1"].web_url, "https://203.0.113.5:1002")
        self.assertEqual(by["tochka1"].host, "203.0.113.5")
        self.assertEqual(by["tochka1"].password, "pw1")
        self.assertEqual(by["asic-01"].password, "pw1")
        self.assertEqual(by["asic-01"].actions, ["restart", "reboot"])
        self.assertEqual(by["asic-02"].password, "p#ss;word")
        self.assertEqual(by["asic-02"].expected_ths, 110)
        self.assertEqual(by["asic-02"].fault_codes, [206, 202])
        self.assertEqual(by["asic-02"].min_fan_rpm, 0)
        self.assertEqual(by["asic-01"].min_fan_rpm, 600)
        self.assertFalse(by["asic-02"].enabled)
        self.assertEqual(by["asic-03"].api, "v3")
        self.assertEqual(by["asic-03"].host, "192.168.1.103")

    def test_bad_action(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "config.ini")
            with open(p, "w", encoding="utf-8") as f:
                f.write("[watchdog]\nactions = explode\n[miners]\na = 1.2.3.4\n")
            with self.assertRaises(wm.ConfigError):
                wm.load_config(p)

    def test_example_config_loads(self):
        here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.example.ini")
        st, miners = wm.load_config(here)
        self.assertTrue(miners)


if __name__ == "__main__":
    unittest.main()
