// ARGYNIX status monitor — runs from GitHub Actions every five minutes, so it keeps
// working when the ARGYNIX server itself is down (the case it exists for).
//
// For each check in checks.json it records the result (data/current.json), a daily
// uptime tally (data/uptime.json, 90 days) and outages (data/incidents.json). A
// check goes down after `failuresBeforeDown` failures in a row (default 2, so one
// dropped request is not an outage). Going down opens a GitHub issue labelled
// "outage" — GitHub emails the repository's watchers — and, when the secrets are
// set, sends a Telegram message; coming back comments on the issue and closes it.
//
// Node 20+, no dependencies.

import fs from 'node:fs/promises';
import tls from 'node:tls';

const TIMEOUT_MS = 15_000;
const KEEP_DAYS = 90;
const { GITHUB_TOKEN, GITHUB_REPOSITORY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
const DRY = process.argv.includes('--dry-run');   // local test: no issues, no messages, no writes

const readJson = async (f, dflt) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return dflt; } };
const writeJson = (f, v) => fs.writeFile(f, JSON.stringify(v, null, 1) + '\n');

async function probeHttp(c) {
  const t0 = Date.now();
  try {
    const r = await fetch(c.url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': 'argynix-status/1 (+https://github.com/Argynix/Argynix-Status)' } });
    const ms = Date.now() - t0;
    if (r.status >= 400) return { ok: false, ms, code: r.status, detail: `HTTP ${r.status}` };
    if (c.json) {
      const body = await r.json().catch(() => null);
      for (const [k, want] of Object.entries(c.json)) {
        if (!body || body[k] !== want) return { ok: false, ms, code: r.status, detail: `${k} is ${JSON.stringify(body?.[k])}` };
      }
    }
    return { ok: true, ms, code: r.status };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, code: 0, detail: e.name === 'TimeoutError' ? 'no answer in 15 s' : String(e.cause?.code || e.message) };
  }
}

function certDaysLeft(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: TIMEOUT_MS }, () => {
      const cert = s.getPeerCertificate();
      s.end();
      resolve(cert?.valid_to ? Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86_400_000) : null);
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => { s.destroy(); resolve(null); });
  });
}

async function probeTls(c) {
  const t0 = Date.now();
  const days = await Promise.all(c.hosts.map(certDaysLeft));
  const bad = c.hosts.map((h, i) => [h, days[i]]).filter(([, d]) => d === null || d < c.minDays);
  const min = Math.min(...days.filter((d) => d !== null));
  if (bad.length) {
    return { ok: false, ms: Date.now() - t0, code: 0,
      detail: bad.map(([h, d]) => (d === null ? `${h}: no certificate` : `${h}: expires in ${d} days`)).join('; ') };
  }
  return { ok: true, ms: Date.now() - t0, code: 0, detail: `soonest expiry in ${min} days` };
}

async function gh(path, method = 'GET', body) {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || DRY) return null;
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
    method, headers: { authorization: `Bearer ${GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.ok ? r.json() : null;
}

async function telegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID || DRY) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  }).catch(() => {});
}

const minutes = (from, to) => Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 60_000));

const cfg = await readJson('checks.json', { checks: [] });
const current = await readJson('data/current.json', { checks: {} });
const uptime = await readJson('data/uptime.json', {});
const incidents = await readJson('data/incidents.json', []);
const now = new Date().toISOString();
const day = now.slice(0, 10);

for (const c of cfg.checks.filter((x) => !x.disabled)) {
  const r = c.type === 'tls' ? await probeTls(c) : await probeHttp(c);
  const prev = current.checks[c.id] || { state: 'up', fails: 0, since: now };
  const fails = r.ok ? 0 : (prev.fails || 0) + 1;
  const state = r.ok ? 'up' : fails >= (c.failuresBeforeDown ?? 2) ? 'down' : prev.state;
  const next = { name: c.name, internal: !!c.internal, state, fails, since: state === prev.state ? prev.since : now,
    checked: now, ms: r.ms, code: r.code, detail: r.detail || '', issue: prev.issue || null };

  if (state === 'down' && prev.state !== 'down') {
    const inc = { check: c.id, name: c.name, start: now, end: null, detail: r.detail || '' };
    const issue = await gh('/issues', 'POST', {
      title: `${c.name} is down`,
      body: `**${c.name}** failed ${fails} check${fails === 1 ? '' : 's'} in a row.\n\n- ${c.url || c.hosts?.join(', ')}\n- ${r.detail || `HTTP ${r.code}`}\n- since ${now}\n\nThis issue closes itself when the check passes again.`,
      labels: ['outage'],
    });
    inc.issue = issue?.number ?? null;
    next.issue = inc.issue;
    incidents.unshift(inc);
    await telegram(`ARGYNIX: ${c.name} is DOWN — ${r.detail || `HTTP ${r.code}`}`);
    console.log(`DOWN ${c.id}: ${r.detail}`);
  } else if (state === 'up' && prev.state === 'down') {
    const inc = incidents.find((i) => i.check === c.id && !i.end);
    if (inc) inc.end = now;
    const took = inc ? minutes(inc.start, now) : null;
    if (prev.issue) {
      await gh(`/issues/${prev.issue}/comments`, 'POST', { body: `Back up at ${now}${took ? ` after ${took} min` : ''}.` });
      await gh(`/issues/${prev.issue}`, 'PATCH', { state: 'closed' });
    }
    next.issue = null;
    await telegram(`ARGYNIX: ${c.name} is back up${took ? ` after ${took} min` : ''}`);
    console.log(`UP   ${c.id}`);
  } else {
    console.log(`${state === 'up' ? 'ok  ' : 'FAIL'} ${c.id} ${r.ms} ms ${r.detail || ''}`);
  }
  current.checks[c.id] = next;

  // Daily tally: [ok, total, sum of ms]
  const u = (uptime[c.id] ||= {});
  const d = (u[day] ||= [0, 0, 0]);
  d[0] += r.ok ? 1 : 0; d[1] += 1; d[2] += r.ms;
  for (const k of Object.keys(u)) if (Date.parse(k) < Date.parse(day) - KEEP_DAYS * 86_400_000) delete u[k];
}

// Checks removed from checks.json leave the page too.
for (const id of Object.keys(current.checks)) if (!cfg.checks.some((c) => c.id === id && !c.disabled)) delete current.checks[id];
current.updated = now;

if (!DRY) {
  await fs.mkdir('data', { recursive: true });
  await writeJson('data/current.json', current);
  await writeJson('data/uptime.json', uptime);
  await writeJson('data/incidents.json', incidents.slice(0, 100));
}
