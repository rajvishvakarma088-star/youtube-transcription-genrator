(async () => {
  const $ = selector => document.querySelector(selector);
  const config = await fetch('/api/media-config').then(r => r.json()).catch(() => ({base: null}));
  if (!config.base) {
    const script = document.createElement('script');
    script.src = '/downloader-local.js';
    document.body.append(script);
    return;
  }
  const base = config.base.replace(/\/$/, '');
  const clientId = localStorage.getItem('media-client-id') || crypto.randomUUID();
  localStorage.setItem('media-client-id', clientId);
  const inspections = new Map();
  const transfers = new Map();
  const newJobs = new Set();
  let jobsTimer = null;
  let directory = null;

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
  async function api(path, method = 'GET', body, options = {}) {
    const response = await fetch(base + path, {
      method, mode: 'cors',
      headers: {'X-Client-ID': clientId, ...(body ? {'Content-Type': 'application/json'} : {})},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(options.timeout || (path === '/inspect' ? 120000 : 30000)),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.error || data.detail || `Cloud downloader returned ${response.status}.`);
    return data;
  }
  async function connection() {
    try {
      await api('/health');
      $('#downloader-connection').textContent = 'Cloud downloader ready · No installation needed';
      $('#downloader-connection').classList.add('connected');
      $('#downloader-setup').classList.add('hidden');
      $('#connect-downloader').classList.add('hidden');
      return true;
    } catch (error) {
      $('#downloader-connection').textContent = 'Cloud downloader unavailable';
      $('#downloader-connection').classList.remove('connected');
      $('#downloader-setup').textContent = error.message;
      $('#downloader-setup').classList.remove('hidden');
      $('#connect-downloader').classList.remove('hidden');
      $('#connect-downloader').textContent = 'Try connecting again';
      return false;
    }
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
      if (item.thumbnail && /^https:\/\//.test(item.thumbnail)) {
        const image = document.createElement('img'); image.src = item.thumbnail; image.alt = ''; image.loading = 'lazy'; thumbnail.append(image);
      } else thumbnail.textContent = item.kind === 'audio' ? '♫' : item.kind === 'image' ? '▧' : '▶';
      const details = element('div', 'media-details');
      details.append(element('strong', '', item.title));
      const metadata = element('p', 'media-metadata');
      const formatLabel = element('label', '', 'Quality / format');
      const select = document.createElement('select'); select.setAttribute('aria-label', `Quality for ${item.title}`);
      for (const choice of item.choices) select.add(new Option(`${choice.label}${choice.size ? ` · ${size(choice.size)}` : ''}`, choice.id));
      const updateMetadata = () => {
        const choice = item.choices.find(value => value.id === select.value) || item.choices[0];
        metadata.textContent = `${choice.kind} · ${duration(item.duration)} · ${choice.size ? size(choice.size) : 'Size unavailable'}`;
      };
      select.onchange = updateMetadata; updateMetadata();
      formatLabel.append(select); details.append(metadata, formatLabel);
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
      try { renderInspection(await api('/inspect', 'POST', {url: urls[index]})); }
      catch (error) { errors.push(`${urls[index]}: ${error.message}`); }
    }
    $('#inspect-media').disabled = false;
    $('#start-downloads').classList.toggle('hidden', inspections.size === 0);
    $('#download-message').textContent = errors.length ? errors.join('\n') : `Found ${[...inspections.values()].reduce((count, result) => count + result.items.length, 0)} media items. Choose the exact quality, then download.`;
  }
  async function startDownloads() {
    // Ask while the click is still active. This lets supported browsers write
    // large files directly to disk without holding them in memory.
    if (window.showDirectoryPicker) {
      try { directory = await window.showDirectoryPicker({mode: 'readwrite'}); }
      catch { directory = null; }
    }
    const groups = new Map();
    for (const card of $('#media-previews').querySelectorAll('.media-item')) {
      if (!card.querySelector('input[type="checkbox"]').checked) continue;
      const id = card.dataset.inspectionId;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push({index: Number(card.dataset.index), choice: card.querySelector('select').value});
    }
    if (!groups.size) { $('#download-message').textContent = 'Select at least one item to save.'; return; }
    $('#start-downloads').disabled = true;
    const errors = [];
    for (const [inspectionId, selections] of groups) {
      try {
        const result = await api('/jobs', 'POST', {inspectionId, selections});
        for (const job of result.jobs) newJobs.add(job.id);
      }
      catch (error) { errors.push(error.message); }
    }
    $('#start-downloads').disabled = false;
    $('#download-message').textContent = errors.length ? errors.join(' · ') : directory ? 'Preparing files for your selected folder.' : 'Preparing files. Your browser will save them when ready.';
    await updateJobs();
    if (!jobsTimer) jobsTimer = setInterval(updateJobs, 1500);
  }
  async function saveNative(job) {
    const link = document.createElement('a');
    link.href = `${base}/files/${job.id}?client=${encodeURIComponent(clientId)}`;
    link.download = job.filename || 'media';
    document.body.append(link); link.click(); link.remove();
    transfers.set(job.id, {state: 'browser download', offset: 0, native: true});
    renderJobs(lastJobs);
  }
  async function saveStream(job, resume = false) {
    let transfer = transfers.get(job.id);
    if (!resume) {
      const fileHandle = await directory.getFileHandle(job.filename || `${job.id}.bin`, {create: true});
      transfer = {state: 'saving', offset: 0, fileHandle, abort: new AbortController()};
      transfers.set(job.id, transfer);
    } else {
      transfer.state = 'saving'; transfer.abort = new AbortController();
    }
    renderJobs(lastJobs);
    let writable;
    try {
      writable = await transfer.fileHandle.createWritable({keepExistingData: resume});
      if (transfer.offset) await writable.seek(transfer.offset);
      const response = await fetch(`${base}/files/${job.id}`, {
        headers: {'X-Client-ID': clientId, ...(transfer.offset ? {Range: `bytes=${transfer.offset}-`} : {})},
        signal: transfer.abort.signal,
      });
      if (!response.ok || (transfer.offset && response.status !== 206) || !response.body) {
        const data = await response.json().catch(() => ({}));
        throw Error(data.error || data.detail || 'The source could not resume this download.');
      }
      const reader = response.body.getReader();
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        await writable.write(value);
        transfer.offset += value.byteLength;
        renderJobs(lastJobs);
      }
      await writable.close(); writable = null;
      transfer.state = 'saved'; renderJobs(lastJobs);
    } catch (error) {
      if (writable) await writable.close().catch(() => {});
      if (transfer.state === 'pausing') transfer.state = 'paused';
      else if (transfer.state === 'cancelling') {
        transfer.state = 'cancelled';
        await directory.removeEntry(job.filename).catch(() => {});
      } else { transfer.state = 'error'; transfer.error = error.message; }
      renderJobs(lastJobs);
    }
  }
  let lastJobs = [];
  function renderJobs(jobs) {
    lastJobs = jobs;
    const area = $('#download-jobs'); area.replaceChildren();
    if (!jobs.length) return;
    area.append(element('h3', '', 'Downloads'));
    for (const job of jobs) {
      const transfer = transfers.get(job.id);
      const row = element('div', 'download-job');
      row.append(element('strong', '', job.title));
      const pct = transfer && !transfer.native ? (job.size ? Math.min(100, Math.round(transfer.offset / job.size * 100)) : null) : job.progress;
      const details = [transfer?.state || job.state, pct != null && !transfer?.native ? `${pct}%` : '', transfer?.offset ? `${size(transfer.offset)} / ${size(job.size)}` : job.totalBytes ? `${size(job.downloadedBytes)} / ${size(job.totalBytes)}` : ''].filter(Boolean).join(' · ');
      row.append(element('p', '', details));
      if (job.error || transfer?.error) row.append(element('p', 'job-error', transfer?.error || job.error));
      const bar = document.createElement('progress'); bar.max = 100; bar.value = pct ?? 0; row.append(bar);
      const actions = element('div', 'job-actions');
      if (job.state === 'ready') {
        const save = element('button', 'outline', transfer?.state === 'paused' ? 'Resume' : 'Save file');
        save.onclick = () => directory ? saveStream(job, transfer?.state === 'paused') : saveNative(job);
        actions.append(save);
        if (transfer?.state === 'saving') {
          const pause = element('button', 'outline', 'Pause');
          pause.onclick = () => { transfer.state = 'pausing'; transfer.abort.abort(); };
          actions.append(pause);
        }
      }
      if (['queued', 'running', 'processing', 'ready'].includes(job.state) && !transfer?.native && transfer?.state !== 'saved') {
        const cancel = element('button', 'outline', 'Cancel');
        cancel.onclick = async () => {
          if (transfer?.abort) { transfer.state = 'cancelling'; transfer.abort.abort(); }
          await api(`/jobs/${job.id}/cancel`, 'POST', {});
          updateJobs();
        };
        actions.append(cancel);
      }
      row.append(actions); area.append(row);
    }
  }
  async function updateJobs() {
    try {
      const {jobs} = await api('/jobs');
      renderJobs(jobs);
      for (const job of jobs) {
        if (job.state === 'ready' && newJobs.has(job.id) && !transfers.has(job.id)) {
          newJobs.delete(job.id);
          if (directory) saveStream(job).catch(error => { $('#download-message').textContent = error.message; });
          else saveNative(job);
        }
      }
      if (jobs.length && jobs.every(job => ['ready', 'error', 'cancelled'].includes(job.state))) { clearInterval(jobsTimer); jobsTimer = null; }
    } catch (error) { clearInterval(jobsTimer); jobsTimer = null; $('#download-message').textContent = error.message; }
  }
  $('#inspect-media').onclick = inspect;
  $('#start-downloads').onclick = startDownloads;
  $('#connect-downloader').onclick = connection;
  if (await connection()) updateJobs();
})();
