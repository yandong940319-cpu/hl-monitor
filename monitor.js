/**
 * Hyperliquid 地址监控 + Telegram 通知
 * 功能：开仓/挂单实时通知 + 启动时持仓快照 + 多地址支持
 */

const WebSocket = require("ws");
const https = require("https");
require("dotenv").config();

function parseAddresses() {
  const multi = process.env.TARGET_ADDRESSES || "";
  const single = process.env.TARGET_ADDRESS || "";
  const raw = multi || single;
  return raw.split(",").map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0);
}

const CONFIG = {
  ADDRESSES: parseAddresses(),
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "YOUR_CHAT_ID",
  HL_WS_URL: "wss://api.hyperliquid.xyz/ws",
  RECONNECT_DELAY_MS: 3000,
  MAX_RECONNECT_DELAY_MS: 60000,
};

if (CONFIG.ADDRESSES.length === 0) {
  console.error("未配置监控地址");
  process.exit(1);
}

function log(level, msg) {
  console.log(`[${new Date().toISOString()}] [${level}] ${msg}`);
}
function shortAddr(addr) { return `${addr.slice(0,6)}...${addr.slice(-4)}`; }
function fmt(n, d=4) { const num=parseFloat(n); if(isNaN(num)) return String(n); return num.toLocaleString("en-US",{maximumFractionDigits:d}); }
function formatDir(dir) {
  if(!dir) return "未知";
  const d=dir.toLowerCase();
  if(d.includes("open long")) return "🟢 开多 (Long)";
  if(d.includes("open short")) return "🔴 开空 (Short)";
  if(d.includes("close long")) return "🔵 平多 (Close Long)";
  if(d.includes("close short")) return "🔵 平空 (Close Short)";
  return dir;
}
function formatSide(side) { return side==="B"?"🟢 买入 (Long)":"🔴 卖出 (Short)"; }

function sendTelegram(text) {
  const body=JSON.stringify({chat_id:CONFIG.TELEGRAM_CHAT_ID,text,parse_mode:"HTML",disable_web_page_preview:true});
  const options={hostname:"api.telegram.org",path:`/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}};
  const req=https.request(options,(res)=>{if(res.statusCode!==200)log("WARN",`Telegram响应异常:${res.statusCode}`);});
  req.on("error",(e)=>log("ERROR",`Telegram发送失败:${e.message}`));
  req.write(body); req.end();
}

function fetchPositions(address) {
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify({type:"clearinghouseState",user:address});
    const options={hostname:"api.hyperliquid.xyz",path:"/info",method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}};
    const req=https.request(options,(res)=>{
      let data="";
      res.on("data",(chunk)=>(data+=chunk));
      res.on("end",()=>{try{resolve(JSON.parse(data));}catch(e){reject(e);}});
    });
    req.on("error",reject); req.write(body); req.end();
  });
}

function buildPositionsMessage(address,state) {
  const positions=(state.assetPositions||[]).filter((p)=>parseFloat(p.position?.szi||0)!==0);
  const accountValue=fmt(state.marginSummary?.accountValue||0,2);
  const addrLine=CONFIG.ADDRESSES.length>1?`\n📍 地址：<code>${shortAddr(address)}</code>`:"";
  if(positions.length===0) {
    return `📊 <b>当前持仓快照</b>${addrLine}\n━━━━━━━━━━━━━━━━━━━━\n💼 账户净值：<b>$${accountValue}</b>\n📭 当前无持仓`;
  }
  const posLines=positions.map((p)=>{
    const pos=p.position;
    const size=parseFloat(pos.szi);
    const side=size>0?"🟢 多":"🔴 空";
    const pnl=parseFloat(pos.unrealizedPnl||0);
    const pnlStr=(pnl>=0?"+":"")+"$"+fmt(pnl,2);
    const lev=pos.leverage?.value?`${pos.leverage.value}x`:"-";
    return `  • <b>${pos.coin}</b> ${side} | 入场 $${fmt(pos.entryPx,4)} | 数量 ${fmt(Math.abs(size),4)} | 杠杆 ${lev} | 浮盈 ${pnlStr}`;
  });
  return `📊 <b>当前持仓快照</b>${addrLine}\n━━━━━━━━━━━━━━━━━━━━\n💼 账户净值：<b>$${accountValue}</b>\n📈 持仓数量：${positions.length} 个\n\n${posLines.join("\n")}\n━━━━━━━━━━━━━━━━━━━━\n🕐 ${new Date().toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}`;
}

async function sendAllPositions() {
  for(const addr of CONFIG.ADDRESSES) {
    try{log("INFO",`拉取持仓:${addr}`);const state=await fetchPositions(addr);sendTelegram(buildPositionsMessage(addr,state));}
    catch(e){log("ERROR",`获取持仓失败${addr}:${e.message}`);}
    if(CONFIG.ADDRESSES.length>1) await new Promise((r)=>setTimeout(r,1000));
  }
}

function buildFillMessage(fill,address) {
  const time=new Date(fill.time).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"});
  const isOpen=fill.dir&&fill.dir.toLowerCase().includes("open");
  const action=isOpen?"🚀 <b>开仓成交</b>":"📤 <b>平仓成交</b>";
  const addrLine=CONFIG.ADDRESSES.length>1?`\n📍 地址：<code>${shortAddr(address)}</code>`:"";
  return `${action}${addrLine}\n━━━━━━━━━━━━━━━━━━━━\n🪙 资产：<b>${fill.coin}</b>\n📊 方向：${formatDir(fill.dir)}\n💰 成交价：<b>$${fmt(fill.px)}</b>\n📦 数量：<b>${fmt(fill.sz)} ${fill.coin}</b>\n💵 手续费：${fmt(fill.fee)} ${fill.feeToken||"USDC"}\n🕐 时间：${time}\n🔗 <a href="https://hyperdash.com/address/${address}">查看地址</a>`;
}

function buildOrderMessage(order,address) {
  const time=new Date(order.timestamp).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"});
  const tpsl=order.isPositionTpsl?" (TP/SL)":"";
  const addrLine=CONFIG.ADDRESSES.length>1?`\n📍 地址：<code>${shortAddr(address)}</code>`:"";
  return `📋 <b>新挂单${tpsl}</b>${addrLine}\n━━━━━━━━━━━━━━━━━━━━\n🪙 资产：<b>${order.coin}</b>\n📊 方向：${formatSide(order.side)}\n💰 挂单价：<b>$${fmt(order.limitPx)}</b>\n📦 数量：<b>${fmt(order.origSz||order.sz)} ${order.coin}</b>\n🏷️ 类型：${order.orderType||order.tif||"Limit"}\n🕐 时间：${time}\n🆔 订单ID：<code>${order.oid}</code>\n🔗 <a href="https://hyperdash.com/address/${address}">查看地址</a>`;
}

function handleFills(fills,address) {
  if(!Array.isArray(fills)) fills=[fills];
  for(const item of fills) {
    const fill=item.fill||item;
    if(!fill.coin) continue;
    const isOpen=fill.dir&&fill.dir.toLowerCase().includes("open");
    log("INFO",`[${shortAddr(address)}] 成交:${fill.coin}|${fill.dir}|$${fill.px}|${fill.sz}`);
    if(isOpen) sendTelegram(buildFillMessage(fill,address));
  }
}

function handleOrderUpdates(orders,address) {
  if(!Array.isArray(orders)) orders=[orders];
  for(const item of orders) {
    const order=item.order||item;
    const status=item.status||"";
    if(!order.coin) continue;
    if(status==="open") {
      log("INFO",`[${shortAddr(address)}] 挂单:${order.coin}|${order.side==="B"?"Buy":"Sell"}|$${order.limitPx}`);
      sendTelegram(buildOrderMessage(order,address));
    }
  }
}

let reconnectDelay=CONFIG.RECONNECT_DELAY_MS;
let ws=null;
let pingInterval=null;

function connect() {
  log("INFO","正在连接 Hyperliquid WebSocket...");
  ws=new WebSocket(CONFIG.HL_WS_URL);
  ws.on("open",async()=>{
    log("INFO","WebSocket 已连接 ✅");
    reconnectDelay=CONFIG.RECONNECT_DELAY_MS;
    for(const addr of CONFIG.ADDRESSES) {
      ws.send(JSON.stringify({method:"subscribe",subscription:{type:"userFills",user:addr}}));
      ws.send(JSON.stringify({method:"subscribe",subscription:{type:"orderUpdates",user:addr}}));
      log("INFO",`✅ 已订阅:${addr}`);
    }
    pingInterval=setInterval(()=>{if(ws.readyState===WebSocket.OPEN)ws.ping();},30000);
    const addrList=CONFIG.ADDRESSES.map((a,i)=>`  ${i+1}. <code>${a}</code>`).join("\n");
    sendTelegram(`🟢 <b>监控已启动</b>\n━━━━━━━━━━━━━━━━━━━━\n📡 监控地址（${CONFIG.ADDRESSES.length} 个）：\n${addrList}\n🔔 实时通知开仓和挂单操作\n📊 正在拉取持仓快照...`);
    await sendAllPositions();
  });
  ws.on("message",(data)=>{
    let msg;try{msg=JSON.parse(data);}catch{return;}
    const channel=msg.channel;
    if(channel==="subscriptionResponse"||channel==="pong") return;
    if(channel==="userFills"){
      const payload=msg.data;
      if(payload?.isSnapshot) return;
      const fills=payload?.fills||[];
      if(fills.length===0) return;
      const addr=(payload?.user||CONFIG.ADDRESSES[0]).toLowerCase();
      handleFills(fills,addr);
    }
    if(channel==="orderUpdates"){
      const payload=msg.data;
      if(!Array.isArray(payload)||payload.length===0) return;
      const addr=(payload[0]?.order?.user||CONFIG.ADDRESSES[0]).toLowerCase();
      handleOrderUpdates(payload,addr);
    }
  });
  ws.on("ping",()=>ws.pong());
  ws.on("error",(err)=>log("ERROR",`WebSocket错误:${err.message}`));
  ws.on("close",(code)=>{
    clearInterval(pingInterval);
    log("WARN",`WebSocket断开(code=${code}),${reconnectDelay/1000}s后重连...`);
    setTimeout(()=>{reconnectDelay=Math.min(reconnectDelay*2,CONFIG.MAX_RECONNECT_DELAY_MS);connect();},reconnectDelay);
  });
}

log("INFO","=".repeat(50));
log("INFO","Hyperliquid 地址监控启动");
CONFIG.ADDRESSES.forEach((a,i)=>log("INFO",`  [${i+1}] ${a}`));
log("INFO","=".repeat(50));
connect();

process.on("SIGINT",()=>{
  log("INFO","收到退出信号，正在关闭...");
  sendTelegram(`🔴 <b>监控已停止</b>\n📡 已停止监控 ${CONFIG.ADDRESSES.length} 个地址`);
  if(ws) ws.close();
  process.exit(0);
});
