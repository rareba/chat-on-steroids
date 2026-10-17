# Coding provider recovery

The browser bridge remained connected while a restored, unsent harness draft
prevented native model discovery. Coding requests then waited on the discovery
deadline rather than producing a useful refusal. A separate native account
reliability notice was not classified as a blocking provider limit.

- Bound model-discovery waits to 15 seconds, independently of the coding deadline.
  Failure includes the existing discovery diagnostic and admits no input.
- Include catalog state, observation time and waiting/error diagnostics in the
  authenticated provider health response.
- Recognize the exact visible reliability-check alert as blocking and
  nonrecoverable. Preserve a future same-day retry time when supplied.
- Propagate blocking session errors before requiring a recorded generation turn;
  return HTTP 429 and Retry-After, or a structured SSE error with its status.
- Preserve cancelled input state before removing its restored browser draft.
  No account restrictions, login checks, model choices or effort requirements are
  bypassed, and no browser profiles or login credentials are transferred.

Validation: new regressions failed before implementation. TypeScript checking and
the production build pass. On Linux, 1,170 tests across the coding API, ChatGPT DOM,
model catalog and content recorder pass. Windows' HTTP integration run encountered
loopback EADDRINUSE failures, so Linux supplied the runtime integration verdict.
Operational browser inspection confirmed the account notice and the discovery
failure, and a normal catalog refresh became ready after draft preservation.

The accompanying router repair preserves OpenAI SSE errors for translated Claude
and Responses clients and rejects error envelopes before nonstreaming success
translation. That repair is separate from this project's changes.

Live acceptance after the provider's stated cooldown: Pi called its shell tool,
PowerShell returned 42 for 19 + 23, and Pi's final answer was `COS_PI_OK_42`.
Both admitted provider inputs recorded `gpt-6` with `xhigh`. Router replicas had
matching configuration checkpoints, no name conflicts and all eight existing
combos preserved. The Azure provider runtime was patched, but its independent
ChatGPT sign-in is still required before it can serve coding requests.

Recurrence safeguard: preserve the provider retry deadline in the existing
durable store. New requests return 429 without admitting more browser work;
health reports the pause, restarts retain it, and fresh requests resume after
expiry. Notices without a deadline receive a bounded 60-second backoff. A real
HTTP/outbox regression covers rejection, restart persistence and expiry with
both supplied and missing provider retry times. No unknown-outcome request is
replayed and no user-authored browser draft is erased automatically.
