# KIS Prediction Validation Discord Progress

## Purpose

Hermes owns the bounded scheduler for `kis-prediction-validation-cycle` and sends minimal Discord progress only after sanitized KIS CLI results are available.

KIS Trading Lab remains the source of truth for calendar checks, prediction generation, persistence, reconciliation, leakage guards, kill switch, lock, and idempotency.

## Message Format

New validation day:

```text
[KIS 예측 검증]
진행: {distinct_trading_days}/20 거래일
상태: 표본 수집 중
요약: 예측 {total_predictions}건 · 대조 {resolved_predictions}건(정답 {correct_predictions}/오답 {incorrect_predictions}/중립 {neutral_predictions}) · 대기 {pending_predictions}건 · 거래 없음
```

Minimum reached:

```text
[KIS 예측 검증]
진행: 20/20 거래일
상태: 최소 검증 완료
요약: 예측 {total_predictions}건 · 대조 {resolved_predictions}건(정답 {correct_predictions}/오답 {incorrect_predictions}/중립 {neutral_predictions}) · 대기 {pending_predictions}건 · 거래 없음
```

Protective pause:

```text
[KIS 예측 검증]
진행: {distinct_trading_days}/20 거래일
상태: 보호 중단
요약: 예측 {total_predictions}건 · 대조 {resolved_predictions}건(정답 {correct_predictions}/오답 {incorrect_predictions}/중립 {neutral_predictions}) · 대기 {pending_predictions}건 · 거래 없음
```

Messages do not include symbols, prices, row values, scores, returns, PnL, prediction direction, commentary, recommendations, commits, or logs.

## Progress Source

Progress is based only on `distinct_trading_days` from the sanitized KIS prediction validation CLI result.

The summary line uses sanitized aggregate counts only:

- `total_predictions`
- `resolved_predictions`
- `correct_predictions`
- `incorrect_predictions`
- `neutral_predictions`
- `pending_predictions = total_predictions - resolved_predictions`

If no paper/live trades exist, the trade phrase is `거래 없음`.

The following do not count as validation progress:

- automation invocation count
- API call count
- prediction row count
- repeated execution on the same trading day

## Delivery Rules

Hermes sends through the existing Discord relay route to channel `1512691418605420634`.

Send conditions:

- `distinct_trading_days` increases beyond the last sent value
- task state transitions to `PAUSED`
- task reaches `COMPLETED` / 20 distinct trading days

Idempotency key:

```text
kis_prediction_progress:{task_id}:{distinct_trading_days}:{task_state}
```

Failed Discord delivery is recorded as status-only metadata. It does not retry in the same invocation, does not rerun the prediction cycle, and does not change the KIS task result.

## Initial Verification

Initial current-state message was sent once after runtime sync:

```text
[KIS 예측 검증]
진행: 2/20 거래일
상태: 표본 수집 중
```

Result: `discord_sent=true`, `send_attempt_count=1`, `error_class=none`.

## Current 7/20 preview

```text
[KIS 예측 검증]
진행: 7/20 거래일
상태: 표본 수집 중
요약: 예측 21건 · 대조 17건(정답 9/오답 5/중립 3) · 대기 4건 · 거래 없음
```

The preview is count-only. It does not include symbols, prices, row values, scores, PnL, raw responses, secrets, or recommendation text.
