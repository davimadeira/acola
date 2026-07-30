import { LIA_INSTRUCTIONS } from './_lia-prompt.js';

const MODEL = 'models/gemini-3.1-flash-live-preview';

const setup = {
  model: MODEL,
  generationConfig: {
    responseModalities: ['AUDIO'],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
    }
  },
  systemInstruction: { parts: [{ text: LIA_INSTRUCTIONS }] },
  inputAudioTranscription: {},
  outputAudioTranscription: {}
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido.' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY não configurada.' });
  }

  const now = Date.now();
  const tokenRequest = {
    uses: 1,
    newSessionExpireTime: new Date(now + 60 * 1000).toISOString(),
    expireTime: new Date(now + 30 * 60 * 1000).toISOString()
  };

  try {
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/auth_tokens', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': process.env.GEMINI_API_KEY
      },
      body: JSON.stringify(tokenRequest)
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.name) {
      console.error('Falha ao criar token temporário do Gemini', response.status, data?.error?.status || 'sem_status');
      const message = response.status === 429
        ? 'O limite gratuito do Gemini foi atingido. Tente novamente mais tarde.'
        : 'Não foi possível iniciar uma sessão segura com o Gemini.';
      return res.status(response.status || 502).json({ error: message });
    }

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({
      token: data.name,
      model: MODEL,
      setup,
      expiresAt: tokenRequest.expireTime
    });
  } catch (error) {
    console.error('Erro de rede ao criar sessão do Gemini', error?.message || error);
    return res.status(502).json({ error: 'Não foi possível conectar ao Gemini agora.' });
  }
}
