// Stands in for scrapling/bridge.py in tests: same line protocol, fixed pages, no network.
import {createInterface} from 'node:readline';
const PAGES = {
  'https://acme.example/': {type: 'text/html', body: '<html><head><link rel="stylesheet" href="/main.css"><style>.card{border-radius:12px;padding:16px}</style></head><body><a href="/about">About</a><a href="https://elsewhere.example/">Out</a><a href="/missing">Gone</a><a href="/archive">Old version</a></body></html>'},
  'https://acme.example/main.css': {type: 'text/css', body: ':root{--color-brand:#7C3AED;--space-4:16px} .btn{padding:8px 16px;background:var(--color-brand);color:#fff;border-radius:8px} .btn:hover{opacity:.9}'},
  'https://acme.example/about': {type: 'text/html', body: '<html><head><link rel=stylesheet href="main.css"></head><body>About</body></html>'},
  'https://acme.example/archive': {type: 'text/html', body: '<html><head><link rel="stylesheet" href="/old/v1.css"></head><body><a href="/archive/deeper">Deeper</a></body></html>'},
  'https://acme.example/old/v1.css': {type: 'text/css', body: '.btn-legacy{background:#337ab7}'},
};
const write = payload => process.stdout.write(JSON.stringify(payload) + '\n');
if (process.env.FAKE_SCRAPLING_MISSING) { createInterface({input: process.stdin}).on('line', line => write({id: JSON.parse(line).id, error: 'Scrapling is not available: No module named scrapling'})); }
else createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.check) return write({id: request.id, ok: true});
  const page = PAGES[request.url];
  write(page ? {id: request.id, status: 200, url: request.url, contentType: page.type, body: Buffer.from(page.body).toString('base64')} : {id: request.id, status: 404, url: request.url, contentType: 'text/html', body: ''});
});
