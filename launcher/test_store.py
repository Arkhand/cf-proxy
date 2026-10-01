"""
Manual test of the Credential Manager store (writes and deletes a dummy entry).

    cd launcher && python test_store.py
"""
import subprocess
import sys
from pathlib import Path

from cfproxy_launcher import store

API, USER = "https://API.selftest.invalid/", "Launcher-Selftest@example.com"
SECRET = 'p"a\'ss %PATH% & ^| ñandú'
failed = 0


def ok(name, cond):
    global failed
    print(("PASS  " if cond else "FAIL  ") + name)
    failed += 0 if cond else 1


ok("key matches cf-target's format", store.cred_key(API, USER) == "cf-target:https://api.selftest.invalid:launcher-selftest@example.com")
store.set_password(API, USER, SECRET)
ok("round trip", store.get_password(API.lower(), USER.lower()) == SECRET)

# Same entry readable from cf-target (Node), when it sits next to CF-proxy.
cft = Path(__file__).resolve().parents[2] / "cf-target" / "lib" / "credstore.js"
if cft.exists():
    js = f"process.stdout.write(require({str(cft)!r}).getPassword({API!r}, {USER!r}) === {SECRET!r} ? 'same' : 'different')"
    out = subprocess.run(["node", "-e", js], capture_output=True, text=True, encoding="utf-8").stdout
    ok("cf-target reads what the launcher wrote", out == "same")
    # And the other way: what cf-target writes (through PowerShell) the launcher reads byte for byte.
    js = f"require({str(cft)!r}).setPassword({API!r}, {USER!r}, {SECRET!r})"
    subprocess.run(["node", "-e", js], check=True)
    ok("the launcher reads what cf-target wrote", store.get_password(API, USER) == SECRET)

store.set_password(API, USER, "")
ok("empty secret deletes", store.get_password(API, USER) == "")
sys.exit(1 if failed else 0)
