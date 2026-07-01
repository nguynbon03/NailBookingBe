#!/usr/bin/env node
const baseUrl = (process.env.BASE_URL || 'https://bookingnail.overpowers.agency').replace(/\/$/, '');
const phone = process.env.PHONE || '';
const channel = process.env.CHANNEL || 'auto';
const otp = process.env.OTP || process.argv[2] || '';

async function request(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json };
}

(async () => {
  if (!phone) {
    console.error('Missing PHONE env. Example: PHONE=+84339351204 node scripts/test-otp-flow.mjs');
    process.exit(2);
  }
  console.log('=== Nail Lounge OTP smoke test ===');
  console.log('baseUrl:', baseUrl);
  console.log('phone:', phone);
  console.log('channel:', channel);

  const send = await request('/api/otp/send', { phone, channel });
  console.log('SEND status:', send.status);
  console.log('SEND body:', JSON.stringify(send.json, null, 2));

  if (!send.json.success) {
    process.exitCode = 1;
    return;
  }

  if (!otp) {
    console.log('\nOTP sent. Now check WhatsApp first, then SMS.');
    console.log('To verify after you receive it:');
    console.log(`OTP=123456 PHONE=${phone} CHANNEL=${channel} BASE_URL=${baseUrl} node scripts/test-otp-flow.mjs`);
    return;
  }

  const verify = await request('/api/otp/verify', { phone, otp });
  console.log('VERIFY status:', verify.status);
  console.log('VERIFY body:', JSON.stringify(verify.json, null, 2));
  if (!verify.json.success) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
