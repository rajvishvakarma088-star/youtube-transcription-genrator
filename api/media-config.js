export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const url = process.env.CLOUD_DOWNLOADER_URL || '';
  res.status(200).json({base: /^https:\/\/[^/]+$/.test(url) ? url : null});
}
