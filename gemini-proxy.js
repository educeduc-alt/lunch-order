const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  },
});

const getErrorMessage = (data, fallback) => data?.error?.message || data?.message || fallback;
const isLocationError = (message) => /location is not supported|unsupported location/i.test(message || '');

export const onRequest = async ({ request, env }) => {
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

  const apiKey = (env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return jsonResponse({ error: 'GEMINI_API_KEY 未設定' }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: '無效的請求格式' }, 400);
  }

  const sourceContent = body?.messages?.[0]?.content;
  if (!Array.isArray(sourceContent) || sourceContent.length === 0) {
    return jsonResponse({ error: '缺少圖片或解析提示' }, 400);
  }

  // 菜單解析只需要一次圖片輸入與一次 JSON 輸出。generateContent 比
  // Interactions API 更精簡，也避免部分邊緣節點對 Interactions 的地區誤判。
  const parts = sourceContent.map((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return { text: part.text };
    if (part?.type === 'image' && part.source?.type === 'base64') {
      return {
        inlineData: {
          mimeType: part.source.media_type || 'image/jpeg',
          data: part.source.data,
        },
      };
    }
    return null;
  }).filter(Boolean);

  if (!parts.some((part) => part.inlineData) || !parts.some((part) => part.text)) {
    return jsonResponse({ error: '請求必須包含圖片和文字提示' }, 400);
  }

  const configuredModel = (env.GEMINI_MODEL || '').trim();
  const retiredModels = new Set(['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  const primaryModel = configuredModel && !retiredModels.has(configuredModel)
    ? configuredModel
    : 'gemini-3.8-flash';
  const models = [
    primaryModel,
    (env.GEMINI_FALLBACK_MODEL || '').trim(),
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
  ]
    .filter((model, index, list) => model && !retiredModels.has(model) && list.indexOf(model) === index)
    .slice(0, 4);

  const retryableStatuses = new Set([429, 500, 502, 503, 504, 524]);
  const configuredTimeout = Number(env.GEMINI_MODEL_TIMEOUT_MS);
  const modelTimeoutMs = Number.isFinite(configuredTimeout)
    ? Math.min(25000, Math.max(8000, configuredTimeout))
    : 15000;
  const totalBudgetMs = 45000;
  const startedAt = Date.now();
  const attemptedModels = [];
  let lastStatus = 503;
  let lastError = 'Gemini 目前忙碌，請稍後再試';
  let outputText = '';
  let usedModel = models[0];
  let usage = null;

  for (const model of models) {
    const remainingMs = totalBudgetMs - (Date.now() - startedAt);
    if (remainingMs < 2000) {
      lastStatus = 504;
      lastError = 'AI 解析已達 45 秒上限';
      break;
    }

    usedModel = model;
    attemptedModels.push(model);
    const controller = new AbortController();
    const timeoutMs = Math.min(modelTimeoutMs, remainingMs);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: {
              responseMimeType: 'application/json',
              temperature: 0.1,
            },
          }),
        },
      );
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      lastStatus = timedOut ? 504 : 502;
      lastError = timedOut
        ? `${model} 排隊超過 ${Math.round(timeoutMs / 1000)} 秒`
        : `無法連線 Gemini API：${error.message}`;
      continue;
    } finally {
      clearTimeout(timeoutId);
    }

    lastStatus = response.status;
    const responseText = await response.text();
    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      lastError = response.status === 524
        ? 'Gemini 回應逾時'
        : `Gemini 回應格式錯誤：${responseText.slice(0, 120)}`;
      if (retryableStatuses.has(response.status)) continue;
      return jsonResponse({ error: lastError, retryable: false }, 502);
    }

    if (!response.ok) {
      lastError = getErrorMessage(data, `Gemini API 錯誤 ${response.status}`);
      // 地區限制取決於代理伺服器的出口 IP，換模型不會改善，因此直接回傳明確說明。
      if (isLocationError(lastError)) {
        return jsonResponse({
          error: 'Google 將目前 Cloudflare 代理節點判定為不支援地區。這不是圖片問題，請重新部署新版代理；若仍發生，需改用固定地區的 Google Cloud／Supabase Edge Function。',
          code: 'GEMINI_LOCATION_UNSUPPORTED',
          retryable: false,
          attempted_models: attemptedModels,
        }, 503);
      }
      if (response.status === 404 || retryableStatuses.has(response.status)) continue;
      return jsonResponse({ error: lastError, retryable: false }, response.status);
    }

    outputText = (data.candidates?.[0]?.content?.parts || [])
      .map((part) => part?.text || '')
      .join('')
      .trim();
    usage = data.usageMetadata || null;
    if (outputText) break;

    lastStatus = 422;
    lastError = data.promptFeedback?.blockReason
      ? `Gemini 拒絕解析：${data.promptFeedback.blockReason}`
      : 'Gemini 沒有輸出內容';
  }

  if (!outputText) {
    return jsonResponse({
      error: models.length > 1
        ? `${lastError}，已自動切換 ${attemptedModels.length} 個模型仍未成功，請稍候再試`
        : `${lastError}，請稍候再試`,
      retryable: retryableStatuses.has(lastStatus),
      attempted_models: attemptedModels,
    }, retryableStatuses.has(lastStatus) ? 503 : 422);
  }

  // 維持既有前端讀取方式：d.content[0].text
  return jsonResponse({
    content: [{ type: 'text', text: outputText }],
    model: usedModel,
    attempted_models: attemptedModels,
    usage,
  });
};
