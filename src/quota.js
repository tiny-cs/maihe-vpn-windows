// 麦禾 VPN — 免费额度（与 Android 版同一规则，本地执行）
// 免费：每日 500 MB，每月上限 10 GB，先到先停。看激励视频在 Windows 上
// 没有 AdMob，所以 Windows 版不提供“看广告 +1 GB”，只显示额度。
// 重要：这是本机本地记账，没有账号、没有服务端。换电脑 / 清数据后
// 额度会重置，不能当成服务端的防刷限流，也不能用来向他人收费。
// Pro 在 Windows 版只是本地占位开关（见 README），后端容量并没有变。
'use strict';

const MB = 1024 * 1024;
const DAILY_FREE_BYTES = 500 * MB;
const MONTHLY_FREE_BYTES = 10 * 1024 * MB;
const REWARD_BYTES = 0; // Windows 无 AdMob，不提供奖励流量

function todayKey(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
}
function monthKey(d) {
  const t = d || new Date();
  return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0');
}

function defaultQuota() {
  return { day: todayKey(), dayUsed: 0, month: monthKey(), monthUsed: 0, pro: false, updatedAt: Date.now() };
}

function normalizeQuota(q) {
  const out = Object.assign(defaultQuota(), q || {});
  if (out.day !== todayKey()) { out.day = todayKey(); out.dayUsed = 0; }
  if (out.month !== monthKey()) { out.month = monthKey(); out.monthUsed = 0; }
  out.dayUsed = Math.max(0, out.dayUsed || 0);
  out.monthUsed = Math.max(0, out.monthUsed || 0);
  return out;
}

function checkQuota(q) {
  const quota = normalizeQuota(q);
  if (quota.pro) return { allowed: true, quota };
  if (quota.dayUsed >= DAILY_FREE_BYTES) {
    return { allowed: false, quota, reason: '今日免费流量已用完（500 MB），明天 0 点重置。' };
  }
  if (quota.monthUsed >= MONTHLY_FREE_BYTES) {
    return { allowed: false, quota, reason: '本月免费流量已用完（10 GB），下月 1 日重置。' };
  }
  return { allowed: true, quota };
}

function addUsage(q, bytes) {
  const quota = normalizeQuota(q);
  quota.dayUsed += Math.max(0, bytes || 0);
  quota.monthUsed += Math.max(0, bytes || 0);
  quota.updatedAt = Date.now();
  return quota;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  if (bytes < MB) return Math.round(bytes / 1024) + ' KB';
  if (bytes < 1024 * MB) return (bytes / MB).toFixed(1) + ' MB';
  return (bytes / (1024 * MB)).toFixed(2) + ' GB';
}

module.exports = {
  MB, DAILY_FREE_BYTES, MONTHLY_FREE_BYTES, REWARD_BYTES,
  todayKey, monthKey, defaultQuota, normalizeQuota, checkQuota, addUsage, formatBytes,
};
