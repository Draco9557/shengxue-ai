// =====================================================
// Cloudflare Worker — 升学AI助手 合并版
// 功能: AI代理 + 用户系统 + 支付系统
// KV 命名空间绑定名: DATA
// 环境变量:
//   DEEPSEEK_API_KEY — DeepSeek API Key (加密)
//   ADMIN_KEY        — 管理后台密钥 (加密)
//   XORPAY_APP_ID    — XorPay APP ID
//   XORPAY_APP_SECRET — XorPay APP SECRET
//   XORPAY_PAY_TYPE  — "wxpay" 或 "alipay"
// =====================================================

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(), ...extraHeaders },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return 'ACTV-' + code;
}

// MD5 using node:crypto (requires nodejs_compat flag)
async function md5hex(str) {
  const { createHash } = await import('node:crypto');
  return createHash('md5').update(str).digest('hex').toLowerCase();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders();
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    const path = url.pathname;
    try {
      if (path === '/ai/chat' && request.method === 'POST') return handleAI(request, env);
      if (request.method === 'POST' && path === '/') return handleAI(request, env);
      if (path === '/user/login' && request.method === 'POST') return handleLogin(request, env);
      if (path === '/user/save' && request.method === 'POST') return handleSave(request, env);
      if (path === '/admin/create-code' && request.method === 'POST') return handleCreateCode(request, env);
      if (path === '/pay/create' && request.method === 'POST') return handlePayCreate(request, env);
      if (path === '/pay/callback' && request.method === 'POST') return handlePayCallback(request, env);
      if (path === '/pay/status' && request.method === 'GET') return handlePayStatus(request, env);
      if (path === '/user/status' && request.method === 'GET') return handleUserStatus(request, env);
      return json({ error: 'Not Found' }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};

async function handleAI(request, env) {
  if (!env.DEEPSEEK_API_KEY) return json({ error: 'server_error', message: '服务端配置错误' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request', message: '请求格式错误' }, 400); }
  const { messages } = body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) return json({ error: 'bad_request', message: '缺少messages' }, 400);
  const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.DEEPSEEK_API_KEY },
    body: JSON.stringify({ model: 'deepseek-chat', messages, temperature: 0.7, max_tokens: 2000 }),
  });
  const data = await resp.json();
  return new Response(JSON.stringify(data), {
    status: resp.status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

async function handleLogin(request, env) {
  if (!env.DATA) return json({ error: 'server_error', message: 'KV未绑定' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request', message: '格式错误' }, 400); }
  const { code } = body;
  if (!code) return json({ error: '缺少编码' }, 400);
  const cr = await env.DATA.get('code:' + code, 'json');
  if (!cr) return json({ error: '无效的激活编码' }, 404);
  let ur = await env.DATA.get('user:' + code, 'json');
  if (!ur) {
    if (!cr.used) {
      cr.used = true;
      await env.DATA.put('code:' + code, JSON.stringify(cr));
      const tier = cr.tier || 'free';
      const PAID = { free: 19.9, basic: 79.9, pro: 129.9 };
      const TRIAL = { free: 0, basic: 999, pro: 999 };
      const TIMER = { free: null, basic: 1800, pro: 99999 };
      ur = { code, tier, paid_amount: PAID[tier] || 0, messages: [], trial_count: TRIAL[tier] || 0, timer_remaining: TIMER[tier] || null, timer_started: false, created_at: Date.now(), updated_at: Date.now() };
      await env.DATA.put('user:' + code, JSON.stringify(ur));
      return json({ success: true, first_login: true, user: ur }, 200);
    }
    return json({ error: '编码已被使用，请联系客服' }, 403);
  }
  return json({ success: true, first_login: false, user: ur }, 200);
}

async function handleSave(request, env) {
  if (!env.DATA) return json({ error: 'server_error' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request', message: '格式错误' }, 400); }
  const { code, messages, trial_count, timer_remaining, timer_started } = body;
  if (!code) return json({ error: '缺少编码' }, 400);
  const ex = await env.DATA.get('user:' + code, 'json');
  if (!ex) return json({ error: '用户不存在' }, 404);
  if (messages !== undefined) ex.messages = messages.slice(-50);
  if (trial_count !== undefined) ex.trial_count = trial_count;
  if (timer_remaining !== undefined) ex.timer_remaining = timer_remaining;
  if (timer_started !== undefined) ex.timer_started = timer_started;
  ex.updated_at = Date.now();
  await env.DATA.put('user:' + code, JSON.stringify(ex));
  return json({ success: true }, 200);
}

async function handleCreateCode(request, env) {
  if (!env.DATA) return json({ error: 'server_error' }, 500);
  if (!env.ADMIN_KEY) return json({ error: 'ADMIN_KEY未配置' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const { tier, count, adminKey } = body;
  if (adminKey !== env.ADMIN_KEY) return json({ error: '管理密钥错误' }, 403);
  if (!['free', 'basic', 'pro'].includes(tier)) return json({ error: '无效的档位' }, 400);
  const n = Math.min(Math.max(parseInt(count) || 1, 1), 100);
  const codes = [];
  for (let i = 0; i < n; i++) {
    const c = generateCode();
    await env.DATA.put('code:' + c, JSON.stringify({ tier, used: false }));
    codes.push(c);
  }
  return json({ success: true, codes, tier, count: n }, 200);
}

async function handlePayCreate(request, env) {
  if (!env.DATA) return json({ error: 'server_error', message: 'KV未绑定' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request', message: '格式错误' }, 400); }
  const { tier, code } = body;
 if (!tier || !code) return json({ error: '缺少参数 tier 或 code' }, 400);
 const cr = await env.DATA.get('code:' + code, 'json');
  if (!cr) return json({ error: '无效的激活编码，请先登录' }, 400);
  const existing = (await env.DATA.get('user:' + code, 'json')) || { paid_amount: 0 };
  const paid = existing.paid_amount || 0;
  const prices = { basic: 79.9, pro: 129.9 };
  const target = prices[tier];
  if (!target) return json({ error: '无效的档位' }, 400);
  const due = Math.round(Math.max(0, target - paid) * 100) / 100;
  if (due <= 0) return json({ error: '已解锁，无需付款' }, 400);
  const oid = 'ORD' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
  const xb = new URLSearchParams();
  xb.set('price', due.toFixed(2));
  xb.set('pay_type', env.XORPAY_PAY_TYPE || 'native');
  xb.set('order_id', oid);
  var nameVal = '升学咨询' + (tier === 'basic' ? '标准版' : '深度版');
  var notifyUrl = new URL(request.url).origin + '/pay/callback';
  xb.set('name', nameVal);
  xb.set('notify_url', notifyUrl);
  xb.set('more', '');
  xb.set('sign', await md5hex(nameVal + (env.XORPAY_PAY_TYPE || 'native') + due.toFixed(2) + oid + notifyUrl + ('4420439c2f3a4114a4d7cb068a7b52fe')));
  const xr = await fetch('https://xorpay.com/api/pay/705948', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: xb.toString(),
  });
  const xd = await xr.json();
  if (xd.status !== 'ok') {
    var xErr = xd.status === 'fee_error' ? 'XorPay余额不足，请先充值' : ('创建订单失败: ' + (xd.msg || xd.status || '未知错误'));
    return json({ error: xErr }, 500);
  }
   const od = { order_id: oid, code, tier, price: due, status: 'pending', xorpay_order_id: xd.aoid || '', created_at: Date.now() };
  await env.DATA.put('order:' + oid, JSON.stringify(od));
  if (xd.aoid) await env.DATA.put('idx:xorpay:' + xd.aoid, oid);
  return json({ success: true, order_id: oid, qrcode: (xd.info && xd.info.qr) || '', pay_url: '', amount: due, tier }, 200);
}

async function handlePayCallback(request, env) {
  if (!env.DATA) return json({ error: 'server_error' }, 500);
  let data;
  const ct = request.headers.get('Content-Type') || '';
  try {
    if (ct.includes('json')) data = await request.json();
    else if (ct.includes('urlencoded')) { const f = await request.formData(); data = {}; for (const [k, v] of f.entries()) data[k] = v; }
    else { const t = await request.text(); try { data = JSON.parse(t); } catch { const p = new URLSearchParams(t); data = {}; for (const [k, v] of p.entries()) data[k] = v; } }
  } catch { return json({ error: '无法解析回调数据' }, 400); }
  let iid = null;
  let od = await env.DATA.get('order:' + (data.order_id || ''), 'json');
  if (!od && data.order_id) { iid = await env.DATA.get('idx:xorpay:' + data.order_id); if (iid) od = await env.DATA.get('order:' + iid, 'json'); }
  if (!od && data.xorpay_order_id) { iid = await env.DATA.get('idx:xorpay:' + data.xorpay_order_id); if (iid) od = await env.DATA.get('order:' + iid, 'json'); }
  if (!od) return json({ error: '订单不存在' }, 404);
  if (od.status === 'paid' || od.status === 'failed') return json({ success: true, duplicate: true }, 200);
  if (data.status === '2' || data.status === 2) {
   od.status = 'paid'; od.paid_at = Date.now();
   await env.DATA.put('order:' + (iid || data.order_id || data.xorpay_order_id), JSON.stringify(od));
   var ud = (await env.DATA.get('user:' + od.code, 'json')) || { paid_amount: 0 };
    ud.paid_amount = (ud.paid_amount || 0) + od.price;
    ud.updated_at = Date.now();
    await env.DATA.put('user:' + od.code, JSON.stringify(ud));
  } else {
    od.status = 'failed';
    await env.DATA.put('order:' + (iid || data.order_id || data.xorpay_order_id), JSON.stringify(od));
  }
  return json({ success: true }, 200);
}

async function handlePayStatus(request, env) {
  const oid = new URL(request.url).searchParams.get('order_id');
  if (!oid) return json({ error: '缺少 order_id' }, 400);
  const od = await env.DATA.get('order:' + oid, 'json');
  if (!od) return json({ error: '订单不存在' }, 404);
  return json({ status: od.status, tier: od.tier, price: od.price }, 200);
}

async function handleUserStatus(request, env) {
  const code = new URL(request.url).searchParams.get('code');
  if (!code) return json({ error: '缺少 code' }, 400);
  const ud = await env.DATA.get('user:' + code, 'json');
  return json({ paid_amount: (ud && ud.paid_amount) || 0, code }, 200);
}
