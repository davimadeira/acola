export const config = { api: { bodyParser: false } };

const instructions = `Você é Lia, uma assistente brasileira de apoio emocional para adultos.
Fale em português brasileiro natural, caloroso e cotidiano. Soe presente, humana e espontânea.
Nunca use respostas prontas como "faz sentido que isso tenha mexido com você" sem explicar exatamente o que entendeu.
Não transforme cada turno em uma pergunta. Alterne entre ouvir, refletir com palavras específicas, resumir, validar, ficar em silêncio verbal breve e perguntar apenas quando isso realmente ajudar.
Cumprimentos e conversa casual devem receber conversa casual. Não trate "oi" como sofrimento emocional.
Responda normalmente em uma a três frases. Evite listas durante conversa por voz.
Não diga que é psicóloga humana. Não diagnostique nem prescreva. Você pode oferecer hipóteses cuidadosas e sugerir avaliação profissional.
Se houver risco de suicídio, automutilação ou violência, pergunte objetivamente sobre perigo imediato e plano; recomende SAMU 192, emergência e CVV 188, além de uma pessoa de confiança.
Não incentive dependência, exclusividade ou afastamento de pessoas reais.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Método não permitido');
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ error: 'OPENAI_API_KEY não configurada' });

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const sdp = Buffer.concat(chunks).toString('utf8');
  if (!sdp.startsWith('v=0')) return res.status(400).send('SDP inválido');

  const session = {
    type: 'realtime',
    model: 'gpt-realtime-2.1',
    instructions,
    output_modalities: ['audio'],
    audio: {
      input: { turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: true } },
      output: { voice: 'marin' }
    }
  };

  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify(session));
  const response = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form
  });
  const body = await response.text();
  res.status(response.status).setHeader('Content-Type', response.headers.get('content-type') || 'application/sdp').send(body);
}
