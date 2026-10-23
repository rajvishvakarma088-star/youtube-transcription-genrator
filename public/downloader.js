(async () => {
  const $ = selector => document.querySelector(selector);
  const cloudButton = $('#cloud-download-mode');
  const localButton = $('#local-download-mode');
  const urlInput = $('#download-urls');
  const storedUrls = sessionStorage.getItem('media-download-urls');
  if (storedUrls !== null) {
    urlInput.value = storedUrls;
    sessionStorage.removeItem('media-download-urls');
  }

  const config = await fetch('/api/media-config', {cache: 'no-store'})
    .then(response => response.ok ? response.json() : {base: null})
    .catch(() => ({base: null}));
  const cloudAvailable = Boolean(config.base);
  const selected = localStorage.getItem('media-download-mode');
  const mode = selected === 'local' || !cloudAvailable ? 'local' : 'cloud';
  cloudButton.classList.toggle('active', mode === 'cloud');
  cloudButton.setAttribute('aria-pressed', String(mode === 'cloud'));
  cloudButton.disabled = !cloudAvailable;
  localButton.classList.toggle('active', mode === 'local');
  localButton.setAttribute('aria-pressed', String(mode === 'local'));
  $('#cloud-youtube-notice').classList.toggle('hidden', mode !== 'cloud');
  $('#downloader-setup').classList.toggle('hidden', mode !== 'local');

  function selectMode(next) {
    if (next === mode) return;
    sessionStorage.setItem('media-download-urls', urlInput.value);
    localStorage.setItem('media-download-mode', next);
    location.hash = 'downloader';
    location.reload();
  }
  cloudButton.onclick = () => selectMode('cloud');
  localButton.onclick = () => selectMode('local');

  if (mode === 'cloud') window.mediaCloudBase = config.base;
  const script = document.createElement('script');
  script.src = mode === 'cloud' ? '/downloader-cloud.js' : '/downloader-local.js';
  document.body.append(script);
})();
