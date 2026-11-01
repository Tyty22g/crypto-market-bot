import { escapeHtml, fmt, signed, formatTime } from "./util.js";

export const coinName = s => s.replace(/USDT$/, "");

export function channelButton(ch) {
  if (!ch.channelUrl) return undefined;
  return {
    inline_keyboard: [[{
      text: ch.buttonText || `📢 JOIN ${ch.title}`,
      url: ch.channelUrl
    }]]
  };
}

const SEP = "━━━━━━━━━━━━━━━━━━";
const footer = (ch, now, src = "Binance Spot") =>
  `${SEP}\n🕒 ${formatTime(now, ch.tzOffset)}\n📡 Source: ${src}`;

function plainPrice(x, group = false) {
  let s = String(x).trim();
  if (/^\d+\.\d+$/.test(s)) s = s.replace(/0+$/, "").replace(/\.$/, "");
  else if (!/^\d+$/.test(s)) {
    const n = Number(s);
    s = Number.isFinite(n) ? n.toFixed(8).replace(/\.?0+$/, "") : s;
  }
  if (group && /^\d+(\.\d+)?$/.test(s)) {
    const [i, f] = s.split(".");
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : "");
  }
  return s;
}

// قناة سعر فقط: رسالة قصيرة لكل عملة مثل $5677.77666
export function buildPriceOnly(ch, map) {
  const tpl = escapeHtml(ch.priceTemplate || "${price}");
  const out = [];
  for (const s of ch.symbols) {
    const t = map.get(s);
    if (!t) continue;
    const pct = Number(t.priceChangePercent);
    const arrow = pct > 0 ? "🟢▲" : pct < 0 ? "🔴▼" : "⚪";
    out.push(tpl
      .replaceAll("{arrow}", arrow)
      .replaceAll("{price}", plainPrice(t.lastPriceRaw ?? t.lastPrice, ch.priceGrouping))
      .replaceAll("{symbol}", coinName(s))
      .replaceAll("{change}", signed(Math.round(pct * 100) / 100, "%")));
  }
  if (!out.length) throw new Error("NO_PRICE_DATA");
  return out;
}

// ---------- الأسعار ----------

function priceRows(ch, map) {
  const rows = [];

  for (const symbol of ch.symbols) {
    const t = map.get(symbol);
    if (!t) continue;

    const pct = Number(t.priceChangePercent);
    const emoji = pct > 0 ? "🟢 ▲" : pct < 0 ? "🔴 ▼" : "⚪ ●";

    let row = `${emoji} <b>${escapeHtml(coinName(symbol))}/USDT</b>\n`;
    row += `Price: <b>$${fmt(t.lastPrice)}</b>\n`;
    row += `24H Change: ${signed(t.priceChange, " USDT")} (${signed(pct, "%")})`;

    if (ch.showHighLow) {
      row += `\n24H High: $${fmt(t.highPrice)} | Low: $${fmt(t.lowPrice)}`;
    }
    if (ch.showVolume) {
      row += `\n24H Volume: $${fmt(t.quoteVolume, 7)}`;
      if (Number.isFinite(Number(t.count))) row += `\nTrades: ${fmt(t.count, 0)}`;
    }
    rows.push(row);
  }

  return rows;
}

// يتجاوز حد تيليغرام (4096)؟ ينقسم لعدة رسائل بدل ما يفشل
export function buildPriceMessages(ch, map, now) {
  const rows = priceRows(ch, map);
  if (!rows.length) throw new Error("NO_PRICE_DATA");

  const rowSep = `\n\n${SEP}\n\n`;
  const foot = `\n\n${footer(ch, now, map.sourceName)}`;
  const head = (i, n) =>
    `📊 <b>${escapeHtml(ch.title)}</b>\n` +
    `<b>LIVE CRYPTO MARKET UPDATE${n > 1 ? ` (${i}/${n})` : ""}</b>\n${SEP}\n\n`;

  const LIMIT = 3800;
  const chunks = [];
  let cur = [];

  for (const row of rows) {
    const trial = [...cur, row].join(rowSep);
    if (cur.length && head(9, 9).length + trial.length + foot.length > LIMIT) {
      chunks.push(cur);
      cur = [row];
    } else {
      cur.push(row);
    }
  }
  chunks.push(cur);

  return chunks.map((c, i) => head(i + 1, chunks.length) + c.join(rowSep) + foot);
}

// ---------- التقارير ----------

export function windowItem(symbol, t) {
  if (!t || !Number.isFinite(Number(t.priceChangePercent))) {
    return { symbol, available: false };
  }
  return {
    symbol,
    available: true,
    close: Number(t.lastPrice),
    change: Number(t.priceChange),
    percent: Number(t.priceChangePercent)
  };
}

export const REPORTS = {
  hourly: {
    icon: "📊", heading: "HOURLY MARKET ANALYSIS", win: "1H", threshold: 0.5,
    gainers: "🏆 TOP GAINERS", losers: "📉 TOP LOSERS",
    note: "⚠️ Market data is informational, not financial advice."
  },
  four_hour: {
    icon: "🌍", heading: "4-HOUR MARKET TREND REPORT", win: "4H", threshold: 0.5,
    gainers: "🚀 TOP PERFORMERS", losers: "📉 WEAKEST PERFORMERS",
    note: "⚠️ Informational report, not financial advice."
  },
  daily: {
    icon: "🗓️", heading: "DAILY MARKET SUMMARY", win: "24H", threshold: 1,
    gainers: "🏆 TOP GAINERS", losers: "📉 TOP LOSERS",
    note: "⚠️ Informational report, not financial advice."
  },
  weekly: {
    icon: "📈", heading: "WEEKLY MARKET REVIEW", win: "7D", threshold: 3,
    gainers: "🏆 BEST OF THE WEEK", losers: "📉 WEAKEST OF THE WEEK",
    note: "⚠️ Informational report, not financial advice."
  }
};

function direction(items, threshold) {
  const valid = items.filter(x => x.available);
  if (!valid.length) return { label: "DATA UNAVAILABLE", emoji: "⚪" };

  const average = valid.reduce((s, x) => s + x.percent, 0) / valid.length;
  if (average >= threshold) return { label: "BULLISH MARKET", emoji: "🟢", average };
  if (average <= -threshold) return { label: "BEARISH MARKET", emoji: "🔴", average };
  return { label: "SIDEWAYS MARKET", emoji: "🟡", average };
}

const movers = list =>
  list.length
    ? list.map(x =>
        `${x.percent < 0 ? "🔴" : "🟢"} ${escapeHtml(coinName(x.symbol))}: ${signed(x.percent, "%")}`
      ).join("\n")
    : "No data available.";

function rsiLabel(v) {
  if (v >= 70) return "Overbought";
  if (v <= 30) return "Oversold";
  return "Neutral";
}

function technicalsBlock(tech, win) {
  const lines = tech.filter(t => t.rsi !== null).map(t => {
    let line = `${escapeHtml(coinName(t.symbol))}: RSI ${t.rsi.toFixed(1)} (${rsiLabel(t.rsi)})`;
    if (t.ma20 !== null) line += ` · ${t.close >= t.ma20 ? "▲" : "▼"} MA20`;
    if (t.ma50 !== null) line += ` · ${t.close >= t.ma50 ? "▲" : "▼"} MA50`;
    return line;
  });

  return lines.length ? `\n\n${SEP}\n<b>TECHNICALS · ${win}</b>\n${lines.join("\n")}` : "";
}

export function buildReport(ch, items, spec, tech, now) {
  const dir = direction(items, spec.threshold);
  const valid = items.filter(x => x.available);
  const sorted = [...valid].sort((a, b) => b.percent - a.percent);
  const gainers = sorted.slice(0, 5);
  const losers = [...sorted].reverse().slice(0, 5);

  let m = `${spec.icon} <b>${escapeHtml(ch.title)}</b>\n<b>${spec.heading}</b>\n${SEP}\n\n`;
  m += `${dir.emoji} <b>${dir.label}</b>\n`;
  if (dir.average !== undefined) {
    m += `Average selected-coin movement: ${signed(dir.average, "%")}\n`;
  }
  m += `Coins analyzed: ${valid.length}/${ch.symbols.length}\n\n${SEP}\n`;
  m += `${spec.gainers} · ${spec.win}\n${movers(gainers)}\n\n`;
  m += `${spec.losers} · ${spec.win}\n${movers(losers)}`;

  const btc = items.find(x => x.symbol === "BTCUSDT");
  if (btc) {
    m += `\n\n${SEP}\n<b>BITCOIN STATUS</b>\n`;
    m += btc.available
      ? `Price: $${fmt(btc.close)}\n${spec.win} Change: ${signed(btc.change)} (${signed(btc.percent, "%")})`
      : "Bitcoin data unavailable.";
  }

  if (tech && tech.length) m += technicalsBlock(tech, spec.win);

  m += `\n\n${footer(ch, now)}\n${spec.note}`;
  return m;
}

// ---------- التنبيهات ----------

export function buildMoveAlert(ch, symbol, change, minutes, from, to, now) {
  const up = change > 0;
  return (
    `${up ? "🚀" : "🔻"} <b>PRICE ALERT · ${escapeHtml(coinName(symbol))}/USDT</b>\n` +
    `${up ? "🟢 ▲" : "🔴 ▼"} ${signed(Math.round(change * 100) / 100, "%")} in ${minutes}m\n` +
    `From: $${fmt(from)} → Now: <b>$${fmt(to)}</b>\n\n${footer(ch, now)}`
  );
}

export function buildLevelAlert(ch, level, price, now) {
  return (
    `🎯 <b>PRICE LEVEL · ${escapeHtml(coinName(level.symbol))}/USDT</b>\n` +
    `Crossed ${level.dir === "above" ? "above ▲" : "below ▼"} $${fmt(level.price)}\n` +
    `Now: <b>$${fmt(price)}</b>\n\n${footer(ch, now)}`
  );
}
