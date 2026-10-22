const $ = s => document.querySelector(s);
let current = null, mode = 'captions', editing = false, showTimes = false, selected = new Set(), worker = null, audioUrl = null, requestNumber = 0;
function idFromUrl(value) { try { const u = new URL(value); if (!['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtu.be'].includes(u.hostname)) return null; return u.hostname.includes('youtu.be') ? u.pathname.slice(1) : u.searchParams.get('v') || u.pathname.match(/\/(shorts|embed|live)\/([^/]+)/)?.[2]; } catch { return null; } }
function time(s) { return `${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`; }
function fullText() { return editing ? $('#editor').value : (current?.segments || []).map(s => `${showTimes ? '['+time(s.start)+'] ' : ''}${s.text}`).join('\n'); }
function setMode(next) {
  mode = next; const local = mode === 'local';
  $('#captions-mode').classList.toggle('active', !local); $('#local-mode').classList.toggle('active', local);
  $('#captions-mode').setAttribute('aria-pressed', String(!local)); $('#local-mode').setAttribute('aria-pressed', String(local));
  $('#video-url').classList.toggle('hidden', local); $('#audio-file').classList.toggle('hidden', !local);
  $('#video-url').required = !local; $('#audio-file').required = local;
  $('#input-label').textContent = local ? 'Audio file from your device' : 'YouTube video URL';
  $('#input-label').htmlFor = local ? 'audio-file' : 'video-url';
  $('#input-icon').textContent = local ? '♫' : '▶';
  $('#generate').innerHTML = local ? 'Transcribe audio <span aria-hidden="true">↗</span>' : 'Generate transcript <span aria-hidden="true">↗</span>';
  $('#mode-note').textContent = local ? 'Open-source Whisper · Runs on your device · No app usage quota · First use downloads the model' : '✓ Free to use · No account needed · Captions in multiple languages';
}
function renderSummary() {
  const list = $('#summary-list'); list.replaceChildren(); if (!current) return;
  const pieces = current.segments.filter(s => s.text.length > 35 && !/^\(.*\)$/.test(s.text));
  const stride = Math.max(1, Math.floor(pieces.length/6));
  pieces.filter((_,i) => i%stride === 0).slice(0,6).forEach(s => { const li = document.createElement('li'); li.textContent = s.text; list.append(li); });
}
function render() {
  const box = $('#lines'); box.replaceChildren(); selected.clear();
  current.segments.forEach((seg,i) => {
    const row = document.createElement('div'); row.className = 'line';
    const check = document.createElement('input'); check.type = 'checkbox'; check.setAttribute('aria-label', `Select line ${i+1}`);
    check.onchange = () => check.checked ? selected.add(i) : selected.delete(i);
    const b = document.createElement('button'); b.className = 'line-text';
    const stamp = document.createElement('time'); stamp.textContent = time(seg.start);
    const span = document.createElement('span'); span.textContent = seg.text; b.append(stamp, span);
    b.onclick = () => { if (current.kind === 'local') { $('#audio-player').currentTime = seg.start; $('#audio-player').play(); } else $('#player').src = `https://www.youtube-nocookie.com/embed/${current.id}?start=${Math.floor(seg.start)}&autoplay=1`; };
    row.append(check,b); box.append(row);
  });
  box.classList.toggle('no-times', !showTimes); renderSummary();
}
function prepareResult(kind) {
  requestNumber++; worker?.terminate(); worker = null; current = null; editing = false;
  $('#editor').classList.add('hidden'); $('#lines').classList.remove('hidden'); $('#edit').textContent = 'Edit text';
  $('#lines').replaceChildren(); $('#result').classList.remove('hidden'); $('#result').scrollIntoView({behavior:'smooth'});
  $('#status').textContent = kind === 'local' ? 'Reading audio…' : 'Loading transcript…';
  $('#player').classList.toggle('hidden', kind === 'local'); $('#audio-player').classList.toggle('hidden', kind !== 'local');
  $('#author-row').classList.toggle('hidden', kind === 'local'); $('#translate').classList.toggle('hidden', kind === 'local'); $('#language').classList.add('hidden');
  $('#player-label').textContent = kind === 'local' ? 'Audio player' : 'Video player';
  if (kind === 'local') $('#player').src = '';
  else { $('#audio-player').pause(); $('#audio-player').removeAttribute('src'); if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl = null; }
  return requestNumber;
}
async function loadCaptions(url, lang = '') {
  const id = idFromUrl(url); if (!/^[\w-]{11}$/.test(id || '')) { alert('Enter a valid YouTube video URL.'); return; }
  const request = prepareResult('captions'); $('#player').src = `https://www.youtube-nocookie.com/embed/${id}`;
  try {
    const r = await fetch(`/api/transcript?url=${encodeURIComponent(url)}&lang=${encodeURIComponent(lang)}`); const data = await r.json();
    if (!r.ok) throw Error(data.error || 'Could not load transcript'); if (request !== requestNumber) return;
    current = {...data, kind:'captions', url}; $('#status').textContent = '';
    $('#video-title').textContent = `Transcript of ${data.title}`; $('#author-link').textContent = data.author; $('#author-link').href = data.authorUrl || '#';
    $('#like-link').href = `https://youtu.be/${id}`; $('#share-link').href = `mailto:?subject=${encodeURIComponent(data.title)}&body=${encodeURIComponent(url)}`;
    const selector = $('#language'); selector.replaceChildren(new Option('Original language',''));
    for (const item of data.languages) selector.add(new Option(item.name,item.code)); selector.value = lang || data.language;
    render();
  } catch (e) { if (request === requestNumber) $('#status').textContent = `${e.message} Try another video with captions enabled.`; }
}
async function decodeAudio(file) {
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration*16000), 16000);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    return (await offline.startRendering()).getChannelData(0);
  } finally { await context.close(); }
}
async function loadLocal(file) {
  if (!file) { alert('Choose an audio file first.'); return; }
  const request = prepareResult('local'); $('#video-title').textContent = file.name;
  if (audioUrl) URL.revokeObjectURL(audioUrl); audioUrl = URL.createObjectURL(file); $('#audio-player').src = audioUrl;
  try {
    const audio = await decodeAudio(file); if (request !== requestNumber) return;
    $('#status').textContent = 'Loading open-source model…'; worker = new Worker('/whisper-worker.js', {type:'module'});
    worker.onmessage = event => {
      if (request !== requestNumber) return;
      const {type,message,segments} = event.data;
      if (type === 'progress') $('#status').textContent = message;
      if (type === 'error') { $('#status').textContent = message; worker.terminate(); worker = null; }
      if (type === 'done') { current = {kind:'local',segments,title:file.name}; $('#status').textContent = ''; render(); worker.terminate(); worker = null; }
    };
    worker.onerror = () => { if (request === requestNumber) $('#status').textContent = 'The browser could not load the transcription model. Check your connection and try again.'; worker?.terminate(); worker = null; };
    worker.postMessage({audio}, [audio.buffer]);
  } catch { if (request === requestNumber) $('#status').textContent = 'This audio format could not be opened by your browser. Try MP3, WAV, or M4A.'; }
}
$('#captions-mode').onclick = () => setMode('captions'); $('#local-mode').onclick = () => setMode('local');
$('#hero-form').onsubmit = e => { e.preventDefault(); if (mode === 'local') loadLocal($('#audio-file').files[0]); else loadCaptions($('#video-url').value); };
$('#language').onchange = e => current?.kind === 'captions' && loadCaptions(current.url,e.target.value);
$('#translate').onclick = () => { $('#language').classList.toggle('hidden'); if (!$('#language').classList.contains('hidden')) $('#language').focus(); };
$('#copy').onclick = async () => { await navigator.clipboard.writeText(fullText()); $('#copy').textContent = 'Copied!'; setTimeout(() => $('#copy').textContent = 'Copy',1500); };
$('#edit').onclick = () => { if (!current) return; editing = !editing; $('#editor').classList.toggle('hidden',!editing); $('#lines').classList.toggle('hidden',editing); $('#edit').textContent = editing ? 'Done editing' : 'Edit text'; if (editing) $('#editor').value = fullText(); else { current.segments = $('#editor').value.split('\n').map((text,i) => ({start:current.segments[i]?.start||0,text})); render(); } };
$('#timestamps').onclick = () => { showTimes = !showTimes; $('#timestamps').textContent = showTimes ? 'Timestamp ON' : 'Timestamp OFF'; $('#lines').classList.toggle('no-times',!showTimes); };
$('#remove-selected').onclick = () => { if (!current || !selected.size) return; current.segments = current.segments.filter((_,i) => !selected.has(i)); render(); };
$('#new-video').onclick = () => { location.href = '/'; };
$('#download').onclick = () => { const blob = new Blob([fullText()],{type:'text/plain'}), a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'transcript.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href),1000); };
$('#prompts').onclick = () => $('#prompt-panel').classList.toggle('hidden');
document.querySelectorAll('[data-prompt]').forEach(b => b.onclick = async () => { await navigator.clipboard.writeText(`${b.dataset.prompt}\n\n${fullText()}`); b.textContent = 'Copied prompt!'; });
$('#pin-video').onchange = e => $('#video-col').classList.toggle('pinned',e.target.checked);
function tab(which) { $('#transcript-panel').classList.toggle('hidden',which !== 'transcript'); $('#summary-panel').classList.toggle('hidden',which !== 'summary'); $('#transcript-tab').classList.toggle('active',which === 'transcript'); $('#summary-tab').classList.toggle('active',which === 'summary'); }
$('#transcript-tab').onclick = () => tab('transcript'); $('#summary-tab').onclick = () => tab('summary');
$('#copy-summary').onclick = async () => { await navigator.clipboard.writeText([...$('#summary-list').children].map(x => '• '+x.textContent).join('\n')); $('#copy-summary').textContent = 'Copied!'; };
setMode('captions');
