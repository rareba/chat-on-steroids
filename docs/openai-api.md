# Local coding provider and Debian service

CoS can expose an optional OpenAI-compatible **text and function-tool** endpoint for a local
gateway such as 9Router. It uses your signed-in ChatGPT browser, account model
selection and ordinary usage limits. This is browser integration, not an official
ChatGPT inference API. See the [responsible-use notice](../README.md#responsible-use-and-provider-rules).

## Desktop setup

Enable **Local control API** and **Allow actions** in Settings, quit CoS, then
launch it with `COS_OPENAI_API_PORT=20129` in its environment. It binds only to
`127.0.0.1`. Without that environment variable there is no provider listener.
Both consent switches remain enforced on every request; turning either off
revokes the key's access immediately. Restart after first enabling the switches.

The private file `<userData>/openai-api/key` contains the gateway's API key.
Unlike the control API token, it survives restarts. Stop CoS and remove that file
to rotate it. `openai-api/endpoint.json` records the bound port and is removed
on shutdown. The existing control API retains its separate per-launch token.

In 9Router, add an **OpenAI Compatible** provider with API type **Chat Completions**,
base URL `http://127.0.0.1:20129/v1`, and the key above. Import models from
`/models`, or add `chatgpt-latest` for the newest available GPT generation.
Use a distinct prefix, for example `cos`. No combo or default route needs changing.
The gateway must run on the same host or use an authenticated SSH tunnel.

`POST /v1/login` opens the selected browser's existing sign-in flow without
exporting cookies. `GET /v1/health` reports browser connectivity and the built-in
browser's observed sign-in state. External browsers report `signedIn: null`;
their readiness uses a successful account-model observation from the last hour.
These routes require
the same bearer key. The Debian `cos-login` helper opens that window for you.
The login endpoint allows one opening per minute to avoid repeatedly restarting
an in-progress sign-in. It never retries an authentication error automatically.
Standalone Chrome is unnecessary for ordinary OpenAI sign-in. Google SSO needs
Chrome, Edge or Brave with the companion installed; CoS provides its existing
explicit browser-to-CoS handoff for that flow.
For a service with Google SSO, download Chrome for Testing from Google's official
distribution and set `COS_CHROME_BINARY=/absolute/path/to/chrome` when running the
installer. It keeps a dedicated runtime/profile, loads CoS's shipped companion,
and makes that browser available to the sign-in handoff in the same service
session. Keep that private runtime updated alongside CoS.
New profiles select the supplied Chrome automatically; existing profiles are preserved.

To pin execution rather than use the browser's selection, set both
`COS_OPENAI_MODEL` (an observed model id, or `latest`) and
`COS_OPENAI_REASONING_EFFORT` (for example `xhigh`, Extra High). `latest`
refreshes the account catalog before each send and chooses its highest numbered
GPT generation with the exact requested effort. It never falls back to an older
generation or lower effort. Unknown catalogs, unsupported effort and mismatched
delivery proof fail clearly. The Debian service sets `latest` plus `xhigh` with
a 15-minute deadline. Nothing is sent unless the requested selection is available.
Discovery uses an existing signed-in page when possible, or CoS's one clean
helper page when existing pages contain drafts. It preserves those drafts and
does not start an SSO login flow.
Explicit account model IDs override the rolling model choice. They use the
configured reasoning effort (Extra High by default); a model offering only the
`pro` power tier uses that tier. The response reports the actual selected model.
An explicit `reasoning_effort` overrides the environment default and must be one
of that model's observed `reasoning_efforts` in `/v1/models`. Unsupported values
return HTTP 400 before sending. Pro is a browser power tier, not Extra High;
an explicit incompatible effort is never silently converted to Pro.
9Router already translates its `model(high)` / `model(xhigh)` suffixes and
provider Thinking selection into this request field. For example:

```json
{"model":"cos/gpt-6(high)","messages":[{"role":"user","content":"Review this code."}]}
```

Use the provider's **Auto** thinking setting to leave CoS's Extra High default
and the Pro model's own tier in control; suffixes or explicit request effort
still select a particular supported level. These are request options, not combos.
In 9Router's provider header overrides, set `X-CoS-Transport: sse`. This asks CoS
to use SSE upstream even for `stream: false`; 9Router collects that stream into
ordinary JSON for its non-streaming clients. Queued requests therefore receive
headers and keepalives before the 60-second upstream connection deadline.
Direct CoS callers retain normal JSON behavior unless they opt into this header.
9Router's dashboard model probe has a separate 60-second timeout. Queued or Pro
requests can exceed it; validate those with a real streaming coding request and
a client deadline matching the service's 15-minute maximum.
`chatgpt-default` remains accepted for compatibility and follows the environment
policy, or the browser's selection when no policy is configured.

## Headless Debian: persistent service, browser login on demand

The app still needs a browser and virtual display. The supplied installer uses
Xvfb, the built-in CoS browser, an encrypted GNOME keyring and systemd user
services. No physical screen or desktop login is required. The dedicated CoS
profile starts with **no local tools or approved folders**, no agents and no MCP
tunnel; text delivery does not need an OpenAI tunnel key.

Install the Linux DEB from a release containing this feature, verify its published
checksum, then run as the ordinary service account:

```sh
sudo apt-get install xvfb xauth x11-utils gnome-keyring dbus-x11 openbox x11vnc novnc websockify
bash scripts/install-headless-debian.sh
sudo loginctl enable-linger "$USER"
```

The installer reserves display `:99`, API port `20129`, VNC port `5909` and web
port `6080`. They must be unused. It preserves existing profile and password
files. CoS configuration, cookies and keyring data live separately under
`~/.config/cos-service` and `~/.local/share/cos-service`. The generated keyring
password is private to that Unix user so the service can unlock after reboot.
Back up both directories together and protect access to that account.
Use `--no-start` to stage the services without opening a browser or starting CoS.

To sign in from another computer, run:

```sh
ssh -L 16080:127.0.0.1:6080 you@your-vm '~/.local/bin/cos-login; exec sleep 900'
```

Open `http://127.0.0.1:16080/vnc.html?autoconnect=1&resize=scale`, enter the VNC
password printed by that SSH session, and sign in to ChatGPT in the CoS browser.
The web desktop closes after 15 minutes; closing it does not stop CoS. Repeat the
same command if ChatGPT later asks you to sign in again. No browser cookies are
copied from another machine. The Electron sandbox and secure credential checks
remain enabled.
The dedicated service keeps its work visible on the virtual display, and the
optional Chrome wrapper disables background timer/render throttling. This avoids
requiring a human to foreground a finished answer before its recorder can publish it.
The service sets `COS_HEADLESS_SERVICE=1`: quiet app-owned pages become reusable
after five seconds and eligible for closure after thirty seconds. Existing native
draft, generation, ownership, pin and reading checks still protect them. Ordinary
desktop installations retain their two-minute/five-minute defaults.
The generated service caps CPU at three logical cores (`CPUQuota=300%`), gives it
low CPU weight, and limits memory to 8 GiB. These are limits, not reservations;
adjust them with a systemd override for your machine.

```sh
systemctl --user status cos.service
journalctl --user -u cos.service -n 50
systemctl --user restart cos.service
```

## Request behavior

- `GET /v1/models` lists the observed account model IDs plus `chatgpt-latest`.
  Account rows include the optional `reasoning_efforts` metadata extension.
  Availability depends on the signed-in account; listing is not login proof.
  Sends reuse a successful model observation for at most sixty seconds instead
  of reopening the native picker for every tool turn. Delivered model and effort
  are still verified on every request.
- `POST /v1/chat/completions` accepts text messages with system, developer,
  user and assistant role labels. Each request opens a new chat and serializes
  the supplied history as text; it does not implement native role isolation.
- Four independent browser chats run concurrently by default. `COS_OPENAI_WORKERS`
  accepts 1–8 workers; invalid settings retain four. There are at most 32 HTTP requests in flight.
  Overlapping harness calls wait in order rather than causing a busy cooldown;
  each caller's deadline includes its queue wait. Queued streaming requests send
  headers and keepalives immediately, avoiding a gateway's connection deadline.
  A full queue returns 503 with Retry-After, rather than a misleading account-quota 429.
  Health reports pendingRequests, requestCapacity, activeRequests and workerCapacity.
  More workers improve throughput across harnesses; they do not accelerate one model turn
  or bypass the signed-in account's native limits. The JSON body is bounded to 8 MiB. A
  conversation and tool catalog exceeding the browser's 96,000-character message
  ceiling are staged intact with a unique `cos-context-<request>.txt` filename through CoS's existing native
  attachment pipeline. The message contains the instructions and a file reference;
  no history or tool definitions are silently dropped. ChatGPT's file-upload,
  account usage and model context limits still apply. Output is bounded to
  256,000 characters. Partial, truncated, interrupted and
  unattributed replies are errors. Existing secret redaction is retained.
  The opening input's exact recorded question ID owns the canonical response
  turn, including when attribution arrives after the completed answer.
  Native file answers can arrive without generation events. Those require a
  terminal recorded reply containing this request's fresh response token, the
  exact latest question, and no running or recorded generation; no turn ID is
  invented and another question cannot lend its response to the request.
  Inline admission also checks CoS's mandatory instruction framing before deciding
  that the request fits. Repeated uploads never reuse an attachment filename.
- `stream: true` sends comment keepalives while thinking and standard SSE content
  frames **after the complete answer**, not live token deltas. Failed turns emit
  an SSE error instead of a completion. Usage counts estimate visible text and
  function names/arguments at four characters per token, marked `cos_estimated: true`.
  These are not ChatGPT's private token, reasoning or billing counters.
- OpenAI function tools, `tool_choice`, `parallel_tool_calls`, assistant tool-call
  history and matching tool results are supported. Tools execute in the caller's
  harness, under its permissions, never in CoS. The browser produces a private
  JSON envelope bound to a fresh response token. Only a completed, validated
  envelope becomes public tool calls; malformed, unmatched, unknown-function or
  disallowed parallel responses fail without publishing executable calls.
  Streamed tool calls use standard indexed deltas and `finish_reason: tool_calls`.
  Long histories are bounded by the transport limit, with no arbitrary 256-message
  cutoff. Empty assistant entries and tool-call arrays, namespaced functions and
  gateway-normalized object arguments retain their conversation meaning. Invalid
  fields are reported by structural path without logging their content.
- Images, structured-output requests, legacy `functions` and multiple choices
  are rejected. Sampling
  and token-budget fields cannot control the ChatGPT UI and are not implemented.
  Without a configured model policy, the browser's selected model is used.
  Pi, Oh My Pi and OpenCode can use 9Router's OpenAI Completions interface;
  Claude Code uses 9Router's existing Anthropic-to-OpenAI translation. Keep
  the request within the 8 MiB transport ceiling. Large histories use a native
  context attachment; this does not increase the underlying model's context window.

### ChatGPT limits

The worker count is a local resource setting, not a claimed ChatGPT concurrency quota.
OpenAI does not publish a fixed signed-in text-chat concurrency number in its
[model limits](https://help.openai.com/en/articles/20001354-gpt-6-and-other-models-in-chatgpt).
Model allowances depend on the account; Chat and Work/Codex allowances are separate.
The [upload documentation](https://help.openai.com/en/articles/8555545-uploading-files-and-audio-to-chatgpt)
currently lists up to 80 files per three hours, which may be lowered at peak times.
Each oversized completion uses an upload, so long-context tool loops can reach
that limit before the local queue fills. More workers do not increase it.

Both endpoints require `Authorization: Bearer <key>`. Browser Origins and foreign
Host headers are refused. There is no automatic resend after timeout, lost
delivery proof or a provider refusal. A pending request is cancelled on client
disconnect or shutdown where the outbox can still withdraw it; an already
delivered turn can only be stopped when its exact recorded id is known.
Private `openai-api/pending-<id>` markers are written before outbox admission.
After a process crash, startup withdraws only those abandoned API inputs, even
if the listener was subsequently disabled. Completed browser conversations stay
recorded; an interrupted HTTP completion is never replayed to a new caller.
The default deadline is 180 seconds; `COS_OPENAI_API_TIMEOUT_MS` accepts up to
900000. No service can guarantee that ChatGPT will never require a fresh login.

If ChatGPT reports `max_check_attempts` / Too many attempts, stop signing in and
allow the provider's restriction to expire. Do not repeatedly reopen the login
window or change browsers/accounts to evade it. OpenAI's
[login guidance](https://help.openai.com/en/articles/7426629-why-cant-i-log-in-to-chatgpt)
advises waiting up to an hour after repeated failed attempts; contact its support
if the restriction persists.
