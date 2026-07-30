import { LIA_INSTRUCTIONS } from './_lia-prompt.js';

const MODEL = 'gemini-3.5-flash';
const MAX_MESSAGES = 24;
const MAX_MESSAGE_LENGTH = 4000;

function cleanMessages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-MAX_MESSAGES)
    .map(item => ({
      role: item?.role === 'model' ? 'model' : 'user',
      text: String(item?.text || '').trim().slice(0, MAX_MESSAGE_LENGTH)
    }))
    .filter(item => item.text);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'A chave do Gemini ainda não foi ativada no servidor.' });
  }

  const messages = cleanMessages(req.body?.messages);
  if (!messages.length || messages.at(-1)?.role !== 'user') {
    return res.status(400).json({ error: 'Envie uma mensagem válida.' });
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: LIA_INSTRUCTIONS }] },
        contents: messages.map(item => ({
          role: item.role,
          parts: [{ text: item.text }]
        })),
        generationConfig: { maxOutputTokens: 2048 }
      })
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('Falha na conversa com Gemini', response.status, data?.error?.status || 'sem_status');
      const error = response.status === 429
        ? 'O limite gratuito do Gemini foi atingido. Aguarde um pouco e tente novamente.'
        : 'A Lia não conseguiu responder agora. Tente novamente em instantes.';
      return res.status(response.status || 502).json({ error });
    }

    const reply = (data.candidates?.[0]?.content?.parts || [])
      .map(part => part.text || '')
      .join('')
      .trim();

    if (!reply) {
      return res.status(502).json({ error: 'A Lia recebeu a mensagem, mas não conseguiu formar uma resposta. Tente novamente.' });
    }

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ reply });
  } catch (error) {
    console.error('Erro de rede na conversa com Gemini', error?.message || error);
    return res.status(502).json({ error: 'Não foi possível conectar ao Gemini agora.' });
  }
}
