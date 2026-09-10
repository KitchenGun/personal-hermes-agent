'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createReview, reviewMessage, decideReview } = require('./kis-order-review');

const NOW = new Date('2026-09-07T00:10:00Z');
const ORDER = { environment: 'prod', account_ref: 'a'.repeat(64), account_alias: '주식 전용',
  symbol: '005930', name: '삼성전자', side: 'buy', quantity: 2, limit_price_krw: 70000 };
const INPUT = { action: 'confirm', messageId: '123456789012345670', userId: '123456789012345671',
  interactionId: '123456789012345672', channelId: '1512691418605420634' };
function delivered() {
  return { ...createReview(ORDER, NOW), delivery_status: 'sent', message_id: INPUT.messageId };
}

test('order review displays exact terms and distinct buttons without account references', () => {
  const review = createReview(ORDER, NOW);
  const message = reviewMessage(review);
  assert.match(message.content, /실계좌.*주식 전용/);
  assert.match(message.content, /매수 삼성전자\(005930\) 2주/);
  assert.match(message.content, /70,000원/);
  assert.match(message.content, /140,000원/);
  assert.match(message.content, /주문은 제출하지 않습니다/);
  assert.doesNotMatch(message.content, /aaaaaaaa|account_ref|kis-recovery/);
  assert.equal(message.components[0].components[0].custom_id, `kis-order-review:confirm:${review.id}`);
  assert.equal(message.components[0].components[1].custom_id, `kis-order-review:deny:${review.id}`);
});

test('confirmation and refusal record no execution authority and cannot be repeated', () => {
  for (const action of ['confirm', 'deny']) {
    const review = delivered();
    const result = decideReview(review, { ...INPUT, action, id: review.id }, NOW);
    assert.equal(result.status, action === 'confirm' ? 'confirmed' : 'denied');
    assert.equal(result.order_submitted, false);
    assert.equal(result.execution_authorized, false);
    assert.equal(review.status, 'pending');
    assert.throws(() => decideReview(result, { ...INPUT, id: review.id }, NOW), /already_decided/);
  }
});

test('expired, changed, wrong-message and wrong-channel reviews fail closed', () => {
  const review = delivered();
  assert.throws(() => decideReview(review, { ...INPUT, id: review.id }, new Date(review.expires_at)), /expired/);
  assert.throws(() => decideReview(review, { ...INPUT, id: review.id }, new Date(NOW.getTime() - 1)), /expired/);
  for (const key of Object.keys(ORDER)) {
    const changed = { ...review, order: { ...review.order, [key]: null } };
    assert.throws(() => decideReview(changed, { ...INPUT, id: review.id }, NOW), /changed/);
  }
  assert.throws(() => decideReview(review, { ...INPUT, id: 'b'.repeat(64) }, NOW), /changed/);
  assert.throws(() => decideReview(review, { ...INPUT, id: review.id, messageId: INPUT.userId }, NOW), /message_mismatch/);
  assert.throws(() => decideReview(review, { ...INPUT, id: review.id, channelId: INPUT.userId }, NOW), /identity_invalid/);
  assert.throws(() => decideReview({ ...review, delivery_status: 'claimed' }, { ...INPUT, id: review.id }, NOW), /message_mismatch/);
});

test('invalid terms and hidden extra fields cannot create order review', () => {
  for (const quantity of [0, -1, true, 0.5, NaN, Infinity]) {
    assert.throws(() => createReview({ ...ORDER, quantity }, NOW), /invalid/);
  }
  for (const limit_price_krw of [0, -1, true, NaN, Infinity]) {
    assert.throws(() => createReview({ ...ORDER, limit_price_krw }, NOW), /invalid/);
  }
  for (const patch of [{ order_type: 'market' }, { side: 'BUY' }, { account_alias: '12345678' },
    { name: '@everyone' }, { name: '12345678901' }, { name: 'a'.repeat(30) },
    { name: 'https://example.com' }, { symbol: '005930 ' }]) {
    assert.throws(() => createReview({ ...ORDER, ...patch }, NOW), /invalid/);
  }
});
