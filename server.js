const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const MAX_ITEMS = 500;
const MAX_BODY_BYTES = 16 * 1024;
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseExternalUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, 'Informe um link válido do YouTube ou Spotify.');
  }
  if (url.protocol !== 'https:') {
    throw new HttpError(400, 'Use um link HTTPS do YouTube ou Spotify.');
  }

  const host = url.hostname.toLowerCase();
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
    const playlistId = url.searchParams.get('list');
    if (playlistId && /^[\w-]{1,128}$/.test(playlistId)) {
      return { provider: 'YouTube', type: 'playlist', id: playlistId };
    }

    const parts = url.pathname.split('/').filter(Boolean);
    const videoId = host === 'youtu.be'
      ? parts[0]
      : url.searchParams.get('v') || (['shorts', 'embed', 'live'].includes(parts[0]) ? parts[1] : null);
    if (videoId && /^[\w-]{6,20}$/.test(videoId)) return { provider: 'YouTube', type: 'video', id: videoId };
    throw new HttpError(400, 'O link do YouTube não contém um vídeo ou playlist reconhecido.');
  }

  if (host === 'open.spotify.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    const hasLocale = parts.length === 3 && /^(?:[a-z]{2}|intl-[a-z]{2})$/.test(parts[0]);
    const type = hasLocale ? parts[1] : parts[0];
    const id = hasLocale ? parts[2] : parts[1];
    if (['track', 'playlist'].includes(type) && id && /^[A-Za-z0-9]+$/.test(id)) {
      return { provider: 'Spotify', type, id };
    }
    throw new HttpError(400, 'O link do Spotify deve apontar para uma música ou playlist.');
  }

  throw new HttpError(400, 'O link deve pertencer ao YouTube ou Spotify.');
}

async function fetchJson(url, options, provider) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new HttpError(502, `Não foi possível conectar à API do ${provider}.`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new HttpError(502, `A API do ${provider} retornou uma resposta inválida.`);
  }
  if (!response.ok) {
    const message = data.error?.message || data.error?.status || `HTTP ${response.status}`;
    throw new HttpError(502, `A API do ${provider} recusou a consulta: ${message}`);
  }
  return data;
}

async function fetchYouTube(url) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) throw new HttpError(503, 'Configure YOUTUBE_API_KEY no servidor para indexar links do YouTube.');
  const link = parseExternalUrl(url);

  async function query(endpoint, params) {
    const requestUrl = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
    requestUrl.search = new URLSearchParams({ ...params, key: apiKey }).toString();
    return fetchJson(requestUrl, undefined, 'YouTube');
  }

  if (link.type === 'video') {
    const result = await query('videos', { part: 'snippet', id: link.id });
    const video = result.items?.[0];
    if (!video) throw new HttpError(404, 'O vídeo não existe ou não está disponível publicamente.');
    return {
      items: [{
        title: video.snippet?.title || `Vídeo ${link.id}`,
        provider: 'YouTube',
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(link.id)}`,
      }],
      truncated: false,
    };
  }

  const items = [];
  let pageToken = '';
  let truncated = false;
  do {
    const result = await query('playlistItems', {
      part: 'snippet',
      playlistId: link.id,
      maxResults: '50',
      ...(pageToken ? { pageToken } : {}),
    });
    for (const entry of result.items || []) {
      const videoId = entry.snippet?.resourceId?.videoId;
      if (!videoId) continue;
      items.push({
        title: entry.snippet?.title || `Vídeo ${videoId}`,
        provider: 'YouTube',
        url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
      });
      if (items.length >= MAX_ITEMS) {
        truncated = !!result.nextPageToken;
        break;
      }
    }
    pageToken = items.length >= MAX_ITEMS ? '' : (result.nextPageToken || '');
  } while (pageToken);

  if (!items.length) throw new HttpError(404, 'A playlist não contém vídeos públicos para indexar.');
  return { items, truncated };
}

let spotifyAccessToken = '';
let spotifyTokenExpiresAt = 0;

async function getSpotifyAccessToken() {
  if (spotifyAccessToken && Date.now() < spotifyTokenExpiresAt) return spotifyAccessToken;
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new HttpError(503, 'Configure SPOTIFY_CLIENT_ID e SPOTIFY_CLIENT_SECRET no servidor para indexar links do Spotify.');
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'client_credentials' });
  const result = await fetchJson('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  }, 'Spotify');
  spotifyAccessToken = result.access_token;
  spotifyTokenExpiresAt = Date.now() + Math.max(0, result.expires_in - 60) * 1000;
  return spotifyAccessToken;
}

async function fetchSpotify(url) {
  const link = parseExternalUrl(url);
  const token = await getSpotifyAccessToken();

  async function query(endpoint) {
    const apiUrl = new URL(endpoint, 'https://api.spotify.com/v1/');
    if (apiUrl.origin !== 'https://api.spotify.com' || !apiUrl.pathname.startsWith('/v1/')) {
      throw new HttpError(502, 'A API do Spotify retornou uma URL de paginação inválida.');
    }
    return fetchJson(apiUrl, { headers: { Authorization: `Bearer ${token}` } }, 'Spotify');
  }

  if (link.type === 'track') {
    const track = await query(`tracks/${encodeURIComponent(link.id)}`);
    return {
      items: [{
        title: `${track.name} — ${(track.artists || []).map((artist) => artist.name).join(', ')}`.trim(),
        provider: 'Spotify',
        url: track.external_urls?.spotify || `https://open.spotify.com/track/${encodeURIComponent(link.id)}`,
      }],
      truncated: false,
    };
  }

  const items = [];
  let next = `playlists/${encodeURIComponent(link.id)}/tracks?limit=100`;
  let truncated = false;
  while (next && items.length < MAX_ITEMS) {
    const result = await query(next);
    for (const entry of result.items || []) {
      const track = entry.track;
      if (!track?.id) continue;
      items.push({
        title: `${track.name} — ${(track.artists || []).map((artist) => artist.name).join(', ')}`.trim(),
        provider: 'Spotify',
        url: track.external_urls?.spotify || `https://open.spotify.com/track/${encodeURIComponent(track.id)}`,
      });
      if (items.length >= MAX_ITEMS) {
        truncated = !!result.next;
        break;
      }
    }
    next = items.length >= MAX_ITEMS ? '' : result.next || '';
  }

  if (!items.length) throw new HttpError(404, 'A playlist não contém músicas disponíveis para indexar.');
  return { items, truncated };
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let settled = false;
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      if (settled) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        settled = true;
        reject(new HttpError(413, 'A solicitação excede o tamanho permitido.'));
        request.resume();
      }
    });
    request.on('end', () => {
      if (settled) return;
      try {
        resolve(JSON.parse(body));
      } catch {
        settled = true;
        reject(new HttpError(400, 'O corpo da solicitação deve ser JSON válido.'));
      }
    });
    request.on('error', reject);
  });
}

function sendJson(response, status, data) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(data));
}

async function handleExternalLink(request, response) {
  const body = await readJsonBody(request);
  if (typeof body.url !== 'string' || !body.url.trim() || body.url.length > 2048) {
    throw new HttpError(400, 'Informe um único link válido de até 2048 caracteres.');
  }
  const link = parseExternalUrl(body.url.trim());
  const result = link.provider === 'YouTube'
    ? await fetchYouTube(body.url.trim())
    : await fetchSpotify(body.url.trim());
  sendJson(response, 200, result);
}

function serveStatic(request, response, pathname) {
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' }).end();
    return;
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400).end('Caminho inválido.');
    return;
  }
  if (decodedPath.split('/').some((part) => part.startsWith('.'))) {
    response.writeHead(404).end('Não encontrado.');
    return;
  }
  const relativePath = decodedPath === '/' ? 'index.html' : decodedPath.slice(1);
  const filePath = path.resolve(ROOT, relativePath);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) ||
      !['index.html', 'app.js', 'style.css'].includes(path.basename(filePath))) {
    response.writeHead(404).end('Não encontrado.');
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500).end('Não foi possível abrir o arquivo.');
      return;
    }
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store',
    });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const requestUrl = new URL(request.url, 'http://localhost');
  if (requestUrl.pathname === '/api/external-links') {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    try {
      await handleExternalLink(request, response);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : 'Falha inesperada ao consultar o link externo.';
      if (status === 500) console.error(error);
      sendJson(response, status, { error: message });
    }
    return;
  }
  serveStatic(request, response, requestUrl.pathname);
});

if (require.main === module) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT deve ser um número entre 1 e 65535.');
  }
  server.listen(port, '127.0.0.1', () => {
    console.log(`Pocket Bard disponível em http://127.0.0.1:${port}`);
  });
}

module.exports = { parseExternalUrl, server };
