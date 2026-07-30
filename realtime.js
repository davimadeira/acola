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
  let terminalError = '';

  function ui(text, kind = '') {
    status.className = `voice-status ${kind}`.trim();
    status.textContent = text;
  }

  function setButton(running) {
    button.querySelector('b').textContent = running ? 'Encerrar conversa ao vivo' : 'Come√ßar conversa ao vivo';
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

  function handleServerMessage(event) {
    let data;
    try { data = JSON.parse(event.data); } catch (_) { return; }

    if (data.error) {
      clearTimeout(connectionTimer);
      console.error('Gemini Live recusou a sess√£o', data.error);
      const reason = data.error.message || data.error.status || 'configura√ß√£o recusada';
      terminalError = `O Gemini n√£o iniciou a voz: ${reason}`;
      ui(terminalError, 'error');
      try { socket?.close(); } catch (_) {}
      return;
    }

    if (data.setupComplete) {
      clearTimeout(connectionTimer);
      ready = true;
      active = true;
      setButton(true);
      ui('Lia est√° pronta. Pode falar.', 'live');
      return;
    }

    const content = data.serverContent;
    if (!content) return;

    if (content.interrupted) {
      clearPlayback();
      if (assistantDraft) scheduleTranscriptFlush(250);
      ui('Estou ouvindo voc√™‚Ä¶', 'live');
    }

    if (content.inputTranscription?.text) {
      userDraft = appendDraft(userDraft, content.inputTranscription.text);
      ui('Entendi. Preparando a resposta‚Ä¶', 'live');
      scheduleTranscriptFlush(1200);
    }

    if (content.outputTranscription?.text) {
      assistantDraft = appendDraft(assistantDraft, content.outputTranscription.text);
      ui('Lia est√° falando‚Ä¶', 'live');
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

  async function start() {
    if (!consent?.checked) {
      ui('Marque o consentimento de privacidade antes de come√ßar.', 'error');
      consent?.focus();
      return;
    }

    stopping = false;
    terminalError = '';
    ui('Criando umuÎÆ-¢Gß≤⁄Óù∆≠y◊FW"rbbWfVÁBÁ6ÜñgD∂Wíí∞¢WfVÁBÁ&WfVÁDFVfV«BÇì∞¢WfVÁBÁ7F˜ñ÷÷VFñFU&˜vFñˆ‚Çì∞¢6VÊEFWáBÇì∞¢–¢“¬G'VRì∞†¢vñÊF˜rÊFDWfVÁD∆ó7FVÊW"Çv&Vf˜&WVÊ∆ˆBr¬Çí”‚∞¢÷VFñ7G&V”ÚÊvWEG&6∑2ÇíÊf˜$V6ÇáG&6≤”‚G&6≤Á7F˜Çíì∞¢G'í≤6ˆ6∂WCÚÊ6∆˜6RÇì≤“6F6ÇÖÚí∑–¢“ì∞ß“íÇì∞