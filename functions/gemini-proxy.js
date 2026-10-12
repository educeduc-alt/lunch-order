const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  },
});

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

  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Method Not Allowed' }, 405);
  }

  const apiKey = (env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return jsonResponse({ error: 'GEMINI_API_KEY 未設定' }, 500);
  }

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

  const input = sourceContent.map((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') {
      return { type: 'text', text: part.text };
    }

    if (part?.type === 'image' && part.source?.type === 'base64') {
      return {
        type: 'image',
        mime_type: part.source.media_type || 'image/jpeg',
        data: part.source.data,
      };
    }

    return null;
  }).filter(Boolean);

  if (!input.some((part) => part.type === 'image') || !input.some((part) => part.type === 'text')) {
    return jsonResponse({ error: '請求必須包含圖片和文字提示' }, 400);
  }

  // 新帳戶已無法使用 Gemini 2.5。未指定模型時使用目前穩定的 3.8 Flash。
  const configuredModel = (env.GEMINI_MODEL || '').trim();
  const retiredModels = new Set(['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  const primaryModel = configuredModel && !retiredModels.has(configuredModel)
    ? configuredModel
    : 'gemini-3.8-flash';
  // 每次請求最多嘗試四個模型；單一模型逾時就立刻切換，避免一直卡在熱門模型的佇列。
  const models = [
    primaryModel,
    (env.GEMINI_FALLBACK_MODEL || '').trim(),
    'gemini-3.7-flash',
    'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite',
  ]
    .filter((model, index, list) => model && !retiredModels.has(model) && list.indexOf(model) === index)
    .slice(0, 4);
  const retryableStatuses = new Set([429, 500, 502, 503, 504, 524]);
  const endpoint = 'https://generativelanguage.googleapis.com/v1beta/interactions';
  const configuredTimeout = Number(env.GEMINI_MODEL_TIMEOUT_MS);
  const modelTimeoutMs = Number.isFinite(configuredTimeout)
    ? Math.min(25000, Math.max(8000, configuredTimeout))
    : 15000;
  const totalBudgetMs = 45000;
  const startedAt = Date.now();

  let geminiData = null;
  let model = models[0];
  let lastStatus = 503;
  let lastError = 'Gemini 目前忙碌，請稍後再試';
  const attemptedModels = [];

  for (const candidateModel of models) {
    const remainingMs = totalBudgetMs - (Date.now() - startedAt);
    if (remainingMs < 2000) {
      lastStatus = 504;
      lastError = 'AI 解析已達 45 秒上限';
      break;
    }
    model = candidateModel;
    attemptedModels.push(candidateModel);
    let geminiResponse;
    const controller = new AbortController();
    const timeoutMs = Math.min(modelTimeoutMs, remainingMs);
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      geminiResponse = await fetch(endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          model,
          input,
          store: false,
          response_format: [{ type: 'text', mime_type: 'application/json' }],
        }),
      });
    } catch (error) {
      const timedOut = error?.name === 'AbortError';
      lastStatus = timedOut ? 504 : 502;
      lastError = timedOut
        ? `${candidateModel} 排隊超過 ${Math.round(timeoutMs / 1000)} 秒`
        : `無法連線 Gemini API：${error.message}`;
      continue;
    } finally {
      clearTimeout(timeoutId);
    }

    lastStatus = geminiResponse.status;
    const responseText = await geminiResponse.text();
    try {
      geminiData = JSON.parse(responseText);
    } catch {
      geminiData = null;
      lastError = geminiResponse.status === 524
        ? 'Gemini 回應逾時'
        : `Gemini 回應格式錯誤：${responseText.slice(0, 120)}`;
      if (retryableStatuses.has(geminiResponse.status)) continue;
      return jsonResponse({ error: lastError, retryable: false }, 502);
    }

    if (geminiResponse.ok) break;

    lastError = geminiData?.error?.message || `Gemini API 錯誤 ${geminiResponse.status}`;
    // 模型不存在時，若管理者有設定備援模型則繼續嘗試；沒有備援時直接回傳設定錯誤。
    if (geminiResponse.status === 404 && candidateModel !== models[models.length - 1]) {
      geminiData = null;
      continue;
    }
    if (!retryableStatuses.has(geminiResponse.status)) {
      return jsonResponse({ error: lastError, retryable: false }, geminiResponse.status);
    }
    geminiData = null;
  }

  if (!geminiData) {
    return jsonResponse({
      error: models.length > 1
        ? `${lastError}，已自動切換 ${attemptedModels.length} 個模型仍未成功，請稍候再試`
        : `${lastError}，請稍候再試`,
      retryable: true,
      attempted_models: attemptedModels,
    }, retryableStatuses.has(lastStatus) ? 503 : 502);
  }

  const outputText = (geminiData.steps || [])
    .filter((step) => step?.type === 'model_output')
    .flatMap((step) => step.content || [])
    .filter((part) => part?.type === 'text')
    .map((part) => part.text || '')
    .join('')
    .trim();

  if (!outputText) {
    const reason = geminiData.status || '沒有輸出內容';
    return jsonResponse({ error: `Gemini 無法完成解析：${reason}` }, 422);
  }

  // 維持既有前端讀取方式：d.content[0].text
  return jsonResponse({
    content: [{ type: 'text', text: outputText }],
    model,
    attempted_models: attemptedModels,
    usage: geminiData.usage || geminiData.usage_metadata || null,
  });
};
