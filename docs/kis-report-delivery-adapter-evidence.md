# KIS Report Delivery Adapter Evidence

## Evidence Summary

The Hermes/Gateway-side KIS report delivery adapter was implemented as a dry-run first path.

Validated properties:

- valid KIS payload validation passes
- missing required field is rejected
- unknown row-like field is rejected
- numeric score and PnL content are rejected
- secret-like payload is rejected without echoing the value
- buy/sell/recommendation wording is rejected
- dry-run does not call a Discord sender
- fake send-once calls a fake sender exactly once
- fake send failure does not retry
- target channel routing preserves `1512691418605420634`
- incident/status summary is generated
- runtime send-once remains disabled without an injected sender

## Boundary Evidence

This adapter dry-run does not send a Discord message.

No Hermes service was restarted.

No direct Discord retry was attempted.

KIS Trading Lab remains responsible only for sanitized report payload generation.

Hermes Agent/Gateway owns delivery, operator reporting, and incident logging.

## Forbidden Actions

- no Discord send
- no Hermes actual send
- no service restart
- no cron/timer change
- no KIS API call
- no DB write
- no order/account/balance/condition/WebSocket call
