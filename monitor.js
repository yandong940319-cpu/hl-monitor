/**
 * Hyperliquid 地址监控 + Telegram 通知
 * 监控目标：开仓（fills）和挂单（orderUpdates）
 */

const WebSocket = require("ws");
const https = require("https");
require("dotenv").config();

// ─────────────────────────────────────────
//  配置区（优先从 .env 读取）
// ─────────────────────────────────────────
const CONFIG = {
  TARGET_ADDRESS: process.env.TARGET_ADDRESS || "0x5D2F4460Ac3514AdA79f5D9838916E508Ab39Bb7",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "YOUR_CHAT_ID",
  HL_WS_URL: "wss://api.hyperliquid.xyz/ws",
  RECONNECT_DELAY_MS: 3000,   // 断线重连等待时间（ms）
  MAX_RECONNECT_DELAY_MS: 60000,
};

// ─────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────
function log(level, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] ${msg}`);
}

/** 发送 Telegram 消息 */
function sendTelegram(text) {
  const body = JSON.stringify({
    chat_id: CONFIG.TELEGRAM_CHAT_ID,
    text,
    parse_mode: "HTML",
  });

  const options = {
    hostname: "api.telegram.org",
    path: `/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  const req = https.request(options, (res) => {
    if (res.statusCode !== 200) {
      log("WARN", `Telegram 响应异常: ${res.statusCode}`);
    }
  });

  req.on("error", (e) => log("ERROR", `Telegram 发送失败: ${e.message}`));
  req.write(body);
  req.end();
}

/** 格式化方向 */
function formatDir(dir) {
  if (!dir) return "未知";
  const d = dir.toLowerCase();
  if (d.includes("open long") || d.includes("buy")) return "🟢 开多 (Long)";
  if (d.includes("open short") || d.includes("sell")) return "🔴 开空 (Short)";
  if (d.includes("close long")) return "🔵 平多 (Close Long)";
  if (d.includes("close short")) return "🔵 平空 (Close Short)";
  return dir;
}

/** 格式化挂单方向 */
function formatSide(side) {
  return side === "B" ? "🟢 买入 (Long)" : "🔴 卖出 (Short)";
}

/** 格式化数字（保留合理小数位） */
function fmt(n, decimals = 4) {
  const num = parseFloat(n);
  if (isNaN(num)) return n;
  return num.toLocaleString("en-US", { maximumFractionDigits: decimals });
}

// ─────────────────────────────────────────
//  消息格式化
// ─────────────────────────────────────────

/** 开仓通知 */
function buildFillMessage(fill) {
  const time = new Date(fill.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const isOpen = fill.dir && fill.dir.toLowerCase().includes("open");
  const action = isOpen ? "🚀 <b>开仓成交</b>" : "📤 <b>平仓成交</b>";

  return `${action}
━━━━━━━━━━━━━━━━━━━━
🪙 资产：<b>${fill.coin}</b>
📊 方向：${formatDir(fill.dir)}
💰 成交价：<b>$${fmt(fill.px)}</b>
📦 数量：<b>${fmt(fill.sz)} ${fill.coin}</b>
💵 手续费：${fmt(fill.fee)} ${fill.feeToken || "USDC"}
🕐 时间：${time}
🔗 <a href="https://hyperdash.com/address/${CONFIG.TARGET_ADDRESS}">查看地址</a>
━━━━━━━━━━━━━━━━━━━━
📍 地址：<code>${CONFIG.TARGET_ADDRESS.slice(0, 10)}...${CONFIG.TARGET_ADDRESS.slice(-6)}</code>`;
}

/** 挂单通知 */
function buildOrderMessage(order) {
  const time = new Date(order.timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const tpsl = order.isPositionTpsl ? " (TP/SL)" : "";
  const orderTypeLabel = order.orderType || order.tif || "Limit";

  return `📋 <b>新挂单${tpsl}</b>
━━━━━━━━━━━━━━━━━━━━
🪙 资产：<b>${order.coin}</b>
📊 方向：${formatSide(order.side)}
💰 挂单价：<b>$${fmt(order.limitPx)}</b>
📦 数量：<b>${fmt(order.origSz || order.sz)} ${order.coin}</b>
🏷️ 类型：${orderTypeLabel}
🕐 时间：${time}
🆔 订单ID：<code>${order.oid}</code>
🔗 <a href="https://hyperdash.com/address/${CONFIG.TARGET_ADDRESS}">查看地址</a>
━━━━━━━━━━━━━━━━━━━━
📍 地址：<code>${CONFIG.TARGET_ADDRESS.slice(0, 10)}...${CONFIG.TARGET_ADDRESS.slice(-6)}</code>`;
}

// ─────────────────────────────────────────
//  事件处理
// ─────────────────────────────────────────

/** 处理 userFills 推送 */
function handleFills(fills) {
  if (!Array.isArray(fills)) fills = [fills];
  for (const item of fills) {
    const fill = item.fill || item;
    if (!fill.coin) continue;

    const isOpen = fill.dir && fill.dir.toLowerCase().includes("open");
    log("INFO", `成交: ${fill.coin} | ${fill.dir} | 价格: ${fill.px} | 数量: ${fill.sz}`);

    // 只通知开仓，平仓可按需注释/取消注释
    if (isOpen) {
      sendTelegram(buildFillMessage(fill));
    }
    // 如需平仓也通知，去掉下面注释：
    // else { sendTelegram(buildFillMessage(fill)); }
  }
}

/** 处理 orderUpdates 推送 */
function handleOrderUpdates(orders) {
  if (!Array.isArray(orders)) orders = [orders];
  for (const item of orders) {
    const order = item.order || item;
    const status = item.status || "";

    if (!order.coin) continue;

    // 只处理新挂单（open 状态），忽略快照和已成交/已取消
    if (status === "open") {
      log("INFO", `挂单: ${order.coin} | ${order.side === "B" ? "Buy" : "Sell"} | 价格: ${order.limitPx} | 数量: ${order.origSz || order.sz}`);
      sendTelegram(buildOrderMessage(order));
    }
  }
}

// ─────────────────────────────────────────
//  WebSocket 连接管理
// ─────────────────────────────────────────
let reconnectDelay = CONFIG.RECONNECT_DELAY_MS;
let ws = null;
let pingInterval = null;

function connect() {
  log("INFO", `正在连接 Hyperliquid WebSocket...`);
  ws = new WebSocket(CONFIG.HL_WS_URL);

  ws.on("open", () => {
    log("INFO", "WebSocket 已连接 ✅");
    reconnectDelay = CONFIG.RECONNECT_DELAY_MS; // 重置重连延迟

    const addr = CONFIG.TARGET_ADDRESS.toLowerCase();

    // 订阅：开仓成交
    ws.send(JSON.stringify({
      method: "subscribe",
      subscription: { type: "userFills", user: addr },
    }));

    // 订阅：挂单更新
    ws.send(JSON.stringify({
      method: "subscribe",
      subscription: { type: "orderUpdates", user: addr },
    }));

    log("INFO", `✅ 已订阅地址: ${addr}`);

    // 心跳 ping（每 30s），防止连接超时断开
    pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      }
    }, 30_000);

    // 启动通知
    sendTelegram(`🟢 <b>监控已启动</b>
📍 监控地址：<code>${CONFIG.TARGET_ADDRESS}</code>
🔔 将实时通知开仓和挂单操作`);
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    const channel = msg.channel;

    // 忽略订阅确认和心跳
    if (channel === "subscriptionResponse" || channel === "pong") return;

    if (channel === "userFills") {
      const payload = msg.data;
      // isSnapshot: true 时是历史数据，可忽略
      if (payload?.isSnapshot) return;
      if (payload?.fills) handleFills(payload.fills);
    }

    if (channel === "orderUpdates") {
      const payload = msg.data;
      if (Array.isArray(payload)) {
        handleOrderUpdates(payload);
      }
    }
  });

  ws.on("ping", () => ws.pong());

  ws.on("error", (err) => {
    log("ERROR", `WebSocket 错误: ${err.message}`);
  });

  ws.on("close", (code, reason) => {
    clearInterval(pingInterval);
    log("WARN", `WebSocket 断开 (code=${code}), ${reconnectDelay / 1000}s 后重连...`);
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, CONFIG.MAX_RECONNECT_DELAY_MS);
      connect();
    }, reconnectDelay);
  });
}

// ─────────────────────────────────────────
//  启动
// ─────────────────────────────────────────
log("INFO", "=".repeat(50));
log("INFO", "Hyperliquid 地址监控启动");
log("INFO", `目标地址: ${CONFIG.TARGET_ADDRESS}`);
log("INFO", "=".repeat(50));

connect();

// 优雅退出
process.on("SIGINT", () => {
  log("INFO", "收到退出信号，正在关闭...");
  sendTelegram(`🔴 <b>监控已停止</b>\n📍 地址：<code>${CONFIG.TARGET_ADDRESS}</code>`);
  if (ws) ws.close();
  process.exit(0);
});
