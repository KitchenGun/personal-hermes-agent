# KIS Report Delivery Adapter

## Purpose

This document records the Hermes/Gateway-side adapter for KIS Trading Lab sanitized report payloads. KIS Trading Lab remains responsible only for sanitized report payload generation. Hermes Agent/Gateway owns delivery, operator reporting, and incident logging.

## Scope

The adapter accepts a strict allowlist payload for the KIS Trading Lab daily learning report, validates it, builds a Discord-safe message, and maps the message to the existing Discord relay delivery layer.

This adapter dry-run does not send a Discord message. No Hermes service was restarted. No direct Discord retry was attempted.

## Payload Allowlist

Required fields:

- `report_type`
- `project`
- `decision`
- `decision_reason`
- `candidate_count`
- `allowed_count`
- `risk_blocked_count`
- `data_blocked_count`
- `rule_blocked_count`
- `paper_entries_created_count`
- `paper_orders_created_count`
- `cron_status`
- `recommendation_output`
- `target_channel_id`

Default route:

- `target_channel_id`: `1512691418605420634`
- delivery layer: `discord_relay`
- route: `Hermes/Gateway -> Discord relay`

## Rejected Content

The adapter rejects unknown fields, raw response markers, secret-like values, row-like values, numeric score values, PnL values, recommendation wording, and non-blocked cron status.

## Runtime Boundary

The runtime send-once handler remains disabled without an injected sender. Tests use a fake sender to prove the adapter calls a delivery function exactly once and does not retry failed sends.

Actual Discord sending requires a separate approval and a Hermes service reload/restart window. That is outside this change.

## Status Summary

- route status: `adapter_ready_dry_run_only`
- actual send: pending separate approval
- direct Discord retry: disabled
- service restart: not performed
- cron/timer: unchanged
