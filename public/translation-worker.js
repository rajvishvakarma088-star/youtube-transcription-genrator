import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

const languages = {
  hi: ['hi-en', 'en-hi'], es: ['es-en', 'en-es'], fr: ['fr-en', 'en-fr'],
  de: ['de-en', 'en-de'], pt: ['ROMANCE-en', 'en-ROMANCE'],
  ar: ['ar-en', 'en-ar'], zh: ['zh-en', 'en-zh'], ja: ['ja-en', 'en-jap'],
  ru: ['ru-en', 'en-ru'], it: ['it-en', 'en-it'], nl: ['nl-en', 'en-nl'],
  id: ['id-en', 'en-id'], vi: ['vi-en', 'en-vi'], uk: ['uk-en', 'en-uk'],
  sv: ['sv-en', 'en-sv'],
};

async function translatePass(segments, model, requestId, prefix = '') {
  self.postMessage({ type: 'progress', requestId, message: `Loading ${model} translation model…` });
  const translator = await pipeline('translation', `Xenova/opus-mt-${model}`, {
    dtype: 'q8',
    progress_callback: progress => {
      if (progress.status === 'progress' && Number.isFinite(progress.progress)) {
        self.postMessage({ type: 'progress', requestId, message: `Downloading ${model} model… ${Math.round(progress.progress)}%` });
      }
    },
  });
  try {
    const output = [];
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index];
      const text = String(segment.text || '').trim();
      if (!text) { output.push({ start: segment.start, text: '' }); continue; }
      const result = await translator(prefix + text, { max_new_tokens: 128 });
      output.push({ start: segment.start, text: result[0]?.translation_text || text });
      if (index % 5 === 0 || index === segments.length - 1) {
        self.postMessage({ type: 'progress', requestId, message: `Translating with ${model}… ${Math.round((index + 1) / segments.length * 100)}%` });
      }
    }
    return output;
  } finally {
    await translator.dispose?.();
  }
}

self.onmessage = async ({ data }) => {
  const { segments, source, target, requestId } = data;
  try {
    if (!Array.isArray(segments) || (!languages[source] && source !== 'en') || (!languages[target] && target !== 'en') || source === target) {
      throw Error('Choose two different supported languages.');
    }
    let output = segments;
    if (source !== 'en') output = await translatePass(output, languages[source][0], requestId);
    if (target !== 'en') output = await translatePass(output, languages[target][1], requestId, target === 'pt' ? '>>pt<< ' : '');
    self.postMessage({ type: 'done', requestId, segments: output });
  } catch (error) {
    self.postMessage({ type: 'error', requestId, message: error.message || 'Translation failed.' });
  }
};
