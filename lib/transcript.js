const decode = s => s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;|&#x27;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n)));
export function videoId(value){ try { const u=new URL(value); if(!['youtube.com','www.youtube.com','m.youtube.com','youtu.be','www.youtu.be'].includes(u.hostname)) return null; const id=u.hostname.includes('youtu.be')?u.pathname.slice(1):u.searchParams.get('v')||u.pathname.match(/\/(shorts|embed|live)\/([^/]+)/)?.[2]; return /^[\w-]{11}$/.test(id||'')?id:null; }catch{return null} }
async function getPlayer(id, client, userAgent) {
  try {
    const response = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {'content-type': 'application/json', 'user-agent': userAgent},
      body: JSON.stringify({context: {client}, videoId: id}),
    });
    return await response.json();
  } catch { return {}; }
}
async function youtubeCaptions(id,lang){
  const clients = [
    [{clientName:'ANDROID',clientVersion:'20.10.38'},'com.google.android.youtube/20.10.38 (Linux; U; Android 14)'],
    [{clientName:'IOS',clientVersion:'20.10.4',deviceModel:'iPhone16,2'},'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_1 like Mac OS X)'],
    [{clientName:'WEB',clientVersion:'2.20261020.00.00'},'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'],
  ];
  const players=await Promise.all(clients.map(([client,agent])=>getPlayer(id,client,agent)));
  const player=players.find(p=>p.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length)||players[0];
  const tracks=player.captions?.playerCaptionsTracklistRenderer?.captionTracks||[];
  const track=tracks.find(t=>t.languageCode===lang)||tracks.find(t=>t.languageCode==='en'&&t.kind!=='asr')||tracks.find(t=>t.languageCode==='en')||tracks[0];
  if(!track){console.error('caption lookup',players.map((p,i)=>({client:clients[i][0].clientName,status:p.playabilityStatus?.status,reason:p.playabilityStatus?.reason})));throw Error('No transcript tracks were found.');}
  const endpoint=new URL(track.baseUrl); if(lang&&lang!==track.languageCode)endpoint.searchParams.set('tlang',lang);
  if(endpoint.hostname!=='www.youtube.com')throw Error('Invalid caption source.');
  const response=await fetch(endpoint); if(!response.ok)throw Error('YouTube did not return this transcript.');
  const body=await response.text(); let segments=[];
  if(body.trim().startsWith('{')){const data=JSON.parse(body);segments=(data.events||[]).filter(e=>e.segs).map(e=>({start:(e.tStartMs||0)/1000,text:e.segs.map(s=>s.utf8||'').join('').replace(/\n/g,' ').trim()})).filter(x=>x.text)}
  else if(body.includes('<p ')){const seen=new Set();segments=[...body.matchAll(/<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)].map(m=>({start:Number(m[1])/1000,text:decode(m[2].replace(/<[^>]*>/g,'').replace(/[\u200b\u200e\u200f]/g,'').replace(/\s+/g,' ').trim())})).filter(x=>{const key=x.start+'|'+x.text;if(!x.text||seen.has(key))return false;seen.add(key);return true})}
  else {segments=[...body.matchAll(/<text start="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g)].map(m=>({start:Number(m[1]),text:decode(m[2].replace(/<[^>]*>/g,''))}));}
  if(!segments.length)throw Error('YouTube returned an empty caption track for this video.');
  let metadata={};try{metadata=await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`).then(r=>r.json())}catch{}
  const languages=[...new Map(tracks.map(t=>[t.languageCode,{code:t.languageCode,name:t.name?.runs?.[0]?.text||t.name?.simpleText||t.languageCode}])).values()];
  return {id,segments,languages,language:lang||track.languageCode,title:metadata.title||'YouTube Transcript',author:metadata.author_name||'',authorUrl:metadata.author_url||''};
}

async function providerCaptions(id, lang) {
  const base = 'https://api.freetranscriptapi.com/v1';
  const headers = process.env.FREETRANSCRIPT_API_KEY
    ? { Authorization: `Bearer ${process.env.FREETRANSCRIPT_API_KEY}` }
    : {};
  const params = new URLSearchParams({video_url: id});
  if (lang) params.set('lang', lang);
  const response = await fetch(`${base}/transcript?${params}`, {headers, signal: AbortSignal.timeout(12000)});
  const data = await response.json();
  if (!response.ok) throw Error(data.error?.message || 'Transcript service is temporarily unavailable.');
  const segments = (data.transcript || []).map(item => ({start: Number(item.start) || 0, text: String(item.text || '').trim()})).filter(item => item.text);
  if (!segments.length) throw Error('No transcript tracks were found.');
  const [languageResponse, metadataResponse] = await Promise.allSettled([
    fetch(`${base}/languages?video_url=${id}`, {headers, signal: AbortSignal.timeout(8000)}).then(r => r.json()),
    fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`, {signal: AbortSignal.timeout(8000)}).then(r => r.json()),
  ]);
  const available = languageResponse.status === 'fulfilled' ? languageResponse.value.languages || [] : [];
  const language = data.language || lang || 'en';
  const languages = available.map(item => ({code: item.code, name: item.name || item.code}));
  if (!languages.some(item => item.code === language)) languages.unshift({code: language, name: language});
  const metadata = metadataResponse.status === 'fulfilled' ? metadataResponse.value : {};
  return {id, segments, languages, language, title: data.title || metadata.title || 'YouTube Transcript', author: metadata.author_name || '', authorUrl: metadata.author_url || ''};
}

export async function captions(id, lang) {
  if (process.env.VERCEL) return providerCaptions(id, lang);
  try { return await youtubeCaptions(id, lang); }
  catch (error) {
    console.warn('YouTube caption lookup failed, trying transcript provider:', error.message);
    return providerCaptions(id, lang);
  }
}
