'use strict';

const crypto = require('node:crypto');
const TARGET_CHANNEL_ID = '1512691418605420634';
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function createReview(order, now = new Date()) {
  const fields = ['environment', 'account_ref', 'account_alias', 'symbol', 'name', 'side', 'quantity', 'limit_price_krw'];
  if (!order || Object.keys(order).length !== fields.length || fields.some((key) => !Object.hasOwn(order, key))
    || !['vps', 'prod'].includes(order.environment)
    || typeof order.account_ref !== 'string' || !/^[a-f0-9]{64}$/.test(order.account_ref)
    || typeof order.account_alias !== 'string' || !/^[A-Za-z가-힣][A-Za-z가-힣 _-]{0,23}$/.test(order.account_alias)
    || typeof order.symbol !== 'string' || !/^\d{6}$/.test(order.symbol)
    || typeof order.name !== 'string' || !/^[A-Za-z0-9가-힣 .&()-]{1,40}$/.test(order.name)
    || /\d{8,}|[A-Za-z0-9]{24,}|Bearer|access.token|app.secret|webhook/i.test(`${order.name} ${order.account_alias}`)
    || !['buy', 'sell'].includes(order.side)
    || !Number.isSafeInteger(order.quantity) || order.quantity <= 0
    || !Number.isSafeInteger(order.limit_price_krw) || order.limit_price_krw <= 0
    || !Number.isSafeInteger(order.quantity * order.limit_price_krw)
    || !Number.isFinite(now.getTime())) throw new Error('order_review_invalid');
  const proposal = Object.fromEntries(fields.map((key) => [key, order[key]]));
  return {
    id: crypto.randomBytes(32).toString('hex'),
    order: proposal,
    order_hash: digest(proposal),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60_000).toISOString(),
    status: 'pending',
    delivery_status: 'claimed',
    order_submitted: false,
    execution_authorized: false,
  };
}

function reviewMessage(review) {
  const order = review.order;
  return {
    targetChannelId: TARGET_CHANNEL_ID,
    deliveryLayer: 'hermes_kis_order_review',
    idempotencyKey: `kis-order-review:${review.id}`,
    content: [
      '[KIS 주문안 확인]',
      `계좌: ${order.environment === 'prod' ? '실계좌' : '모의계좌'} / ${order.account_alias}`,
      `주문안: ${order.side === 'buy' ? '매수' : '매도'} ${order.name}(${order.symbol}) ${order.quantity}주`,
      `지정가: ${order.limit_price_krw.toLocaleString('ko-KR')}원`,
      `주문금액: ${(order.quantity * order.limit_price_krw).toLocaleString('ko-KR')}원 (수수료 제외)`,
      `확인 기한: ${new Date(review.expires_at).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false })} KST`,
      '이번 주문안만 확인합니다. 자동매매 활성화가 아닙니다.',
      '현재는 확인 기록만 저장하며 주문은 제출하지 않습니다.',
    ].join('\n'),
    components: [{ type: 1, components: [
      { type: 2, style: 3, label: '주문안 확인', emoji: { name: '✅' }, custom_id: `kis-order-review:confirm:${review.id}` },
      { type: 2, style: 4, label: '거절', emoji: { name: '✖️' }, custom_id: `kis-order-review:deny:${review.id}` },
    ] }],
  };
}

function decideReview(review, { id, action, messageId, userId, interactionId, channelId }, now = new Date()) {
  if (!review || review.id !== id || review.order_hash !== digest(review.order)) throw new Error('order_review_changed');
  if (!['confirm', 'deny'].includes(action) || channelId !== TARGET_CHANNEL_ID
    || ![messageId, userId, interactionId].every((value) => typeof value === 'string' && /^\d{16,24}$/.test(value))) {
    throw new Error('order_review_identity_invalid');
  }
  if (review.delivery_status !== 'sent' || review.message_id !== messageId) throw new Error('order_review_message_mismatch');
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(review.created_at))
    || now.getTime() < Date.parse(review.created_at) || !Number.isFinite(Date.parse(review.expires_at))
    || now.getTime() >= Date.parse(review.expires_at)) throw new Error('order_review_expired');
  if (review.status !== 'pending') throw new Error('order_review_already_decided');
  return { ...review, status: action === 'confirm' ? 'confirmed' : 'denied',
    decided_by: userId, interaction_id: interactionId, decided_at: now.toISOString(),
    order_submitted: false, execution_authorized: false };
}

module.exports = { createReview, reviewMessage, decideReview };
