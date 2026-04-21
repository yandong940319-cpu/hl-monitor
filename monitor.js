/**
 * Hyperliquid 地址监控 + Telegram 通知
 * 功能：
 *  - 实时监控开仓成交 / 新挂单
 *  - 持仓变化时推送（对比上次快照）
 *  - 每天上午 10:00 (CST) 推送一次持仓日报（有变化才更新，无变化不重复发）
 *  - 支持多地址监控（TARGET_ADDRESSES 逗号分隔）
 */

const WebSocket = require("ws");
const https = require("https");
const cron = require("node-cron");
require("dotenv").config();

function parseAddresses() {
  const raw = process.env.TARGET_ADDRESSES || process.env.TARGET_ADDRESS || "";
  return raw.split(",").map(a => a.trim().toLowerCase()).filter(a => a.length > 0);
}

const CONFIG = {
  ADDRESSES: parseAddresses(),
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",
  HL_WS_URL: "wss://api.hyperliquid.xyz/ws",
  RECONNECT_DELAY_MS: 3000,
  MAX_RECONNECT_DELAY_MS: 60000,
  DAILY_CRON: "0 2 * * *",
};

if (CONFIG.ADDRESSES.length === 0) {
  console.error("❌ 未配置监控地址，请设置 TARGET_ADDRESSES 环境变量");
  process.exit(1);
}

const positionCache = {};

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

function buildPositionHash(positions) {
  if(!positions||positions.length===0) return "EMPTY";
  return positions.map(p=>`${p.position.coin}:${p.position.szi}:${p.position.entryPx}`).sort().join("|");
}

function sendTelegram(text) {
  const body=JSON.stringify({chat_id:CONFIG.TELEGRAM_CHAT_ID,text,parse_mode:"HTML",disable_web_page_preview:true});
  const options={hostname:"api.telegram.org",path:`/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`,method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}};
  const req=https.request(options,res=>{if(res.statusCode!==200)log("WARN",`Telegram响应异常:${res.statusCode}`);});
  req.on("error",e=>log("ERROR",`Telegram发送失败:${e.message}`));
  req.write(body); req.end();
}

function fetchPositions(address) {
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify({type:"clearinghouseState",user:address});
    const opts={hostname:"api.hyperliquid.xyz",path:"/info",method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}};
    const req=https.request(opts,res=>{let d="";res.on("data",c=>(d+=c));res.on("end",()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
    req.on("error",reject); req.write(body); req.end();
  });
}

function fetchOpenOrders(address) {
  return new Promise((resolve,reject)=>{
    const body=JSON.stringify({type:"openOrders",user:address});
    const opts={hostname:"api.hyperliquid.xyz",path:"/info",method:"POST",headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(body)}};
    const req=https.request(opts,res=>{let d="";res.on("data",c=>(d+=c));res.on("end",()=>{try{resolve(JSON.parse(d));}catch(e){reject(e);}});});
    req.on("error",reject); req.write(body); req.end();
  });
}

function buildPositionsMessage(address, state, openOrders, label="📊 <b>持仓快照</b>") {
  const positions=(state.assetPositions||[]).filter(p=>parseFloat(p.position?.szi||0)!==0);
  const accountValue=fmt(state.marginSummary?.accountValue||0,2);
  const marginUsed=fmt(state.marginSummary?.totalMarginUsed||0,2);
  const addrLine=CONFIG.ADDRESSES.length>1?`\n📍 <code>${shortAddr(address)}</code>`:"";
  const now=new Date().toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"});

  let posSection="";
  if(positions.length===0) {
    posSection="📭 当前无开放持仓";
  } else {
    posSection=positions.map(p=>{
      const pos=p.position;
      const size=parseFloat(pos.szi);
      const side=size>0?"🟢 多":"🔴 空";
      const pnl=parseFloat(pos.unrealizedPnl||0);
      const roe=pos.returnOnEquity?`ROE ${(parseFloat(pos.returnOnEquity)*100).toFixed(2)}%`:"";
      const pnlStr=(pnl>=0?"+":"")+"$"+fmt(pnl,2);
      const lev=pos.leverage?.value?`${pos.leverage.value}x`:"-";
      const liqPx=pos.liquidationPx?`$${fmt(pos.liquidationPx,2)}":"-";
      return `  <b>${pos.coin}</b> ${side} ${lev}\n  入场 $${fmt(pos.entryPx,4)} | 数量 ${fmt(Math.abs(size),4)}\n  浮盈 <b>${pnlStr}</b> ${roe}\n  强平价 ${liqPx}`;
    }).join("\n\n");
  }

  let orderSection="";
  if(openOrders&&openOrders.length>0) {
    orderSection="\n\n📋 <b>当前挂单</b>\n"+openOrders.map(o=>{
      const side=o.side==="B"?"🟢 买":"🔴 卖";
      return `  <b>${o.coin}</b> ${side} | $${fmt(o.limitPx)} × ${fmt(o.sz)}`;
    }).join("\n");
  }

  return `${label}${addrLine}\n━\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n💼 账户净值：<b>$${accountValue}</b>\n🔒 占用保证金：$${marginUsed}\n\n${posSection}${orderSection}\n━\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n🕐 ${now}`;
}

async function checkAndSendPositions(address, {forceSend=false, label}={}) {
  try {
    const [state, openOrders]=await Promise.all([fetchPositions(address),fetchOpenOrders(address)]);
    const positions=(state.assetPositions||[]).filter(p=>parseFloat(p.position?.szi||0)!==0);
    const newHash=buildPositionHash(positions);
    const cache=positionCache[address]||{};
    const changed=newHash!==cache.positionHash;
    log("INFO",`[${shortAddr(address)}] 持仓检查: ${positions.length}个仓位 挂单${(openOrders||[]).length}个 变化:${changed}`);
    if(forceSend||changed) {
      const msgLabel=label||(changed&&cache.positionHash?"🔄 <b>持仓已变化</b>":"📊 <b>持仓快照</b>");
      const text=buildPositionsMessage(address,state,openOrders,msgLabel);
      sendTelegram(text);
      positionCache[address]={positionHash:newHash,sentAt:Date.now()};
      return {changed:true};
    }
    return {changed:false};
  } catch(e) {
    log("ERROR",`[${shortAddr(address)}] 持仓拉取失败:${e.message}`);
    return {changed:false,error:e.message};
  }
}

async function sendInitialPositions() {
  for(const addr of CONFIG.ADDRESSES) {
    await checkAndSendPositions(addr,{forceSend:true,label:"📊 <b>持仓快照（启动）</b>"});
    if(CONFIG.ADDRESSES.length>1) await new Promise(r=>setTimeout(r,1000));
  }
}

async function dailyReport() {
  log("INFO","执行每日持仓日报...");
  let anyChanged=false;
  for(const addr of CONFIG.ADDRESSES) {
    const result=await checkAndSendPositions(addr,{forceSend:false,label:"📅 <b>每日持仓日报 (10:00)</b>"});
    if(result.changed) anyChanged=true;
    if(CONFIG.ADDRESSES.length>1) await new Promise(r=>setTimeout(r,1000));
  }
  if(!anyChanged) log("INFO","每日日报：持仓无变化，跳过推送");
}

function buildFillMessage(fill, address) {
  const time=new Date(fill.time).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"});
  const isOpen=fill.dir&&fill.dir.toLowerCase().includes("open");
  const action=isOpen?"🚀 <b>开仓成交</b>":"📤 <b>平仓成交</b>";
  const addrLine=CONFIG.ADDRESSES.length>1?`\n📍 <code>${shortAddr(address)}</code>`:"";
  return `${action}${addrLine}\n━\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n🪙 资产：<b>${fill.coin}</b>\n📊 方向：${formatDir(fill.dir)}\n💰 成交价：<b>$${fmt(fill.px)}</b>\n📦 数量：<b>${fmt(fill.sz)} ${fill.coin}</b>\n💵 手续费：${fmt(fill.fee)} ${fill.feeToken||"USDC"}\n🕐 时间：${time}\n🔗 <a href="https://hyperdash.com/address/${address}">查看地址</a>`;
}

function buildOrderMessage(order, address) {
  const time=new Date(order.timestamp).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"});
  const tpsl=order.isPositionTpsl?" (TP/SL)":"";
  const addrLine=CONFIG.ADDRESSES.length>1?`\n📍 <code>${shortAddr(address)}</code>`:"";
  return `📋 <b>新挂单${tpsl}</b>${addrLine}\n━\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n🪙 资产：<b>${order.coin}</b>\n📊 方向：${formatSide(order.side)}\n💰 挂单价：<b>$${fmt(order.limitPx)}</b>\n📦 数量：<b>${fmt(order.origSz||order.sz)} ${order.coin}</b>\n🏷️ 类型：${order.orderType||order.tif||"Limit"}\n🕐 时间：${time}\n🆔 订单ID：<code>${order.oid}</code>\n🔗 <a href="https://hyperdash.com/address/${address}">查看地址</a>`;
}

function handleFills(fills, address) {
  if(!Array.isArray(fills)) fills=[fills];
  for(const item of fills) {
    const fill=item.fill||item;
    if(!fill.coin) continue;
    const isOpen=fill.dir&&fill.dir.toLowerCase().includes("open");
    log("INFO",`[${shortAddr(address)}] 成交:${fill.coin}|${fill.dir}|$${fill.px}|${fill.sz}`);
    if(isOpen) sendTelegram(buildFillMessage(fill,address));
    // 平仓也通知请取消注释: else { sendTelegram(buildFillMessage(fill,address)); }
    setTimeout(()=>{ checkAndSendPositions(address,{label:"🔄 <b>持仓已变化</b>"}); },2000);
  }
}

function handleOrderUpdates(orders, address) {
  if(!Array.isArray(orders)) orders=[orders];
  for(const item of orders) {
    const order=item.order||item;
    const status=item.status||"";
    if(!order.coin) continue;
    if(status==="open") {
      log("INFO",`[${shortAddr(address)}] 新挂单:${order.coin}|${order.side==="B"?"Buy":"Sell"}|$${order.limitPx}`);
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
    pingInterval=setInterval(()=>{ if(ws.readyState===WebSocket.OPEN) ws.ping(); },30000);
    const addrList=CONFIG.ADDRESSES.map((a,i)=>`  ${i+1}. <code>${a}</code>`).join("\n");
    sendTelegram(`🟢 <b>监控已启动</b>\n━\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n📡 监控地址（${CONFIG.ADDRESSES.length}个）：\n${addrList}\n🔔 实时通知：开仓成交、新挂单、持仓变化\n📅 每日 10:00 推送持仓日报（有变化才推送）\n📊 正在拉取初始持仓...`);
    await sendInitialPositions();
  });
  ws.on("message",data=>{
    let msg; try{msg=JSON.parse(data);}catch{return;}
    const channel=msg.channel;
    if(channel==="subscriptionResponse"||channel==="pong") return;
    if(channel==="userFills") {
      const payload=msg.data;
      if(payload?.isSnapshot) return;
      const fills=payload?.fills||[];
      if(fills.length===0) return;
      const addr=(payload?.user||CONFIG.ADDRESSES[0]).toLowerCase();
      handleFills(fills,addr);
    }
    if(channel==="orderUpdates") {
      const payload=msg.data;
      if(!Array.isArray(payload)||payload.length===0) return;
      const addr=(payload[0]?.order?.user||CONFIG.ADDRESSES[0]).toLowerCase();
      handleOrderUpdates(payload,addr);
    }
  });
  ws.on("ping",()=>ws.pong());
  ws.on("error",err=>log("ERROR",`WebSocket错误:${err.message}`));
  ws.on("close",code=>{
    clearInterval(pingInterval);
    log("WARN",`WebSocket断开(code=${code}),${reconnectDelay/1000}s后重连...`);
    setTimeout(()=>{reconnectDelay=Math.min(reconnectDelay*2,CONFIG.MAX_RECONNECT_DELAY_MS);connect();},reconnectDelay);
  });
}

cron.schedule(CONFIG.DAILY_CRON,()=>{
  log("INFO","触发每日持仓日报 (10:00 CST)");
  dailyReport();
},{timezone:"UTC"});

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
