import { BUILD_ID } from './protocol.js';

const entries = [];
export function netLog(event, details = {}) {
  const entry = { at: new Date().toISOString(), event, ...details };
  entries.push(entry);
  if (entries.length > 200) entries.shift();
  return entry;
}
export function connectionReport(extra = {}) {
  return JSON.stringify({ build: BUILD_ID, browser: globalThis.navigator?.userAgent ?? '',
    secureContext: globalThis.isSecureContext ?? false, online: globalThis.navigator?.onLine ?? null,
    webrtc: typeof globalThis.RTCPeerConnection === 'function', ...extra, events: entries }, null, 2);
}
export function lanPageURL(text) {
  const raw = String(text ?? '').trim();
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`); }
  catch { throw new Error('请输入开服窗口显示的完整局域网网址'); }
  const host = url.hostname;
  const ipv4 = host.split('.').map(Number);
  const privateIPv4 = ipv4.length === 4 && ipv4.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (ipv4[0] === 10 || (ipv4[0] === 192 && ipv4[1] === 168) || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31));
  const privateIPv6 = /^\[(?:fd|fc|fe80:)[a-f\d:]+\]$/i.test(host);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || !(privateIPv4 || privateIPv6 || /^[a-z\d-]+\.local$/i.test(host))) {
    throw new Error('请填写 192.168…、10.… 等局域网地址；不能填 localhost（那是每个人自己的电脑）');
  }
  url.hash = '';
  return url.href;
}
