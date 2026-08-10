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

  const parts = sourceContent.map((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') {
      return { text: part.text };
    }

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

  const model = (env.GEMINI_MODEL || 'gemini-3.6-flash').trim();
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  let geminiResponse;
  try {
    geminiResponse = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          temperature: 0.1,
          maxOutputTokens: 8192,
        },
      }),
    });
  } catch (error) {
    return jsonResponse({ error: `無法連線 Gemini API：${error.message}` }, 502);
  }

  const responseText = await geminiResponse.text();
  let geminiData;
  try {
    geminiData = JSON.parse(responseText);
  } catch {
    return jsonResponse({ error: `Gemini 回應格式錯誤：${responseText.slice(0, 160)}` }, 502);
  }

  if (!geminiResponse.ok) {
    return jsonResponse({
      error: geminiData?.error?.message || `Gemini API 錯誤 ${geminiResponse.status}`,
    }, geminiResponse.status);
  }

  const outputText = (geminiData.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || '')
    .join('')
    .trim();

  if (!outputText) {
    const reason = geminiData.candidates?.[0]?.finishReason || '沒有輸出內容';
    return jsonResponse({ error: `Gemini 無法完成解析：${reason}` }, 422);
  }

  // 維持既有前端讀取方式：d.content[0].text
  return jsonResponse({
    content: [{ type: 'text', text: outputText }],
    model,
    usage: geminiData.usageMetadata || null,
  });
};
