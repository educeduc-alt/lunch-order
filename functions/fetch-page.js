// 網頁菜單解析用：在 Cloudflare 伺服器端讀取店家菜單網頁，回傳網頁文字和可能是菜單的圖片。
// 瀏覽器不能直接讀別的網站（跨網域限制），所以要經過這裡。
// 前端拿到內容後，照原本的 AI 解析流程送給 Gemini。

const MAX_HTML_BYTES = 3 * 1024 * 1024;   // 網頁本身最多讀 3MB
const MAX_TEXT_CHARS = 40000;             // 交給 AI 的文字上限
const MAX_IMAGES = 4;                     // 最多附幾張圖
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;  // 每張圖最多 3MB
const FETCH_TIMEOUT_MS = 15000;

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  },
});

// 只允許公開網站，擋掉本機和內網位址
const isBlockedHost = (hostname) => {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === '::1' || /^f[cd][0-9a-f]{2}:/i.test(host) || /^fe80:/i.test(host)) return true;
  return false;
};

const fetchWithTimeout = async (url, options = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.6',
        ...(options.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
};

const readLimited = async (response, limit) => {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(await response.arrayBuffer()).slice(0, limit);
  const chunks = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  try { reader.cancel(); } catch {}
  const out = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const chunk of chunks) {
    const piece = chunk.slice(0, out.length - offset);
    out.set(piece, offset);
    offset += piece.length;
    if (offset >= out.length) break;
  }
  return out;
};

const decodeEntities = (text) => text
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

// 把 HTML 變成好讀的純文字（保留換行，讓品名和價格不會黏在一起）
const htmlToText = (html) => {
  const jsonLd = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim())
    .filter((t) => /menu|offers|price/i.test(t))
    .join('\n');
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(br|\/p|\/li|\/tr|\/h[1-6]|\/div|\/section|\/article|\/dd|\/dt)[^>]*>/gi, '\n')
    .replace(/<\/t[dh]>/gi, '\t')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return (jsonLd ? `【網頁內建菜單資料】\n${jsonLd.slice(0, 15000)}\n\n` : '') + text;
};

// 找出可能是菜單的圖片：檔名或說明有 menu／菜單／價目，或是分享預覽圖
const findImageUrls = (html, baseUrl) => {
  const found = [];
  const push = (src, score) => {
    if (!src || /^data:/i.test(src)) return;
    let url;
    try { url = new URL(decodeEntities(src.trim()), baseUrl).href; } catch { return; }
    if (!/^https?:/i.test(url)) return;
    if (/\.(svg|gif|ico)(\?|$)/i.test(url) || /logo|icon|avatar|sprite|banner-ad|pixel|tracking/i.test(url)) return;
    const existing = found.find((item) => item.url === url);
    if (existing) existing.score = Math.max(existing.score, score);
    else found.push({ url, score });
  };
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/gi)) {
    const content = m[0].match(/content=["']([^"']+)["']/i)?.[1];
    push(content, 2);
  }
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = tag.match(/\s(?:data-src|data-original|src)=["']([^"']+)["']/i)?.[1];
    const hint = `${src || ''} ${tag.match(/alt=["']([^"']*)["']/i)?.[1] || ''}`;
    const width = Number(tag.match(/width=["']?(\d+)/i)?.[1] || 0);
    let score = 1;
    if (/menu|菜單|價目|價格|price|餐點|飲品|drink/i.test(hint)) score += 5;
    if (width >= 500) score += 2;
    else if (width && width < 150) score -= 3;
    push(src, score);
  }
  return found.filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
};

const toBase64 = (bytes) => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

export const onRequest = async ({ request }) => {
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
      },
    });
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'Method Not Allowed' }, 405);

  let target;
  try {
    const body = await request.json();
    target = new URL(String(body?.url || '').trim());
  } catch {
    return jsonResponse({ error: '網址格式不正確，請貼上完整網址（https:// 開頭）' }, 400);
  }
  if (!/^https?:$/.test(target.protocol)) return jsonResponse({ error: '只支援 http／https 網址' }, 400);
  if (isBlockedHost(target.hostname)) return jsonResponse({ error: '不能讀取這個網址' }, 400);

  let page;
  try {
    page = await fetchWithTimeout(target.href, { headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
  } catch (error) {
    return jsonResponse({ error: error?.name === 'AbortError' ? '網頁讀取逾時，請稍後再試' : `無法連到這個網頁：${error.message}` }, 502);
  }
  if (!page.ok) return jsonResponse({ error: `網頁回應錯誤（${page.status}），可能需要登入或網站不允許讀取` }, 502);

  const finalUrl = page.url || target.href;
  const contentType = page.headers.get('content-type') || '';
  const images = [];

  // 網址本身就是一張圖片：直接當菜單圖
  if (/^image\//i.test(contentType)) {
    const bytes = await readLimited(page, MAX_IMAGE_BYTES + 1);
    if (bytes.length > MAX_IMAGE_BYTES) return jsonResponse({ error: '圖片太大（超過 3MB），請下載後用上傳圖片解析' }, 413);
    return jsonResponse({ title: '', text: '', finalUrl, images: [{ mime: contentType.split(';')[0], data: toBase64(bytes), url: finalUrl }] });
  }
  if (/application\/pdf/i.test(contentType)) {
    return jsonResponse({ error: '這是 PDF 檔，請下載後用「上傳圖片」解析' }, 415);
  }

  const htmlBytes = await readLimited(page, MAX_HTML_BYTES);
  const charset = (contentType.match(/charset=([\w-]+)/i)?.[1] || 'utf-8').toLowerCase();
  let html;
  try { html = new TextDecoder(charset).decode(htmlBytes); } catch { html = new TextDecoder('utf-8').decode(htmlBytes); }

  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  const text = htmlToText(html).slice(0, MAX_TEXT_CHARS);

  for (const candidate of findImageUrls(html, finalUrl)) {
    if (images.length >= MAX_IMAGES) break;
    try {
      const host = new URL(candidate.url).hostname;
      if (isBlockedHost(host)) continue;
      const response = await fetchWithTimeout(candidate.url, { headers: { Accept: 'image/*', Referer: finalUrl } });
      const type = (response.headers.get('content-type') || '').split(';')[0];
      if (!response.ok || !/^image\/(jpeg|png|webp)$/i.test(type)) continue;
      const bytes = await readLimited(response, MAX_IMAGE_BYTES + 1);
      if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 15000) continue; // 太小的通常是圖示
      images.push({ mime: type, data: toBase64(bytes), url: candidate.url });
    } catch {}
  }

  if (text.length < 30 && !images.length) {
    return jsonResponse({ error: '這個網頁讀不到菜單內容（可能要登入，或是用程式動態載入，例如外送平台）。請改用截圖上傳。' }, 422);
  }
  return jsonResponse({ title, text, finalUrl, images });
};
