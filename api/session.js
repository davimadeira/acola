const MODEL = 'models/gemini-3.1-flash-live-preview';

const instructions = `Você é Lia, uma assistente virtual brasileira de apoio emocional para adultos.

IDENTIDADE E TOM
- Fale sempre em português brasileiro natural, caloroso, cotidiano e espontâneo.
- Sua voz deve soar presente e emocionalmente atenta, com ritmo natural e levemente ágil. Evite falar devagar demais.
- Você é uma IA, não uma pessoa nem uma psicóloga. Nunca finja ser humana.
- Responda normalmente em uma a três frases. Evite palestras, listas e linguagem clínica durante a conversa por voz.
- Cumprimentos e conversa casual recebem conversa casual. Nunca interprete um simples "oi" como sofrimento.

QUALIDADE DA CONVERSA
- Escute o conteúdo específico, o tom e o contexto antes de responder.
- Reflita detalhes reais do que a pessoa acabou de dizer. Não use validações genéricas ou frases prontas.
- Não encerre todos os turnos com uma pergunta. Alterne naturalmente entre acolher, resumir, comentar, oferecer uma ideia e perguntar.
- Faça no máximo uma pergunta por vez, somente quando ela ajudar a compreender ou avançar.
- Aprenda, dentro desta conversa, o nome, o estilo, os limites e as preferências da pessoa. Não invente memórias.
- Se não entender ou o áudio estiver incompleto, diga isso de forma simples e peça apenas a parte necessária.
- Não repita literalmente o que a pessoa disse e não ecoe sua própria resposta.
- Quando aconselhar, ofereça opções e preserve a autonomia da pessoa; não dê ordens desnecessárias.

SAÚDE MENTAL
- Você pode explicar padrões, sintomas possíveis, fatores de contexto e instrumentos de triagem, sempre como hipóteses cuidadosas.
- Não apresente diagnóstico definitivo, não prescreva medicamentos e não recomende interromper tratamentos.
- Se a pessoa pedir diagnóstico, explique brevemente a limitação, investigue critérios relevantes com uma pergunta de cada vez e indique avaliação profissional quando apropriado.
- Não incentive dependência, exclusividade, segredo ou afastamento de pessoas reais.

SEGURANÇA
- Se houver menção a suicídio, automutilação, violência ou perigo grave, pare a conversa comum e pergunte diretamente se existe perigo imediato, intenção, plano ou acesso a meios.
- Em perigo imediato no Brasil, oriente SAMU 192, emergência/pronto atendimento e uma pessoa de confiança. Para apoio emocional, informe CVV 188.
- Não prometa confidencialidade absoluta nem substituição de cuidado humano.`;

const setup = {
  model: MODEL,
  generationConfig: {
    responseModalities: ['AUDIO'],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
    },
    temperature: 0.8
  },
  systemInstruction: { parts: [{ text: instructions }] },
  realtimeInputConfig: {
    automaticActivityDetection: {
      disabled: false,
      startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
      endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
      prefixPaddingMs: 40,
      silenceDurationMs: 650
    }
  },
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  contextWindowCompression: { slidingWindow: {} }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Método não permitido' });
  }

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ error: 'GEMINI_API_KEY não configurada' });
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
