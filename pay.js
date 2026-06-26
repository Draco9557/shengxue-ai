// =====================================================
// Cloudflare Worker — 升学AI助手 支付后端
// =====================================================
// 部署前在 Cloudflare Dashboard 设置以下环境变量:
//   XORPAY_APP_ID     — 你的 XorPay APP ID
//   XORPAY_APP_SECRET — 你的 XorPay APP SECRET
//   XORPAY_PAY_TYPE   — "wxpay" (微信) 或 "alipay" (支付宝)
//   ALLOWED_ORIGINS   — 允许跨域的域名，逗号分隔
// =====================================================

// KV Namespace 绑定名: PAYMENTS
// 在 wrangler.toml 或 Cloudflare Dashboard 中绑定

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGINS || '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const body = request.method === 'POST' ? await request.json() : {};

    try {
      // =====================================================
      // 路由
      // =====================================================
      switch (url.pathname) {

        // ------------------------------------------------
        // POST /pay/create — 创建支付订单
        // 前端调用: { tier: 'basic'|'pro', user_id: 'xxx' }
        // ------------------------------------------------
        case '/pay/create': {
          const { tier, user_id } = body;
          if (!tier || !user_id) {
            return json({ error: '缺少参数 tier 或 user_id' }, 400, corsHeaders);
          }

          // 查询用户当前已付金额
          const userKey = 'user:' + user_id;
          const userData = await env.PAYMENTS.get(userKey, 'json');
          const paidAmount = (userData && userData.paid_amount) || 0;

          // 目标价格
          const prices = { free: 19.9, basic: 79.9, pro: 129.9 };
          const targetPrice = prices[tier];
          if (!targetPrice) {
            return json({ error: '无效的 tier' }, 400, corsHeaders);
          }

          // 计算需付金额（补差价）
          const amountDue = Math.max(0, targetPrice - paidAmount);
          if (amountDue <= 0) {
            return json({ error: '已解锁，无需付款' }, 400, corsHeaders);
          }

          // 生成订单号
          const order_id = 'ORD' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();

          // 调用 XorPay API 创建订单
          const xorpayBody = new URLSearchParams();
          xorpayBody.set('price', Math.round(amountDue * 100).toString()); // 单位: 分
          xorpayBody.set('pay_type', env.XORPAY_PAY_TYPE || 'wxpay');
          xorpayBody.set('order_id', order_id);
          xorpayBody.set('notify_url', url.origin + '/pay/callback');

          const xorRes = await fetch('https://xorpay.com/api/pay/' + env.XORPAY_APP_ID, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: xorpayBody.toString(),
          });
          const xorData = await xorRes.json();

          if (xorData.status !== 0) {
            return json({ error: '创建订单失败: ' + (xorData.msg || '未知错误') }, 500, corsHeaders);
          }

          // 存储订单信息到 KV
          const orderData = {
            order_id: order_id,
            user_id: user_id,
            tier: tier,
            price: amountDue,
            status: 'pending',
            xorpay_order_id: xorData.order_id,
            created_at: Date.now(),
          };
          await env.PAYMENTS.put('order:' + order_id, JSON.stringify(orderData));

          // 返回二维码给前端
          return json({
            success: true,
            order_id: order_id,
            qrcode: xorData.qrcode,       // 二维码图片 URL
            pay_url: xorData.pay_url,      // 支付跳转链接
            amount: amountDue,
            tier: tier,
          }, 200, corsHeaders);
        }

        // ------------------------------------------------
        // POST /pay/callback — XorPay 支付回调
        // XorPay 会 POST 订单数据到这里
        // ------------------------------------------------
        case '/pay/callback': {
          const data = body;

          // XorPay 回调参数: order_id, status, price, pay_type, ...
          // 注意: XorPay 的 order_id 是它自己的，我们需要根据它找到我们的订单
          // 或者 XorPay 也可以透传我们的 order_id
          const orderId = data.order_id;
          const xorpayOrderId = data.xorpay_order_id;

          // 查找订单
          let orderKey = null;
          // 尝试用 XorPay 的 order_id 查找
          // 实际使用中可能需要根据 XorPay 的回调参数调整

          // 简单方案：在我们的 order_id 中查找
          const orderData = await env.PAYMENTS.get('order:' + orderId, 'json');
          if (!orderData) {
            return json({ error: '订单不存在' }, 404, corsHeaders);
          }

          // 校验签名（XorPay 的签名验证）
          // XorPay 可能传 sign 参数，需要验证

          if (data.status === '2' || data.status === 2) {
            // 支付成功
            orderData.status = 'paid';
            orderData.paid_at = Date.now();
            await env.PAYMENTS.put('order:' + orderId, JSON.stringify(orderData));

            // 更新用户的 paid_amount
            const userKey = 'user:' + orderData.user_id;
            const userData = (await env.PAYMENTS.get(userKey, 'json')) || { paid_amount: 0 };
            userData.paid_amount = (userData.paid_amount || 0) + orderData.price;
            userData.updated_at = Date.now();
            await env.PAYMENTS.put(userKey, JSON.stringify(userData));
          } else {
            // 支付失败
            orderData.status = 'failed';
            await env.PAYMENTS.put('order:' + orderId, JSON.stringify(orderData));
          }

          return json({ success: true }, 200, corsHeaders);
        }

        // ------------------------------------------------
        // GET /pay/status?order_id=xxx — 查询订单状态
        // 前端轮询
        // ------------------------------------------------
        case '/pay/status': {
          const orderId = url.searchParams.get('order_id');
          if (!orderId) {
            return json({ error: '缺少 order_id' }, 400, corsHeaders);
          }

          const orderData = await env.PAYMENTS.get('order:' + orderId, 'json');
          if (!orderData) {
            return json({ error: '订单不存在' }, 404, corsHeaders);
          }

          return json({
            status: orderData.status,
            tier: orderData.tier,
            price: orderData.price,
          }, 200, corsHeaders);
        }

        // ------------------------------------------------
        // GET /user/status?user_id=xxx — 查询用户已付金额
        // 前端页面加载时调用来恢复状态
        // ------------------------------------------------
        case '/user/status': {
          const userId = url.searchParams.get('user_id');
          if (!userId) {
            return json({ error: '缺少 user_id' }, 400, corsHeaders);
          }

          const userData = await env.PAYMENTS.get('user:' + userId, 'json');
          const paidAmount = (userData && userData.paid_amount) || 0;

          return json({
            paid_amount: paidAmount,
            user_id: userId,
          }, 200, corsHeaders);
        }

        default:
          return json({ error: 'Not Found' }, 404, corsHeaders);
      }
    } catch (err) {
      return json({ error: err.message }, 500, corsHeaders);
    }
  }
};

// Helper: 返回 JSON 响应
function json(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders,
    },
  });
}
