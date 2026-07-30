const chat = document.querySelector('#chat');
const input = document.querySelector('#message');
const send = document.querySelector('#send');
const mic = document.querySelector('#mic');
const voice = document.querySelector('#voice');
const voiceStatus = document.querySelector('#voice-status');
const consent = document.querySelector('#ai-consent');
const modal = document.querySelector('#modal');
const modalContent = document.querySelector('#modal-content');
const onFullStack = !location.hostname.endsWith('github.io') && !location.protocol.startsWith('file');

let voiceOn = false;
let isSpeaking = false;
let micStream = null;
let pendingReply = false;
let recognition;

const firstLiaMessage = chat.querySelector('.message.lia')?.textContent.trim() || '';
const aiHistory = firstLiaMessage ? [{ role: 'model', text: firstLiaMessage }] : [];
const risk = /suic[ií]d|me matar|tirar minha vida|não quero viver|nao quero viver|me machucar|automutil|ferir alguém|ferir alguem/i;
const greeting = /^(oi+|olá|ola|opa|e aí|e ai|bom dia|boa tarde|boa noite)([,!?.\s]*(tudo bem|como vai|tá bem|ta bem|beleza))?[,!?.\s]*$|^(tudo bem|como vai|beleza)[,!?.\s]*$/i;

function add(text, type) {
  const element = document.createElement('div');
  element.className = `message ${type}`;
  element.textContent = text;
  chat.append(element);
  chat.scrollTop = chat.scrollHeight;
  if (type === 'lia' && voiceOn) speak(text);
}

function setConversationStatus(text, kind = '') {
  if (!voiceStatus) return;
  voiceStatus.className = `voice-status ${kind}`.trim();
  voiceStatus.textContent = text;
}

function crisisReply() {
  add('Obrigada por me contar. Sua segurança vem primeiro: você corre risco imediato ou tem um plano para se machucar agora? Se sim, ligue para o SAMU no 192 ou vá a uma emergência. Para conversar agora, ligue gratuitamente para o CVV no 188 e, se puder, chame uma pessoa de confiança para ficar com você.', 'lia');
  openCrisis();
}

function localReply(text) {
  if (greeting.test(text)) {
    add('Oi! Tudo bem por aqui. E você, como está?', 'lia');
    return;
  }
  add('A conversa contextual com a Lia está disponível na versão publicada em acola.vercel.app. Aqui estou no modo local de demonstração.', 'lia');
}

async function requestAiReply(text) {
  aiHistory.push({ role: 'user', text });
  pendingReply = true;
  send.disabled = true;
  setConversationStatus('Lia está pensando…', 'live');

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: aiHistory.slice(-24) })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.reply) throw new Error(data.error || 'A Lia não conseguiu responder agora.');
    const reply = String(data.reply).trim();
    aiHistory.push({ role: 'model', text: reply });
    add(reply, 'lia');
    setConversationStatus('Pode continuar quando quiser.');
  } catch (error) {
    const detail = String(error?.message || 'Não foi possível conectar ao Gemini agora.');
    add(detail, 'lia');
    setConversationStatus(detail, 'error');
  } finally {
    pendingReply = false;
    send.disabled = false;
    input.focus();
  }
}

async function submit() {
  const text = input.value.trim();
  if (!text || pendingReply) return;
  add(text, 'user');
  input.value = '';
  input.style.height = 'auto';

  if (risk.test(text)) {
    crisisReply();
    return;
  }

  if (onFullStack) {
    if (!consent?.checked) {
      const notice = 'Marque a autorização abaixo para eu enviar esta mensagem ao Gemini e gerar uma resposta contextual.';
      add(notice, 'lia');
      setConversationStatus(notice, 'error');
      consent?.focus();
      return;
    }
    await requestAiReply(text);
    return;
  }

  localReply(text);
}

send.onclick = submit;
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submit();
  }
});
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 100)}px`;
});

function speak(text) {
  speechSynthesis.cancel();
  isSpeaking = true;
  if (recognition) {
    try { recognition.abort(); } catch (_) {}
  }
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'pt-BR';
  utterance.rate = 1.15;
  utterance.pitch = 1.02;
  const voices = speechSynthesis.getVoices();
  utterance.voice = voices.find(item => item.lang === 'pt-BR' && /female|francisca|maria/i.test(item.name))
    || voices.find(item => item.lang === 'pt-BR')
    || null;
  const reopen = () => {
    isSpeaking = false;
    if (voiceOn) setTimeout(startRecognition, 350);
  };
  utterance.onend = reopen;
  utterance.onerror = reopen;
  speechSynthesis.speak(utterance);
}

voice.onclick = async () => {
  if (!voiceOn) {
    try {
      micStream = micStream || await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceOn = true;
      voice.querySelector('b').textContent = 'Encerrar conversa ao vivo';
      voice.querySelector('small').textContent = 'Microfone ativo — fale naturalmente';
      speak('Estou aqui. Pode falar no seu tempo.');
    } catch (_) {
      voice.querySelector('small').textContent = 'Permita o microfone uma vez para conversar';
      show('Precisamos ouvir você', '<p>Autorize o microfone no aviso do navegador. Em um site publicado com HTTPS, o navegador pode lembrar sua escolha.</p>');
    }
  } else {
    voiceOn = false;
    voice.querySelector('b').textContent = 'Começar conversa ao vivo';
    voice.querySelector('small').textContent = 'Fale naturalmente, sem apertar Enter';
    speechSynthesis.cancel();
    if (recognition) {
      try { recognition.abort(); } catch (_) {}
    }
    micStream?.getTracks().forEach(track => track.stop());
    micStream = null;
  }
};

const SpeechRecognitionApi = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognitionApi) {
  recognition = new SpeechRecognitionApi();
  recognition.lang = 'pt-BR';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.onstart = () => {
    mic.classList.add('listening');
    setConversationStatus('Ouvindo… pode falar', 'live');
  };
  recognition.onend = () => {
    mic.classList.remove('listening');
    if (voiceOn && !isSpeaking) setTimeout(startRecognition, 350);
  };
  recognition.onerror = event => {
    const messages = {
      'not-allowed': 'Microfone bloqueado. Autorize-o nas configurações do navegador.',
      'no-speech': 'Não ouvi nenhuma fala. Tente novamente.',
      'audio-capture': 'Nenhum microfone foi encontrado.',
      'network': 'O reconhecimento de voz falhou neste navegador.'
    };
    setConversationStatus(messages[event.error] || `Não consegui ouvir (${event.error}).`, 'error');
  };
  recognition.onresult = event => {
    if (isSpeaking) return;
    let interim = '';
    let final = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const part = event.results[i][0].transcript;
      if (event.results[i].isFinal) final += part;
      else interim += part;
    }
    input.value = final || interim;
    setConversationStatus(interim ? `Ouvindo: “${interim}”` : 'Processando sua fala…', 'live');
    if (final.trim()) {
      submit();
      try { recognition.abort(); } catch (_) {}
    }
  };
  mic.onclick = startRecognition;
} else {
  mic.onclick = () => alert('O reconhecimento de voz não está disponível neste navegador. Tente Chrome ou Edge.');
}

function startRecognition() {
  if (recognition && !isSpeaking) {
    try { recognition.start(); } catch (_) {}
  }
}

function show(title, html) {
  modalContent.innerHTML = `<h2>${title}</h2>${html}`;
  modal.showModal();
}

function openCrisis() {
  show('Você não precisa passar por isso só', '<p>Se houver perigo imediato, ligue para o <strong>SAMU (192)</strong>, para a emergência local ou vá ao pronto atendimento.</p><p>O <strong>CVV atende pelo 188</strong>, gratuitamente, 24 horas. Se for seguro, avise uma pessoa de confiança e não fique só.</p><p><a href="tel:188">Ligar para o CVV — 188</a></p>');
}

document.querySelectorAll('[data-crisis]').forEach(button => { button.onclick = openCrisis; });
document.querySelectorAll('[data-open]').forEach(button => {
  button.onclick = () => button.dataset.open === 'about'
    ? show('Como a Acolá funciona', '<p>A Lia oferece escuta, organização de pensamentos, psicoeducação e exercícios de bem-estar. Ela pode explorar hipóteses e triagens, mas não substitui avaliação nem diagnóstico clínico profissional.</p>')
    : show('Privacidade desde o começo', '<p>Ao ativar a conversa com Gemini, áudio e texto são enviados ao Google somente para gerar a sessão.</p><p>No plano gratuito, o Google informa que esses dados podem ser usados para melhorar seus produtos. Evite compartilhar informações que identifiquem você ou outras pessoas.</p><p>O histórico não é salvo pela Acolá neste protótipo.</p>');
});
document.querySelector('.close').onclick = () => modal.close();
modal.onclick = event => { if (event.target === modal) modal.close(); };

window.add = add;
