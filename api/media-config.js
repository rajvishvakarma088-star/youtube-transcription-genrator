export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const url = process.env.CLOUD_DOWNLOADER_URL || 'https://youtube-transcription-media.rajvishvakarma088.workers.dev';
  res.status(200).json({base: /^https:\/\/[^/]+$/.test(url) ? url : null});
}
