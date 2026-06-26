// Cloudflare Worker — 升学AI助手 单文件
// 功能: AI代理 + 用户编码系统 + 管理API
// 绑定: KV (命名空间绑定 DATA)
// 变量: DEEPSEEK_API_KEY, ADMIN_KEY

function json(d, s, c) {
  return new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json', ...c } });
}

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
}

async function readBody(r) {
  const ct = r.headers.get('Content-Type') || '';
  if (ct.includes('json')) return r.json();
  if (ct.includes('urlencoded')) { const f = await r.formData(); const o = {}; for (const [k, v] of f.entries()) o[k] = v; return o; }
  return {};
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return 'ACTV-' + code;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders();
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    const path = url.pathname;

    // === AI 聊天代理 ===
    if (path === '/ai/chat' && request.method === 'POST') return handleAI(request, env, cors);
    // 兼容旧路径（直接POST到根）
    if (request.method === 'POST' && path === '/') return handleAI(request, env, cors);

    // === 用户登录：验证编码并恢复数据 ===
    if (path === '/user/login' && request.method === 'POST') return handleLogin(request, env, cors);

    // === 保存用户数据 ===
    if (path === '/user/save' && request.method === 'POST') return handleSave(request, env, cors);

    // === 生成编码（管理工具） ===
    if (path === '/admin/create-code' && request.method === 'POST') return handleCreateCode(request, env, cors);

    return json({ error: 'Not Found' }, 404, cors);
  }
};

// =============================================
// AI 代理（DeepSeek）
// =============================================
async function handleAI(request, env, cors) {
  if (!env.DEEPSEEK_API_KEY) {
    return json({ error: 'server_error', message: '服务端配置错误，请联系管理员' }, 500, cors);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request', message: '请求格式错误' }, 400, cors); }

  const { messages } = body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'bad_request', message: '缺少 messages 参数' }, 400, cors);
  }

  const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: messages,
      temperature: 0.7,
      max_tokens: 2000
    })
  });

  const data = await response.json();
  return new Response(JSON.stringify(data), {
    status: response.status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// =============================================
// 用户登录/恢复
// POST /user/login  { code: "ACTV-XXXX" }
// =============================================
async function handleLogin(request, env, cors) {
  if (!env.DATA) {
    return json({ error: 'server_error', message: 'KV未绑定' }, 500, cors);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request', message: '请求格式错误' }, 400, cors); }

  const { code } = body;
  if (!code) return json({ error: '缺少编码' }, 400, cors);

  // 查验证书是否存在
  const codeRecord = await env.DATA.get('code:' + code, 'json');
  if (!codeRecord) return json({ error: '无效的激活编码' }, 404, cors);

  // 检查用户是否已存在
  let userRecord = await env.DATA.get('user:' + code, 'json');

  if (!userRecord) {
    // 首次激活
    if (!codeRecord.used) {
      // 标记编码已使用
      codeRecord.used = true;
      await env.DATA.put('code:' + code, JSON.stringify(codeRecord));

      // 根据编码 tier 创建用户
      const tier = codeRecord.tier || 'free';
      const tierPaid = { free: 19.9, basic: 79.9, pro: 129.9 };
      const tierTrial = { free: 0, basic: 999, pro: 999 };
      const tierTimer = { free: null, basic: 1800, pro: 99999 };

      userRecord = {
        code: code,
        tier: tier,
        paid_amount: tierPaid[tier],
        messages: [],
        trial_count: tierTrial[tier],
        timer_remaining: tierTimer[tier],
        timer_started: false,
        created_at: Date.now(),
        updated_at: Date.now()
      };
      await env.DATA.put('user:' + code, JSON.stringify(userRecord));
      return json({ success: true, first_login: true, user: userRecord }, 200, cors);
    } else {
      // 编码已被使用但没有用户记录（异常状态）
      return json({ error: '编码已被使用，请联系客服' }, 403, cors);
    }
  }

  // 已有用户，返回数据（恢复登录）
  return json({ success: true, first_login: false, user: userRecord }, 200, cors);
}

// =============================================
// 保存用户数据
// POST /user/save  { code, messages, trial_count, timer_remaining, timer_started }
// =============================================
async function handleSave(request, env, cors) {
  if (!env.DATA) return json({ error: 'server_error' }, 500, cors);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request', message: '格式错误' }, 400, cors); }

  const { code, messages, trial_count, timer_remaining, timer_started } = body;
  if (!code) return json({ error: '缺少编码' }, 400, cors);

  const existing = await env.DATA.get('user:' + code, 'json');
  if (!existing) return json({ error: '用户不存在' }, 404, cors);

  // 更新字段
  if (messages !== undefined) existing.messages = messages.slice(-50); // 最多50条
  if (trial_count !== undefined) existing.trial_count = trial_count;
  if (timer_remaining !== undefined) existing.timer_remaining = timer_remaining;
  if (timer_started !== undefined) existing.timer_started = timer_started;
  existing.updated_at = Date.now();

  await env.DATA.put('user:' + code, JSON.stringify(existing));
  return json({ success: true }, 200, cors);
}

// =============================================
// 生成编码（管理工具用）
// POST /admin/create-code  { tier: "free"|"basic"|"pro", count: 10, adminKey: "xxx" }
// =============================================
async function handleCreateCode(request, env, cors) {
  if (!env.DATA) return json({ error: 'server_error' }, 500, cors);
  if (!env.ADMIN_KEY) return json({ error: 'ADMIN_KEY未配置' }, 500, cors);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad_request' }, 400, cors); }

  const { tier, count, adminKey } = body;
  if (adminKey !== env.ADMIN_KEY) return json({ error: '管理密钥错误' }, 403, cors);
  if (!['free', 'basic', 'pro'].includes(tier)) return json({ error: '无效的档位，可选: free/basic/pro' }, 400, cors);
  const n = Math.min(Math.max(parseInt(count) || 1, 1), 100);

  const codes = [];
  for (let i = 0; i < n; i++) {
    const code = generateCode();
    await env.DATA.put('code:' + code, JSON.stringify({ tier, used: false }));
    codes.push(code);
  }

  return json({ success: true, codes, tier, count: n }, 200, cors);
}
