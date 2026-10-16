#!/usr/bin/env bash
# Install as the ordinary account that will own CoS, after installing its DEB.
set -euo pipefail
if [[ $(id -u) == 0 ]]; then echo 'Run this as the service user, not root.' >&2; exit 1; fi
test -x '/opt/Chat On Steroids/chat-on-steroids'
for program in Xvfb xauth xdpyinfo gnome-keyring-daemon dbus-run-session openbox x11vnc websockify python3; do
  command -v "$program" >/dev/null || { echo "Missing $program; see docs/openai-api.md" >&2; exit 1; }
done
config="$HOME/.config/cos-service"
units="$HOME/.config/systemd/user"
mkdir -p "$config/chat-on-steroids" "$units" "$HOME/.local/lib/cos-service" "$HOME/.local/bin"
chmod 700 "$config" "$config/chat-on-steroids"
# Optional Chrome for Testing companion, isolated from every existing browser profile.
# Its unpacked-extension support is needed for CoS's Google SSO handoff.
if [[ -n ${COS_CHROME_BINARY:-} ]]; then
  test -x "$COS_CHROME_BINARY"
  mkdir -p "$HOME/.local/lib/cos-service/browser" "$HOME/.local/share/cos-service"
  if [[ ! -e "$HOME/.local/share/cos-service/chrome-runtime" ]]; then
    cp -a "$(dirname "$COS_CHROME_BINARY")" "$HOME/.local/share/cos-service/chrome-runtime"
  fi
  cat >"$HOME/.local/lib/cos-service/browser/google-chrome" <<'CHROME'
#!/usr/bin/env bash
exec "$HOME/.local/share/cos-service/chrome-runtime/chrome" \
  --user-data-dir="$HOME/.local/share/cos-service/chrome-profile" \
  --load-extension='/opt/Chat On Steroids/resources/extension' \
  --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
  --no-first-run --no-default-browser-check --disable-gpu --password-store=gnome-libsecret "$@"
CHROME
  chmod 700 "$HOME/.local/lib/cos-service/browser/google-chrome"
fi
python3 - <<'PY'
import json, os, pathlib, secrets, subprocess
root = pathlib.Path.home() / '.config/cos-service'
for name, value in [('keyring-password', secrets.token_urlsafe(32)), ('vnc-password', secrets.token_hex(4))]:
    file = root / name
    try:
        with file.open('x') as output:
            os.chmod(file, 0o600)
            output.write(value + '\n')
    except FileExistsError:
        pass
authority = root / 'Xauthority'
if not authority.exists():
    authority.touch(mode=0o600)
    subprocess.run(['xauth', '-f', str(authority), 'add', ':99', '.', secrets.token_hex(16)], check=True)
password = (root / 'vnc-password').read_text().strip()
if not (root / 'vnc-auth').exists():
    subprocess.run(['x11vnc', '-storepasswd', password, str(root / 'vnc-auth')], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.chmod(root / 'vnc-auth', 0o600)
file = root / 'chat-on-steroids/config.json'
if not file.exists():
    file.write_text(json.dumps({
        'roots': [], 'readOnly': True,
        'capabilities': dict.fromkeys(['browse','search','read','metadata','create','edit','move','deleteFile','command','screen','control','clipboardRead','clipboardWrite'], False),
        'tunnel': {'kind': 'openai', 'tunnelId': '', 'desktopTunnelId': '', 'binaryPath': ''},
        'ui': {'minimizeToTray': False, 'autoConnect': False, 'startAtLogin': False, 'theme': 'dark', 'chatBrowser': 'chrome' if os.environ.get('COS_CHROME_BINARY') else 'cos', 'backgroundChats': False, 'mentionCore': False, 'autoContinue': False},
        'multiAgent': {'enabled': False}, 'goal': {'enabled': False}, 'compaction': {'auto': False},
        'controlApi': {'enabled': True, 'allowActions': True}
    }, indent=2) + '\n')
    os.chmod(file, 0o600)
PY
cat >"$HOME/.local/lib/cos-service/session.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
for attempt in {1..25}; do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 0.2
done
xdpyinfo -display "$DISPLAY" >/dev/null
gnome-keyring-daemon --unlock --components=secrets <"$HOME/.config/cos-service/keyring-password" >/dev/null
openbox &
if [[ -x "$HOME/.local/lib/cos-service/browser/google-chrome" ]]; then
  "$HOME/.local/lib/cos-service/browser/google-chrome" --new-window --window-size=1200,900 https://chatgpt.com/ &
fi
exec '/opt/Chat On Steroids/chat-on-steroids' --password-store=gnome-libsecret --disable-gpu
SH
chmod 700 "$HOME/.local/lib/cos-service/session.sh"
cat >"$HOME/.local/lib/cos-service/wait-api.py" <<'PY'
import pathlib, time, urllib.request
key = pathlib.Path.home() / '.config/cos-service/chat-on-steroids/openai-api/key'
for attempt in range(50):
    try:
        request = urllib.request.Request('http://127.0.0.1:20129/v1/models',
            headers={'Authorization': 'Bearer ' + key.read_text().strip()})
        with urllib.request.urlopen(request, timeout=1) as response:
            if response.status == 200:
                break
    except (OSError, ValueError):
        pass
    time.sleep(0.4)
else:
    raise SystemExit('CoS did not start its local text API; inspect journalctl --user -u cos.service')
PY
cat >"$units/cos-display.service" <<'UNIT'
[Unit]
Description=Private virtual display for Chat On Steroids
[Service]
ExecStart=/usr/bin/Xvfb :99 -screen 0 1600x1000x24 -nolisten tcp -extension GLX -auth %h/.config/cos-service/Xauthority
Restart=on-failure
RestartSec=3
[Install]
WantedBy=default.target
UNIT
cat >"$units/cos.service" <<'UNIT'
[Unit]
Description=Chat On Steroids text provider
Wants=cos-display.service
After=cos-display.service network-online.target
[Service]
Environment=DISPLAY=:99
Environment=XAUTHORITY=%h/.config/cos-service/Xauthority
Environment=XDG_CONFIG_HOME=%h/.config/cos-service
Environment=XDG_DATA_HOME=%h/.local/share/cos-service
Environment=COS_OPENAI_API_PORT=20129
Environment=COS_OPENAI_MODEL=latest
Environment=COS_OPENAI_REASONING_EFFORT=xhigh
Environment=COS_OPENAI_API_TIMEOUT_MS=900000
Environment=PATH=%h/.local/lib/cos-service/browser:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/dbus-run-session -- %h/.local/lib/cos-service/session.sh
ExecStartPost=/usr/bin/python3 %h/.local/lib/cos-service/wait-api.py
Restart=always
RestartSec=5
TimeoutStopSec=60
MemoryMax=6G
UMask=0077
[Install]
WantedBy=default.target
UNIT
cat >"$units/cos-vnc.service" <<'UNIT'
[Unit]
Description=Authenticated loopback desktop for CoS login
Requires=cos.service
After=cos.service
[Service]
ExecStart=/usr/bin/x11vnc -display :99 -auth %h/.config/cos-service/Xauthority -localhost -forever -shared -rfbport 5909 -rfbauth %h/.config/cos-service/vnc-auth -noxdamage
Restart=on-failure
RestartSec=3
UMask=0077
UNIT
cat >"$units/cos-login.service" <<'UNIT'
[Unit]
Description=Temporary loopback web desktop for CoS login
Requires=cos-vnc.service
After=cos-vnc.service
[Service]
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5909
RuntimeMaxSec=900
UMask=0077
UNIT
cat >"$HOME/.local/bin/cos-login" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
systemctl --user start cos-login.service
python3 - <<'PY'
import json, pathlib, urllib.error, urllib.request
key = (pathlib.Path.home() / '.config/cos-service/chat-on-steroids/openai-api/key').read_text().strip()
request = urllib.request.Request('http://127.0.0.1:20129/v1/login', data=b'{}',
    headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(request, timeout=20) as response:
        response.read()
except urllib.error.HTTPError as error:
    if error.code != 429:
        try:
            message = json.load(error).get('error', {}).get('message', 'The browser could not open')
        except (ValueError, AttributeError):
            message = 'The browser could not open'
        raise SystemExit(f'CoS login: {message} (HTTP {error.code})')
except OSError:
    raise SystemExit('CoS login: service unavailable. Check systemctl --user status cos.service')
PY
printf 'Open http://127.0.0.1:16080/vnc.html?autoconnect=1&resize=scale using an SSH tunnel to port 6080.\nVNC password: '
cat "$HOME/.config/cos-service/vnc-password"
SH
chmod 700 "$HOME/.local/bin/cos-login"
systemctl --user daemon-reload
if [[ ${1:-} == --no-start ]]; then
  systemctl --user enable cos-display.service cos.service
else
  systemctl --user enable --now cos-display.service cos.service
fi
echo 'CoS service installed. Enable linger with: sudo loginctl enable-linger "$USER"'
