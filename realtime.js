(()=>{
  const button=document.querySelector('#voice'),status=document.querySelector('#voice-status'),message=document.querySelector('#message'),sendButton=document.querySelector('#send');
  if(!button||!status)return;
  const localVoiceFallback=button.onclick,localSendFallback=sendButton.onclick;
  let pc=null,dc=null,stream=null,active=false,assistantDraft='';
  const onFullStack=!location.hostname.endsWith('github.io')&&!location.protocol.startsWith('file');

  function ui(text,kind='live'){status.className=`voice-status ${kind}`;status.textContent=text}
  function stop(){active=false;try{dc?.close()}catch(e){}try{pc?.close()}catch(e){}stream?.getTracks().forEach(t=>t.stop());pc=dc=stream=null;button.querySelector('b').textContent='Começar conversa ao vivo';button.querySelector('small').textContent='Fale naturalmente, sem apertar Enter';ui('Microfone desligado','')}
  function showTranscript(text,type){if(!text?.trim())return;add(text.trim(),type)}
  function handleEvent(event){
    let data;try{data=JSON.parse(event.data)}catch(e){return}
    if(data.type==='session.created'){ui('Lia está pronta. Pode falar.')}
    if(data.type==='input_audio_buffer.speech_started')ui('Estou ouvindo você…');
    if(data.type==='input_audio_buffer.speech_stopped')ui('Pensando no que você disse…');
    if(data.type==='conversation.item.input_audio_transcription.completed')showTranscript(data.transcript,'user');
    if(data.type==='response.output_audio_transcript.delta'||data.type==='response.audio_transcript.delta')assistantDraft+=data.delta||'';
    if(data.type==='response.output_audio_transcript.done'||data.type==='response.audio_transcript.done'){showTranscript(data.transcript||assistantDraft,'lia');assistantDraft='';ui('Pode continuar quando quiser.')}
    if(data.type==='response.output_text.done'){showTranscript(data.text,'lia');ui('Pode continuar quando quiser.')}
    if(data.type==='error')ui('A conversa encontrou um erro. Tente novamente.','error');
  }
  async function start(){
    ui('Conectando à Lia…');
    stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
    pc=new RTCPeerConnection();
    const audio=document.createElement('audio');audio.autoplay=true;pc.ontrack=e=>{audio.srcObject=e.streams[0]};
    stream.getTracks().forEach(track=>pc.addTrack(track,stream));
    dc=pc.createDataChannel('oai-events');dc.onmessage=handleEvent;dc.onopen=()=>ui('Lia está pronta. Pode falar.');dc.onclose=()=>active&&ui('Conexão encerrada. Tente novamente.','error');
    const offer=await pc.createOffer();await pc.setLocalDescription(offer);
    const response=await fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/sdp'},body:offer.sdp});
    if(!response.ok)throw new Error(await response.text());
    await pc.setRemoteDescription({type:'answer',sdp:await response.text()});
    active=true;button.querySelector('b').textContent='Encerrar conversa ao vivo';button.querySelector('small').textContent='Você pode interromper a Lia naturalmente';
  }
  function sendText(){const text=message.value.trim();if(!active||!text)return false;showTranscript(text,'user');message.value='';dc.send(JSON.stringify({type:'conversation.item.create',item:{type:'message',role:'user',content:[{type:'input_text',text}]}}));dc.send(JSON.stringify({type:'response.create'}));ui('Lia está pensando…');return true}

  button.onclick=async e=>{if(!onFullStack)return localVoiceFallback?.call(button,e);if(active){stop();return}try{await start()}catch(error){stop();ui(error.message.includes('OPENAI_API_KEY')?'A inteligência ainda não foi ativada no servidor.':'Não consegui iniciar a conversa. Verifique microfone e conexão.','error')}};
  sendButton.onclick=e=>{if(!sendText())localSendFallback?.call(sendButton,e)};
  document.addEventListener('keydown',e=>{if(active&&e.target===message&&e.key==='Enter'&&!e.shiftKey){e.preventDefault();e.stopImmediatePropagation();sendText()}},true);
})();
