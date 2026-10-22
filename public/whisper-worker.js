import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

self.onmessage = async ({data}) => {
  try {
    const {audio} = data;
    const transcriber = await pipeline('automatic-speech-recognition','Xenova/whisper-tiny',{
      progress_callback: progress => { if (progress.status === 'progress' && Number.isFinite(progress.progress)) self.postMessage({type:'progress',message:`Downloading model… ${Math.round(progress.progress)}%`}); },
    });
    const chunkSize = 30*16000, segments = [];
    for (let offset = 0; offset < audio.length; offset += chunkSize) {
      self.postMessage({type:'progress',message:`Transcribing audio… ${Math.min(100,Math.round(offset/audio.length*100))}%`});
      const result = await transcriber(audio.subarray(offset,Math.min(offset+chunkSize,audio.length)),{return_timestamps:true,task:'transcribe'});
      const chunks = result.chunks?.length ? result.chunks : [{timestamp:[0,0],text:result.text}];
      for (const chunk of chunks) { const text = String(chunk.text||'').trim(); if (text) segments.push({start:offset/16000+(chunk.timestamp?.[0]||0),text}); }
    }
    if (!segments.length) throw Error('No speech was detected in this audio.');
    self.postMessage({type:'done',segments});
  } catch (error) { self.postMessage({type:'error',message:error.message||'The audio could not be transcribed.'}); }
};
