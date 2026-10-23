const downloader = (() => {
  const base = 'http://127.0.0.1:8765';
  const $ = selector => document.querySelector(selector);
  const inspections = new Map();
  let jobsTimer = null;
  let saveFolder = '';

  async function api(path, method = 'GET', body) {
    const response = await fetch(base + path, {
      method,
      mode: 'cors',
      targetAddressSpace: 'loopback',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(path === '/health' ? 30000 : path === '/inspect' ? 120000 : 15000),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'The local downloader could not complete this request.');
    return data;
  }

  async function connection() {
    try {
      const data = await api('/health');
      saveFolder = data.saveFolder;
      $('#downloader-connection').textContent = `Ready · Files save to ${saveFolder}`;
      $('#downloader-connection').classList.add('connected');
      $('#downloader-setup').classList.add('hidden');
      $('#connect-downloader').classList.add('hidden');
      if (!data.audioConversion) $('#download-message').textContent = 'Install FFmpeg and FFprobe to enable MP3/M4A conversion and merged video formats.';
      return true;
    } catch {
      $('#downloader-connection').textContent = 'Local downloader is offline or browser access was denied';
      $('#downloader-connection').classList.remove('connected');
      $('#downloader-setup').classList.remove('hidden');
      $('#connect-downloader').classList.remove('hidden');
      return false;
    }
  }

  function size(bytes) {
    if (!bytes) return 'Size unavailable';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes, index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return `${value.toFixed(index ? 1 : 0)} ${units[index]}`;
  }
  function duration(seconds) {
    if (!Number.isFinite(seconds)) return 'Duration unavailable';
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function renderInspection(inspection) {
    inspections.set(inspection.inspectionId, inspection);
    const group = element('div', 'media-group');
    group.append(element('h3', '', `${inspection.site} · ${inspection.items.length} item${inspection.items.length === 1 ? '' : 's'}`));
    for (const item of inspection.items) {
      const card = element('article', 'media-item');
      card.dataset.inspectionId = inspection.inspectionId;
      card.dataset.index = String(item.index);
      const thumbnail = element('div', 'media-thumb');
      if (item.thumbnail) {
        const image = document.createElement('img');
        image.src = item.thumbnail; image.alt = ''; image.loading = 'lazy';
        thumbnail.append(image);
      } else thumbnail.textContent = item.kind === 'audio' ? '♫' : item.kind === 'image' ? '▧' : '▶';
      const details = element('div', 'media-details');
      details.append(element('strong', '', item.title));
      const metadata = element('p', 'media-metadata');
      const updateMetadata = () => {
        const choice = item.choices.find(value => value.id === select.value) || item.choices[0];
        metadata.textContent = `${choice.kind} · ${duration(item.duration)} · ${choice.size ? size(choice.size) : 'Size unavailable'}`;
      };
      details.append(metadata);
      const formatLabel = element('label', '', 'Quality / format');
      const select = document.createElement('select'); select.setAttribute('aria-label', `Quality for ${item.title}`);
      for (const choice of item.choices) {
        const option = new Option(`${choice.label}${choice.size ? ` · ${size(choice.size)}` : ''}`, choice.id);
        select.add(option);
      }
      select.onchange = updateMetadata; updateMetadata();
      formatLabel.append(select); details.append(formatLabel);
      const checkLabel = element('label', 'media-select');
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = true;
      checkLabel.append(checkbox, document.createTextNode(' Save this item'));
      card.append(thumbnail, details, checkLabel); group.append(card);
    }
    $('#media-previews').append(group);
  }

  async function inspect() {
    const urls = $('#download-urls').value.split(/\n+/).map(url => url.trim()).filter(Boolean);
    if (!urls.length) { $('#download-message').textContent = 'Paste at least one public media URL.'; return; }
    if (urls.length > 10) { $('#download-message').textContent = 'Inspect up to 10 URLs at a time.'; return; }
    if (!await connection()) return;
    $('#inspect-media').disabled = true;
    $('#media-previews').replaceChildren(); inspections.clear();
    $('#start-downloads').classList.add('hidden');
    const errors = [];
    for (let index = 0; index < urls.length; index++) {
      $('#download-message').textContent = `Checking ${index + 1} of ${urls.length} links…`;
      try { renderInspection(await api('/inspect', 'POST', { url: urls[index] })); }
      catch (error) { errors.push(`${urls[index]}: ${error.message}`); }
    }
    $('#inspect-media').disabled = false;
    $('#start-downloads').classList.toggle('hidden', inspections.size === 0);
    $('#download-message').textContent = errors.length ? errors.join('\n') : `Found ${[...inspections.values()].reduce((count, result) => count + result.items.length, 0)} media items. Choose the exact quality, then download.`;
  }

  async function startDownloads() {
    const groups = new Map();
    for (const card of $('#media-previews').querySelectorAll('.media-item')) {
      if (!card.querySelector('input[type="checkbox"]').checked) continue;
      const id = card.dataset.inspectionId;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push({ index: Number(card.dataset.index), choice: card.querySelector('select').value });
    }
    if (!groups.size) { $('#download-message').textContent = 'Select at least one item to save.'; return; }
    $('#start-downloads').disabled = true;
    const errors = [];
    for (const [inspectionId, selections] of groups) {
      try { await api('/jobs', 'POST', { inspectionId, selections }); }
      catch (error) { errors.push(error.message); }
    }
    $('#start-downloads').disabled = false;
    $('#download-message').textContent = errors.length ? errors.join(' · ') : `Downloading to ${saveFolder}. Keep the local companion running.`;
    await updateJobs();
    if (!jobsTimer) jobsTimer = setInterval(updateJobs, 1200);
  }

  function renderJobs(jobs) {
    const area = $('#download-jobs'); area.replaceChildren();
    if (!jobs.length) return;
    area.append(element('h3', '', 'Downloads'));
    for (const job of jobs) {
      const row = element('div', 'download-job');
      row.append(element('strong', '', job.title));
      const details = [job.state, job.progress != null ? `${job.progress}%` : '', job.totalBytes ? `${size(job.downloadedBytes)} / ${size(job.totalBytes)}` : '', job.eta ? `${Math.ceil(job.eta)}s left` : ''].filter(Boolean).join(' · ');
      row.append(element('p', '', details));
      if (job.error) row.append(element('p', 'job-error', job.error));
      const bar = document.createElement('progress'); bar.max = 100; bar.value = job.progress ?? 0; row.append(bar);
      const actions = element('div', 'job-actions');
      if (['queued','running','paused'].includes(job.state)) {
        const pause = element('button', 'outline', job.state === 'paused' ? 'Resume' : 'Pause');
        pause.onclick = () => changeJob(job.id, job.state === 'paused' ? 'resume' : 'pause');
        const cancel = element('button', 'outline', 'Cancel'); cancel.onclick = () => changeJob(job.id, 'cancel');
        actions.append(pause, cancel);
      }
      row.append(actions); area.append(row);
    }
  }
  async function updateJobs() {
    try {
      const { jobs } = await api('/jobs'); renderJobs(jobs);
      if (jobs.length && jobs.every(job => ['completed','error','cancelled'].includes(job.state))) { clearInterval(jobsTimer); jobsTimer = null; }
    } catch { clearInterval(jobsTimer); jobsTimer = null; $('#download-message').textContent = 'Connection to the local downloader was lost. Restart it to see progress.'; }
  }
  async function changeJob(id, action) {
    try { await api(`/jobs/${id}/${action}`, 'POST', {}); await updateJobs(); }
    catch (error) { $('#download-message').textContent = error.message; }
  }

  $('#inspect-media').onclick = inspect;
  $('#start-downloads').onclick = startDownloads;
  $('#connect-downloader').onclick = async () => { if (await connection()) updateJobs(); };
  (async () => {
    if (['localhost', '127.0.0.1'].includes(location.hostname)) {
      if (await connection()) updateJobs();
      return;
    }
    let permission = 'prompt';
    try { permission = (await navigator.permissions.query({ name: 'loopback-network' })).state; } catch {}
    if (permission === 'granted') {
      if (await connection()) updateJobs();
    } else {
      $('#downloader-connection').textContent = permission === 'denied' ? 'Allow local connection in your browser settings' : 'Connect your local downloader';
      $('#downloader-setup').classList.remove('hidden');
      $('#connect-downloader').classList.remove('hidden');
    }
  })();
  return { inspect, connection };
})();
