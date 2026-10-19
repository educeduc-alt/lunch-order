const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  },
});

const getErrorMessage = (data, fallback) => data?.error?.message || data?.message || fallback;
const isLocationError = (message) => /location is not supported|unsupported location/i.test(message || '');
const isThinkingConfigError = (message) => /thinking/i.test(message || '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 2026-10-08 起，Google 已將這些模型 ID 自動轉送到其他模型：
//   gemini-3.7-flash → gemini-3.8-flash
//   gemini-3.5-flash → gemini-3.6-flash
// 放在備援清單裡等於重複打同一個（可能正忙碌的）模型，白白耗掉逾時預算，所以排除。
// 2.5 系列只開放給先前有用量的帳號，也一併排除。
const SKIPPED_MODELS = new Set([
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
]);

// 菜單辨識不需要深度推理；降低思考等級可大幅縮短回應時間。
// 3.8 Flash 不支援 minimal（會回 400），最低只能 low。
const THINKING_LEVEL = {
  'gemini-3.8-flash': 'low',
  'gemini-3.6-flash': 'minimal',
  'gemini-3.5-flash-lite': 'minimal',
};

// 每個模型「最多」等待的秒數。最後一個模型拿剩下的全部時間。
const PLANNED_TIMEOUT_MS = {
  'gemini-3.8-flash': 20000,
  'gemini-3.6-flash': 14000,
};
const DEFAULT_TIMEOUT_MS = 15000;
const LAST_MODEL_RESERVE_MS = 10000; // 保留給最後一個（最快的）備援模型
const TOTAL_BUDGET_MS = 48000;       // 前端單一代理等待上限為 55 秒

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

  const models = [
    (env.GEMINI_MODEL || '').trim() || 'gemini-3.8-flash',
    (env.GEMINI_FALLBACK_MODEL || '').trim(),
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash-lite',
  ]
    .filter((model, index, list) => model && !SKIPPED_MODELS.has(model) && list.indexOf(model) === index)
    .slice(0, 3);

  const configuredTimeout = Number(env.GEMINI_MODEL_TIMEOUT_MS);
  const overrideTimeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(30000, Math.max(8000, configuredTimeout))
    : null;

  const retryableStatuses = new Set([429, 500, 502, 503, 504, 524]);
  const startedAt = Date.now();
  const attemptedModels = [];
  let lastStatus = 503;
  let lastError = 'Gemini 目前忙碌，請稍後再試';
  let outputText = '';
  let usedModel = models[0];
  let usage = null;

  const callModel = async (model, timeoutMs, useThinkingConfig) => {
    const generationConfig = {
      responseMimeType: 'application/json',
      temperature: 0.1,
    };
    if (useThinkingConfig && THINKING_LEVEL[model]) {
      generationConfig.thinkingConfig = { thinkingLevel: THINKING_LEVEL[model] };
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': apiKey,
          },
          body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
        },
      );
      // 讀取 body 也在逾時範圍內，避免卡在串流中途。
      const responseText = await response.text();
      return { response, responseText };
    } finally {
      clearTimeout(timeoutId);
    }
  };

  for (let index = 0; index < models.length; index++) {
    const model = models[index];
    const isLast = index === models.length - 1;
    const remainingMs = TOTAL_BUDGET_MS - (Date.now() - startedAt);
    if (remainingMs < 3000) {
      lastStatus = 504;
      lastError = `AI 解析已達 ${Math.round(TOTAL_BUDGET_MS / 1000)} 秒上限`;
      break;
    }

    const plannedMs = overrideTimeoutMs || PLANNED_TIMEOUT_MS[model] || DEFAULT_TIMEOUT_MS;
    const timeoutMs = isLast
      ? remainingMs
      : Math.max(3000, Math.min(plannedMs, remainingMs - LAST_MODEL_RESERVE_MS));

    usedModel = model;
    attemptedModels.push(model);

    let result;
    const modelStartedAt = Date.now();
    try {
      result = await callModel(model, timeoutMs, true);
      // 萬一 Google 調整了思考等級規則，不帶 thinkingConfig 再試一次同一模型。
      if (result.response.status === 400) {
        let message = '';
        try { message = getErrorMessage(JSON.parse(result.responseText), ''); } catch {}
        if (isThinkingConfigError(message)) {
          const retryMs = Math.max(3000, timeoutMs - (Date.now() - modelStartedAt));
          result = await callModel(model, retryMs, false);
        }
      }
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      lastStatus = timedOut ? 504 : 502;
      lastError = timedOut
        ? `${model} 超過 ${Math.round(timeoutMs / 1000)} 秒未回應`
        : `無法連線 Gemini API：${error.message}`;
      continue;
    }

    const { response, responseText } = result;
    lastStatus = response.status;
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
      if (isLocationError(lastError)) {
        return jsonResponse({
          error: 'Google 將目前 Cloudflare 代理節點判定為不支援地區。這不是圖片問題，請重新部署新版代理；若仍發生，需改用固定地區的 Google Cloud／Supabase Edge Function。',
          code: 'GEMINI_LOCATION_UNSUPPORTED',
          retryable: false,
          attempted_models: attemptedModels,
        }, 503);
      }
      if (response.status === 404 || retryableStatuses.has(response.status)) {
        // 忙碌時稍等一下再換模型，降低連續撞到同一波尖峰的機率。
        if (!isLast) await sleep(500);
        continue;
      }
      return jsonResponse({ error: lastError, retryable: false, attempted_models: attemptedModels }, response.status);
    }

    const candidate = data.candidates?.[0];
    outputText = (candidate?.content?.parts || [])
      .filter((part) => !part?.thought)
      .map((part) => part?.text || '')
      .join('')
      .trim();
    usage = data.usageMetadata || null;
    if (outputText) break;

    lastStatus = 422;
    lastError = data.promptFeedback?.blockReason
      ? `Gemini 拒絕解析：${data.promptFeedback.blockReason}`
      : `Gemini 沒有輸出內容${candidate?.finishReason ? `（${candidate.finishReason}）` : ''}`;
  }

  if (!outputText) {
    return jsonResponse({
      error: attemptedModels.length > 1
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
