(() => {
  const onFullStack = !location.hostname.endsWith('github.io') && !location.protocol.startsWith('file');
  if (!onFullStack) {
    document.querySelector('.ai-consent')?.remove();
    return;
  }

  const originalButton = document.querySelector('#voice');
  const status = document.querySelector('#voice-status');
  const message = document.querySelector('#message');
  const sendButton = document.querySelector('#send');
  const consent = document.querySelector('#ai-consent');
  if (!originalButton || !status || !message || !sendButton) return;
  const localSendFallback = sendButton.onclick;

  // Remove os listeners do modo local para evitar duas conversas executando juntas.
  const button = originalButton.cloneNode(true);
  originalButton.replaceWith(button);

  const WS_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';
  const TARGET_INPUT_RATE = 16000;
  const DEFAULT_OUTPUT_RATE = 24000;
  const MAX_RECONNECT_ATTEMPTS = 5;

  let socket = null;
  let mediaStream = null;
  let inputContext = null;
  let outputContext = null;
  let inputSource = null;
  let processor = null;
  let silentGain = null;
  let active = false;
  let ready = false;
  let stopping = false;
  let nextPlaybackTime = 0;
  let playbackSources = new Set();
  let userDraft = '';
  let assistantDraft = '';
  let transcriptTimer = null;
  let connectionTimer = null;
  let reconnectTimer = null;
  let terminalError = '';
  let sessionData = null;
  let sessionHandle = '';
  let reconnectAttempts = 0;
  let reconnecting = false;

  function ui(text, kind = '') {
    status.className = `voice-status ${kind}`.trim();
    status.textContent = text;
  }

  function setButton(running) {
    button.querySelector('b').textContent = running ? 'Encerrar conversa ao vivo' : 'Começar conversa ao vivo';
    button.querySelector('small').textContent = running
      ? 'Pode falar e interromper a Lia naturalmente'
      : 'Fale naturalmente, sem apertar Enter';
  }

  function appendDraft(current, piece) {
    const clean = String(piece || '').replace(/\s+/g, ' ').trim();
    if (!clean) return current;
    if (!current) return clean;
    if (clean.startsWith(current)) return clean;
    if (current.endsWith(clean)) return current;
    return `${current}${/^[,.;!?]/.test(clean) ? '' : ' '}${clean}`;
  }

  function flushTranscripts() {
    clearTimeout(transcriptTimer);
    transcriptTimer = null;
    if (userDraft.trim()) add(userDraft.trim(), 'user');
    if (assistantDraft.trim()) add(assistantDraft.trim(), 'lia');
    userDraft = '';
    assistantDraft = '';
  }

  function scheduleTranscriptFlush(delay = 850) {
    clearTimeout(transcriptTimer);
    transcriptTimer = setTimeout(flushTranscripts, delay);
  }

  function clearPlayback() {
    for (const source of playbackSources) {
      try { source.stop(); } catch (_) {}
    }
    playbackSources.clear();
    nextPlaybackTime = outputContext?.currentTime || 0;
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const size = 0x8000;
    for (let i = 0; i < bytes.length; i += size) {
      binary += String.fromCharCode(...bytes.subarray(i, i + size));
    }
    return btoa(binary);
  }

  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function downsampleToPcm16(samples, sourceRate, targetRate) {
    const ratio = sourceRate / targetRate;
    const length = sourceRate === targetRate ? samples.length : Math.max(1, Math.round(samples.length / ratio));
    const bytes = new Uint8Array(length * 2);
    const view = new DataView(bytes.buffer);
    for (let outputIndex = 0; outputIndex < length; outputIndex++) {
      const start = sourceRate === targetRate ? outputIndex : Math.floor(outputIndex * ratio);
      const end = sourceRate === targetRate ? start + 1 : Math.min(samples.length, Math.floor((outputIndex + 1) * ratio));
      let total = 0;
      let count = 0;
      for (let inputIndex = start; inputIndex < end; inputIndex++) {
        total += samples[inputIndex];
        count++;
      }
      const sample = Math.max(-1, Math.min(1, count ? total / count : samples[start] || 0));
      view.setInt16(outputIndex * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return bytes;
  }

  function queueAudio(base64, mimeType = '') {
    if (!base64 || !outputContext) return;
    const bytes = base64ToBytes(base64);
    const sampleCount = Math.floor(bytes.byteLength / 2);
    if (!sampleCount) return;

    const rateMatch = /rate=(\d+)/i.exec(mimeType);
    const sampleRate = rateMatch ? Number(rateMatch[1]) : DEFAULT_OUTPUT_RATE;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buffer = outputContext.createBuffer(1, sampleCount, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < sampleCount; i++) channel[i] = view.getInt16(i * 2, true) / 32768;

    const source = outputContext.createBufferSource();
    source.buffer = buffer;
    source.connect(outputContext.destination);
    playbackSources.add(source);
    source.onended = () => playbackSources.delete(source);
    const startsAt = Math.max(outputContext.currentTime + 0.025, nextPlaybackTime);
    source.start(startsAt);
    nextPlaybackTime = startsAt + buffer.duration;
  }

  async function handleServerMessage(event) {
    let payload = event.data;
    let data;

    try {
      if (payload instanceof Blob) {
        payload = await payload.text();
      } else if (payload instanceof ArrayBuffer) {
        payload = new TextDecoder().decode(payload);
      } else if (ArrayBuffer.isView(payload)) {
        payload = new TextDecoder().decode(payload);
      }
      data = JSON.parse(payload);
    } catch (error) {
      console.error('Não foi possível interpretar a resposta do Gemini Live', error);
      return;
    }

    if (data.error) {
      clearTimeout(connectionTimer);
      console.error('Gemini Live recusou a sessão', data.error);
      const reason = data.error.message || data.error.status || 'configuração recusada';
      terminalError = `O Gemini não iniciou a voz: ${reason}`;
      ui(terminalError, 'error');
      try { socket?.close(); } catch (_) {}
      return;
    }

    if (data.setupComplete) {
      clearTimeout(connectionTimer);
      const resumed = reconnecting;
      reconnecting = false;
      reconnectAttempts = 0;
      ready = true;
      active = true;
      setButton(true);
      ui(resumed ? 'Conversa retomada. Pode continuar.' : 'Lia está pronta. Pode falar.', 'live');
      return;
    }

    const resumption = data.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) {
      sessionHandle = resumption.newHandle;
    }

    if (data.goAway) {
      ui('Mantendo sua conversa conectada…', 'live');
    }

    const content = data.serverContent;
    if (!content) return;

    if (content.interrupted) {
      clearPlayback();
      if (assistantDraft) scheduleTranscriptFlush(250);
      ui('Estou ouvindo você…', 'live');
    }

    if (content.inputTranscription?.text) {
      userDraft = appendDraft(userDraft, content.inputTranscription.text);
      ui('Entendi. Preparando a resposta…', 'live');
      scheduleTranscriptFlush(1200);
    }

    if (content.outputTranscription?.text) {
      assistantDraft = appendDraft(assistantDraft, content.outputTranscription.text);
      ui('Lia está falando…', 'live');
      scheduleTranscriptFlush(1200);
    }

    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.data) queueAudio(part.inlineData.data, part.inlineData.mimeType);
    }

    if (content.turnComplete) {
      scheduleTranscriptFlush(900);
      ui('Pode continuar quando quiser.', 'live');
    }
  }

  async function beginAudioCapture() {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1
      }
    });

    inputContext = new AudioContext();
    await inputContext.resume();
    inputSource = inputContext.createMediaStreamSource(mediaStream);
    processor = inputContext.createScriptProcessor(4096, 1, 1);
    silentGain = inputContext.createGain();
    silentGain.gain.value = 0;
    inputSource.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(inputContext.destination);

    processor.onaudioprocess = event => {
      if (!ready || socket?.readyState !== WebSocket.OPEN) return;
      const pcm = downsampleToPcm16(event.inputBuffer.getChannelData(0), inputContext.sampleRate, TARGET_INPUT_RATE);
      socket.send(JSON.stringify({
        realtimeInput: {
          audio: { data: bytesToBase64(pcm), mimeType: `audio/pcm;rate=${TARGET_INPUT_RATE}` }
        }
      }));
    };
  }

  function canReconnect() {
    const expiresAt = Date.parse(sessionData?.expiresAt || '');
    return Boolean(
      sessionData?.token &&
      sessionHandle &&
      Number.isFinite(expiresAt) &&
      expiresAt - Date.now() > 10000 &&
      reconnectAttempts < MAX_RECONNECT_ATTEMPTS
    );
  }

  function connectSocket(resume = false) {
    if (!sessionData?.token) throw new Error('A sessão de voz não está disponível.');

    clearTimeout(connectionTimer);
    clearTimeout(reconnectTimer);
    ready = false;
    reconnecting = resume;

    const currentSocket = new WebSocket(`${WS_ENDPOINT}?access_token=${encodeURIComponent(sessionData.token)}`);
    socket = currentSocket;
    currentSocket.onmessage = handleServerMessage;
    currentSocket.onerror = error => {
      console.error('Oscilação na conexão com o Gemini Live', error);
      if (!stopping) ui('A conexão oscilou. Tentando manter a conversa…', 'live');
    };
    currentSocket.onclose = async event => {
      clearTimeout(connectionTimer);
      if (socket !== currentSocket || stopping) return;

      socket = null;
      ready = false;

      if (canReconnect()) {
        reconnectAttempts += 1;
        reconnecting = true;
        active = true;
        setButton(true);
        ui('Reconectando sem perder a conversa…', 'live');
        reconnectTimer = setTimeout(() => {
          if (stopping) return;
          try { connectSocket(true); } catch (error) {
            terminalError = String(error?.message || error);
          }
        }, Math.min(4000, reconnectAttempts * 700));
        return;
      }

      active = false;
      reconnecting = false;
      setButton(false);
      const closeDetail = event.reason ? `; motivo: ${event.reason}` : '';
      const closeInfo = `código ${event.code}${closeDetail}`;
      const diagnosis = terminalError
        ? `${terminalError} (${closeInfo}).`
        : `A conexão de voz foi encerrada pelo Gemini (${closeInfo}).`;
      console.error('Gemini Live encerrou a conexão', { code: event.code, reason: event.reason || 'sem motivo informado' });
      ui(`${diagnosis} Você pode tentar novamente.`, 'error');
      if (processor) processor.onaudioprocess = null;
      try { processor?.disconnect(); } catch (_) {}
      try { inputSource?.disconnect(); } catch (_) {}
      try { silentGain?.disconnect(); } catch (_) {}
      mediaStream?.getTracks().forEach(track => track.stop());
      await inputContext?.close().catch(() => {});
      await outputContext?.close().catch(() => {});
      sessionData = null;
      sessionHandle = '';
      mediaStream = null;
      inputContext = null;
      outputContext = null;
      inputSource = null;
      processor = null;
      silentGain = null;
    };
    currentSocket.onopen = () => {
      if (stopping || socket !== currentSocket || !sessionData) {
        try { currentSocket.close(); } catch (_) {}
        return;
      }
      const setup = JSON.parse(JSON.stringify(sessionData.setup || { model: sessionData.model }));
      setup.contextWindowCompression ||= { slidingWindow: {} };
      setup.sessionResumption = sessionHandle ? { handle: sessionHandle } : {};
      currentSocket.send(JSON.stringify({ setup }));
      ui(resume ? 'Retomando a conversa com a Lia…' : 'Preparando a voz da Lia…', 'live');
      connectionTimer = setTimeout(() => {
        if (!ready && socket === currentSocket) {
          terminalError = resume
            ? 'O Gemini demorou para retomar a conversa.'
            : 'O Gemini demorou para aceitar a configuração da voz.';
          ui(`${terminalError} Tentando novamente…`, 'error');
          try { currentSocket.close(); } catch (_) {}
        }
      }, 20000);
    };
  }

  async function start() {
    if (!consent?.checked) {
      ui('Marque o consentimento de privacidade antes de começar.', 'error');
      consent?.focus();
      return;
    }

    stopping = false;
    terminalError = '';
    ui('Criando uma sessão segura…', 'live');
    outputContext = new AudioContext({ sampleRate: DEFAULT_OUTPUT_RATE });
    await outputContext.resume();

    const response = await fetch('/api/session', { method: 'POST' });
    sessionData = await response.json().catch(() => ({}));
    if (!response.ok || !sessionData.token) throw new Error(sessionData.error || 'Não foi possível criar a sessão.');

    sessionHandle = '';
    reconnectAttempts = 0;
    await beginAudioCapture();
    ui('Conectando à Lia…', 'live');
    connectSocket(false);
  }

  async function stop() {
    stopping = true;
    active = false;
    ready = false;
    clearTimeout(transcriptTimer);
    clearTimeout(connectionTimer);
    clearTimeout(reconnectTimer);
    flushTranscripts();
    clearPlayback();

    if (socket?.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); } catch (_) {}
      try { socket.close(1000, 'Sessão encerrada pela pessoa'); } catch (_) {}
    }

    if (processor) processor.onaudioprocess = null;
    try { processor?.disconnect(); } catch (_) {}
    try { inputSource?.disconnect(); } catch (_) {}
    try { silentGain?.disconnect(); } catch (_) {}
    mediaStream?.getTracks().forEach(track => track.stop());
    await inputContext?.close().catch(() => {});
    await outputContext?.close().catch(() => {});

    socket = null;
    sessionData = null;
    sessionHandle = '';
    reconnectAttempts = 0;
    reconnecting = false;
    mediaStream = null;
    inputContext = null;
    outputContext = null;
    inputSource = null;
    processor = null;
    silentGain = null;
    playbackSources = new Set();
    nextPlaybackTime = 0;
    setButton(false);
    ui('Microfone desligado');
  }

  function sendText() {
    const text = message.value.trim();
    if (!active || !ready || !text || socket?.readyState !== WebSocket.OPEN) return false;
    add(text, 'user');
    message.value = '';
    socket.send(JSON.stringify({ realtimeInput: { text } }));
    ui('Lia está pensando…', 'live');
    return true;
  }

  button.onclick = async () => {
    if (active || socket) {
      await stop();
      return;
    }
    try {
      await start();
    } catch (error) {
      await stop();
      const detail = String(error?.message || '');
      if (detail.includes('GEMINI_API_KEY')) ui('A chave do Gemini ainda não foi ativada no servidor.', 'error');
      else if (detail.includes('limite gratuito')) ui(detail, 'error');
      else if (/NotAllowedError|Permission denied/i.test(detail)) ui('Autorize o microfone nas configurações do navegador.', 'error');
      else ui(detail || 'Não consegui iniciar. Verifique a conexão e o microfone.', 'error');
    }
  };

  sendButton.onclick = event => {
    if (sendText()) event.preventDefault();
    else if (socket) ui('Espere a Lia terminar de conectar antes de enviar.', 'error');
    else localSendFallback?.call(sendButton, event);
  };

  document.addEventListener('keydown', event => {
    if (active && event.target === message && event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      sendText();
    }
  }, true);

  window.addEventListener('beforeunload', () => {
    mediaStream?.getTracks().forEach(track => track.stop());
    try { socket?.close(); } catch (_) {}
  });
})();
