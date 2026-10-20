const test = require('node:test');
const assert = require('node:assert/strict');
const { parseExternalUrl, server } = require('./server');

test('recognizes a YouTube video URL', () => {
  assert.deepEqual(parseExternalUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), {
    provider: 'YouTube',
    type: 'video',
    id: 'dQw4w9WgXcQ',
  });
});

test('recognizes a YouTube playlist URL', () => {
  assert.deepEqual(parseExternalUrl('https://youtube.com/playlist?list=PL123456'), {
    provider: 'YouTube',
    type: 'playlist',
    id: 'PL123456',
  });
});

test('recognizes a Spotify track with a locale prefix', () => {
  assert.deepEqual(parseExternalUrl('https://open.spotify.com/intl-pt/track/123abc?si=share'), {
    provider: 'Spotify',
    type: 'track',
    id: '123abc',
  });
});

test('recognizes a Spotify playlist', () => {
  assert.deepEqual(parseExternalUrl('https://open.spotify.com/playlist/abc123'), {
    provider: 'Spotify',
    type: 'playlist',
    id: 'abc123',
  });
});

test('rejects non-HTTPS links and unsupported hosts', () => {
  assert.throws(() => parseExternalUrl('http://youtube.com/watch?v=dQw4w9WgXcQ'), /HTTPS/);
  assert.throws(() => parseExternalUrl('https://example.com/watch?v=dQw4w9WgXcQ'), /YouTube ou Spotify/);
});

test('rejects unsupported Spotify resource types', () => {
  assert.throws(() => parseExternalUrl('https://open.spotify.com/artist/abc123'), /música ou playlist/);
});

test('serves the app and rejects invalid link API requests', async (context) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Link externo/);

  const hiddenSource = await fetch(`${origin}/server.js`);
  assert.equal(hiddenSource.status, 404);

  const invalidLink = await fetch(`${origin}/api/external-links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.com/not-a-provider' }),
  });
  assert.equal(invalidLink.status, 400);
  assert.match((await invalidLink.json()).error, /YouTube ou Spotify/);
});
