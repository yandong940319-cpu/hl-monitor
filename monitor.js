/**
 * Hyperliquid 地址监控 + Telegram 通知
 * - 实时通知：开仓成交 / 新挂单
 * - 持仓变化时推送（对比指纹）
 * - 每日 10:00 CST 推送日报（无变化不发）
 * - 多地址支持（TARGET_ADDRESSES 逗号分隔）
 */

var WebSocket = require("ws");
var https = require("https");
var cron = require("node-cron");
require("dotenv").config();

// 配置
function parseAddresses() {
  var raw = process.env.TARGET_ADDRESSES || process.env.TARGET_ADDRESS || "";
  return raw.split(",").map(function(a) { return a.trim().toLowerCase(); }).filter(Boolean);
}

var CONFIG = {
  ADDRESSES: parseAddresses(),
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
  HL_WS_URL: "wss://api.hyperliquid.xyz/ws",
  RECONNECT_DELAY_MS: 3000,
  MAX_RECONNECT_DELAY_MS: 60000,
  DAILY_CRON: "0 2 * * *",
};

if (CONFIG.ADDRESSES.length === 0) {
  console.error("[ERROR] 未配置监控地址，请设置 TARGET_ADDRESSES 环境变量");
  process.exit(1);
}

var positionCache = {};

// 关键修复：标记是否已经拉取过初始持仓，重连不再强制推送
var initialPositionsFetched = false;

// 工具
function log(level, msg) {
  console.log("[" + new Date().toISOString() + "] [" + level + "] " + msg);
}

function shortAddr(addr) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

function fmt(n, d) {
  d = d === undefined ? 4 : d;
  var num = parseFloat(n);
  if (isNaN(num)) return String(n);
  return num.toLocaleString("en-US", { maximumFractionDigits: d });
}

function formatDir(dir) {
  if (!dir) return "未知";
  var d = dir.toLowerCase();
  if (d.includes("open long")) return "🟢 开多 (Long)";
  if (d.includes("open short")) return "🔴 开空 (Short)";
  if (d.includes("close long")) return "🔵 平多 (Close Long)";
  if (d.includes("close short")) return "🔵 平空 (Close Short)";
  return dir;
}

function formatSide(side) {
  return side === "B" ? "🟢 买入 (Long)" : "🔴 卖出 (Short)";
}

function buildPositionHash(positions) {
  if (!positions || positions.length === 0) return "EMPTY";
  return positions.map(function(p) {
    return p.position.coin + ":" + p.position.szi + ":" + p.position.entryPx;
  }).sort().join("|");
}

// Telegram
function sendTelegram(text) {
  var body = JSON.stringify({ chat_id: CONFIG.TELEGRAM_CHAT_ID, text: text, parse_mode: "HTML", disable_web_page_preview: true });
  var options = {
    hostname: "api.telegram.org",
    path: "/bot" + CONFIG.TELEGRAM_BOT_TOKEN + "/sendMessage",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  };
  var req = https.request(options, function(res) {
    if (res.statusCode !== 200) log("WARN", "Telegram 响应异常: " + res.statusCode);
  });
  req.on("error", function(e) { log("ERROR", "Telegram 发送失败: " + e.message); });
  req.write(body);
  req.end();
}

// REST API
function postHL(payload) {
  return new Promise(function(resolve, reject) {
    var body = JSON.stringify(payload);
    var opts = {
      hostname: "api.hyperliquid.xyz",
      path: "/info",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    var req = https.request(opts, function(res) {
      var d = "";
      res.on("data", function(c) { d += c; });
      res.on("end", function() { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function fetchPositions(address) { return postHL({ type: "clearinghouseState", user: address }); }
function fetchOpenOrders(address) { return postHL({ type: "openOrders", user: address }); }

// 持仓消息构建
function buildPositionsMessage(address, state, openOrders, label) {
  label = label || "📊 <b>持仓快照</b>";
  var positions = (state.assetPositions || []).filter(function(p) {
    return parseFloat((p.position && p.position.szi) || 0) !== 0;
  });
  var accountValue = fmt((state.marginSummary && state.marginSummary.accountValue) || 0, 2);
  var marginUsed = fmt((state.marginSummary && state.marginSummary.totalMarginUsed) || 0, 2);
  var addrLine = CONFIG.ADDRESSES.length > 1 ? "\n📍 <code>" + shortAddr(address) + "</code>" : "";
  var now = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

  var posSection;
  if (positions.length === 0) {
    posSection = "📭 当前无开放持仓";
  } else {
    posSection = positions.map(function(p) {
      var pos = p.position;
      var size = parseFloat(pos.szi);
      var side = size > 0 ? "🟢 多" : "🔴 空";
      var pnl = parseFloat(pos.unrealizedPnl || 0);
      var pnlStr = (pnl >= 0 ? "+" : "") + "$" + fmt(pnl, 2);
      var roe = pos.returnOnEquity ? " ROE " + (parseFloat(pos.returnOnEquity) * 100).toFixed(2) + "%" : "";
      var lev = (pos.leverage && pos.leverage.value) ? pos.leverage.value + "x" : "-";
      var liqPx = pos.liquidationPx ? "$" + fmt(pos.liquidationPx, 2) : "-";
      return "  <b>" + pos.coin + "</b> " + side + " " + lev + "\n" +
             "  入场 $" + fmt(pos.entryPx, 4) + " | 数量 " + fmt(Math.abs(size), 4) + "\n" +
             "  浮盈 <b>" + pnlStr + "</b>" + roe + "\n" +
             "  强平价 " + liqPx;
    }).join("\n\n");
  }

  var orderSection = "";
  if (openOrders && openOrders.length > 0) {
    orderSection = "\n\n📋 <b>当前挂单</b>\n" + openOrders.map(function(o) {
      return "  <b>" + o.coin + "</b> " + (o.side === "B" ? "🟢 买" : "🔴 卖") + " | $" + fmt(o.limitPx) + " x " + fmt(o.sz);
    }).join("\n");
  }

  return label + addrLine + "\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    "💼 账户净值：<b>$" + accountValue + "</b>\n" +
    "🔒 占用保证金：$" + marginUsed + "\n\n" +
    posSection + orderSection + "\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    "🕐 " + now;
}

// 持仓检测与推送
async function checkAndSendPositions(address, opts) {
  opts = opts || {};
  try {
    var results = await Promise.all([fetchPositions(address), fetchOpenOrders(address)]);
    var state = results[0], openOrders = results[1];
    var positions = (state.assetPositions || []).filter(function(p) {
      return parseFloat((p.position && p.position.szi) || 0) !== 0;
    });
    var newHash = buildPositionHash(positions);
    var cache = positionCache[address] || {};
    var changed = newHash !== cache.positionHash;
    log("INFO", "[" + shortAddr(address) + "] 持仓: " + positions.length + "仓位 挂单" + (openOrders || []).length + "个 变化:" + changed);
    if (opts.forceSend || changed) {
      var lbl = opts.label || (changed && cache.positionHash ? "🔄 <b>持仓已变化</b>" : "📊 <b>持仓快照</b>");
      sendTelegram(buildPositionsMessage(address, state, openOrders, lbl));
      positionCache[address] = { positionHash: newHash, sentAt: Date.now() };
      return { changed: true };
    }
    return { changed: false };
  } catch (e) {
    log("ERROR", "[" + shortAddr(address) + "] 拉取失败: " + e.message);
    return { changed: false };
  }
}

// 启动时只执行一次
async function sendInitialPositions() {
  for (var i = 0; i < CONFIG.ADDRESSES.length; i++) {
    await checkAndSendPositions(CONFIG.ADDRESSES[i], { forceSend: true, label: "📊 <b>持仓快照（启动）</b>" });
    if (CONFIG.ADDRESSES.length > 1) await new Promise(function(r) { setTimeout(r, 1000); });
  }
}

async function dailyReport() {
  log("INFO", "每日日报...");
  var anyChanged = false;
  for (var i = 0; i < CONFIG.ADDRESSES.length; i++) {
    var r = await checkAndSendPositions(CONFIG.ADDRESSES[i], { forceSend: false, label: "📅 <b>每日持仓日报 (10:00)</b>" });
    if (r.changed) anyChanged = true;
    if (CONFIG.ADDRESSES.length > 1) await new Promise(function(r2) { setTimeout(r2, 1000); });
  }
  if (!anyChanged) log("INFO", "日报：无变化，跳过");
}

// 实时消息
function buildFillMessage(fill, address) {
  var time = new Date(fill.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  var isOpen = fill.dir && fill.dir.toLowerCase().includes("open");
  var action = isOpen ? "🚀 <b>开仓成交</b>" : "📤 <b>平仓成交</b>";
  var addrLine = CONFIG.ADDRESSES.length > 1 ? "\n📍 <code>" + shortAddr(address) + "</code>" : "";
  return action + addrLine + "\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    "🪙 资产：<b>" + fill.coin + "</b>\n" +
    "📊 方向：" + formatDir(fill.dir) + "\n" +
    "💰 成交价：<b>$" + fmt(fill.px) + "</b>\n" +
    "📦 数量：<b>" + fmt(fill.sz) + " " + fill.coin + "</b>\n" +
    "💵 手续费：" + fmt(fill.fee) + " " + (fill.feeToken || "USDC") + "\n" +
    "🕐 时间：" + time + "\n" +
    "🔗 <a href=\"https://hyperdash.com/address/" + address + "\">查看地址</a>";
}

function buildOrderMessage(order, address) {
  var time = new Date(order.timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  var tpsl = order.isPositionTpsl ? " (TP/SL)" : "";
  var addrLine = CONFIG.ADDRESSES.length > 1 ? "\n📍 <code>" + shortAddr(address) + "</code>" : "";
  return "📋 <b>新挂单" + tpsl + "</b>" + addrLine + "\n" +
    "━━━━━━━━━━━━━━━━━━━━\n" +
    "🪙 资产：<b>" + order.coin + "</b>\n" +
    "📊 方向：" + formatSide(order.side) + "\n" +
    "💰 挂单价：<b>$" + fmt(order.limitPx) + "</b>\n" +
    "📦 数量：<b>" + fmt(order.origSz || order.sz) + " " + order.coin + "</b>\n" +
    "🏷️ 类型：" + (order.orderType || order.tif || "Limit") + "\n" +
    "🕐 时间：" + time + "\n" +
    "🆔 订单ID：<code>" + order.oid + "</code>\n" +
    "🔗 <a href=\"https://hyperdash.com/address/" + address + "\">查看地址</a>";
}

function handleFills(fills, address) {
  if (!Array.isArray(fills)) fills = [fills];
  fills.forEach(function(item) {
    var fill = item.fill || item;
    if (!fill.coin) return;
    var isOpen = fill.dir && fill.dir.toLowerCase().includes("open");
    log("INFO", "[" + shortAddr(address) + "] 成交: " + fill.coin + " | " + fill.dir + " | $" + fill.px);
    if (isOpen) sendTelegram(buildFillMessage(fill, address));
    // 平仓也通知: else { sendTelegram(buildFillMessage(fill, address)); }
    setTimeout(function() { checkAndSendPositions(address, { label: "🔄 <b>持仓已变化</b>" }); }, 2000);
  });
}

function handleOrderUpdates(orders, address) {
  if (!Array.isArray(orders)) orders = [orders];
  orders.forEach(function(item) {
    var order = item.order || item;
    var status = item.status || "";
    if (!order.coin || status !== "open") return;
    log("INFO", "[" + shortAddr(address) + "] 新挂单: " + order.coin + " | $" + order.limitPx);
    sendTelegram(buildOrderMessage(order, address));
  });
}

// WebSocket
var reconnectDelay = CONFIG.RECONNECT_DELAY_MS;
var ws = null;
var pingInterval = null;

function connect() {
  log("INFO", "正在连接 Hyperliquid WebSocket...");
  ws = new WebSocket(CONFIG.HL_WS_URL);

  ws.on("open", async function() {
    log("INFO", "WebSocket 已连接");
    reconnectDelay = CONFIG.RECONNECT_DELAY_MS;

    CONFIG.ADDRESSES.forEach(function(addr) {
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "userFills", user: addr } }));
      ws.send(JSON.stringify({ method: "subscribe", subscription: { type: "orderUpdates", user: addr } }));
      log("INFO", "subscribed: " + addr);
    });

    pingInterval = setInterval(function() { if (ws.readyState === WebSocket.OPEN) ws.ping(); }, 30000);

    // 关键修复：只在第一次连接时推送初始持仓，重连不再推送
    if (!initialPositionsFetched) {
      initialPositionsFetched = true;
      var addrList = CONFIG.ADDRESSES.map(function(a, i) { return "  " + (i + 1) + ". <code>" + a + "</code>"; }).join("\n");
      sendTelegram("🟢 <b>监控已启动</b>\n━━━━━━━━━━━━━━━━━━━━\n📡 监控地址（" + CONFIG.ADDRESSES.length + "个）：\n" + addrList + "\n🔔 实时通知：开仓、挂单、持仓变化\n📅 每日 10:00 推送日报\n📊 正在拉取初始持仓...");
      await sendInitialPositions();
    } else {
      log("INFO", "WS 重连，跳过初始持仓推送");
    }
  });

  ws.on("message", function(data) {
    var msg; try { msg = JSON.parse(data); } catch (e) { return; }
    var ch = msg.channel;
    if (ch === "subscriptionResponse" || ch === "pong") return;
    if (ch === "userFills") {
      var p = msg.data;
      if (p && p.isSnapshot) return;
      var fills = (p && p.fills) || [];
      if (!fills.length) return;
      handleFills(fills, ((p && p.user) || CONFIG.ADDRESSES[0]).toLowerCase());
    }
    if (ch === "orderUpdates") {
      var p2 = msg.data;
      if (!Array.isArray(p2) || !p2.length) return;
      var u = (p2[0] && p2[0].order && p2[0].order.user) || CONFIG.ADDRESSES[0];
      handleOrderUpdates(p2, u.toLowerCase());
    }
  });

  ws.on("ping", function() { ws.pong(); });
  ws.on("error", function(e) { log("ERROR", "WS错误: " + e.message); });
  ws.on("close", function(code) {
    clearInterval(pingInterval);
    log("WARN", "WS断开 code=" + code + ", " + reconnectDelay / 1000 + "s后重连");
    setTimeout(function() {
      reconnectDelay = Math.min(reconnectDelay * 2, CONFIG.MAX_RECONNECT_DELAY_MS);
      connect();
    }, reconnectDelay);
  });
}

// 每日 10:00 CST = UTC 02:00
cron.schedule(CONFIG.DAILY_CRON, function() {
  log("INFO", "每日日报 10:00 CST");
  dailyReport();
}, { timezone: "UTC" });

// 启动
log("INFO", "=".repeat(50));
log("INFO", "Hyperliquid 地址监控启动");
CONFIG.ADDRESSES.forEach(function(a, i) { log("INFO", "  [" + (i + 1) + "] " + a); });
log("INFO", "=".repeat(50));
connect();

process.on("SIGINT", function() {
  log("INFO", "关闭...");
  sendTelegram("🔴 <b>监控已停止</b>\n📡 已停止监控 " + CONFIG.ADDRESSES.length + " 个地址");
  if (ws) ws.close();
  process.exit(0);
});
