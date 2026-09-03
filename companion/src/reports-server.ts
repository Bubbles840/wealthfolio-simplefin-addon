/**
 * companion/src/reports-server.ts
 *
 * The Telegram mini app: a server-rendered mobile dashboard (v1.44.0).
 *
 * Shape: GET / serves a tiny bootstrap page that runs inside Telegram's
 * webview, grabs `Telegram.WebApp.initData`, and POSTs it to /page; the
 * server validates the signature (miniapp-auth), checks the caller against
 * the allowlist the /reports command builds, and answers with the full
 * dashboard HTML — headline numbers plus the glanceable charts as INLINE
 * SVGs from shared/report-render. No client framework, no bundle, no
 * cookies: auth rides every request as initData, which Telegram re-signs on
 * each open.
 *
 * Everything is dependency-injected and the handler is a pure
 * request-in/response-out function, so the suite exercises real signatures
 * and real SVGs without opening a socket.
 */
import { validateInitData } from './miniapp-auth.js';
import { sliceCubeMonths, type ReportCube } from '../../shared/report-cube.js';
import { headlineStatValues, DEFAULT_HEADLINE_IDS } from '../../shared/report-data.js';
import { renderReportSvg, reportImageTitle, RENDERABLE_REPORT_IDS } from '../../shared/report-render.js';

export interface ReportsServerDeps {
  botToken(): Promise<string | null>;
  allowedUserIds(): Promise<number[]>;
  readCube(): Promise<ReportCube | null>;
  now?: () => Date;
}

export interface SimpleRequest { method: string; path: string; body: string }
export interface SimpleResponse { status: number; contentType: string; body: string }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const BOOTSTRAP = `<!doctype html>
<html><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Reports</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>body{background:#141716;color:#cdd5d1;font-family:system-ui,sans-serif;margin:0;padding:24px;text-align:center}</style>
</head><body>
<p id="msg">Loading your reports…</p>
<script>
(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var initData = tg ? tg.initData : '';
  if (!initData) { document.getElementById('msg').textContent = 'Open this page from the Telegram bot button.'; return; }
  if (tg) tg.expand();
  function load(range) {
    fetch('page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ initData: initData, range: range || '6' }).toString(),
    }).then(function (r) { return r.text(); }).then(function (html) {
      document.body.innerHTML = html;
      document.querySelectorAll('[data-range]').forEach(function (b) {
        b.addEventListener('click', function () { load(b.getAttribute('data-range')); });
      });
    }).catch(function () { document.getElementById('msg').textContent = 'Could not reach the companion.'; });
  }
  load('6');
})();
</script>
</body></html>`;

const RANGES: Array<{ label: string; value: string }> = [
  { label: '1m', value: '1' }, { label: '3m', value: '3' }, { label: '6m', value: '6' },
  { label: '12m', value: '12' }, { label: 'All', value: 'all' },
];

function dashboardHtml(cube: ReportCube | null, range: string): string {
  const style = `<style>
    .rep{max-width:640px;margin:0 auto;padding:8px 12px 40px;font-family:system-ui,sans-serif;color:#cdd5d1}
    .rep h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#8a9490;margin:18px 0 6px}
    .rep svg{width:100%;height:auto;border-radius:12px}
    .chips{display:flex;gap:6px;margin:4px 0 8px}
    .chips button{border:1px solid #37403d;background:transparent;color:#cdd5d1;border-radius:999px;padding:5px 12px;font-size:13px}
    .chips button[data-on]{background:#2a3a35;border-color:#5e9483}
    .tiles{display:flex;gap:8px;flex-wrap:wrap}
    .tile{flex:1 1 30%;background:#1c1f1e;border-radius:12px;padding:10px 12px}
    .tile b{display:block;font-size:18px;margin-top:2px}
    .tile span{font-size:10.5px;letter-spacing:.06em;text-transform:uppercase;color:#8a9490}
  </style>`;
  if (!cube) {
    return `${style}<div class="rep"><p>No report data yet — it arrives after the next sync.</p></div>`;
  }
  const view = sliceCubeMonths(cube, range === 'all' ? 'all' : Math.max(1, Number(range) || 6));
  const chips = `<div class="chips">${RANGES.map((r) =>
    `<button data-range="${r.value}"${r.value === range ? ' data-on' : ''}>${r.label}</button>`).join('')}</div>`;
  const stats = headlineStatValues(view);
  const tiles = DEFAULT_HEADLINE_IDS
    .concat(['net-flow', 'net-worth', 'subs-cost'])
    .map((id) => stats.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => `<div class="tile"><span>${esc(s.label)}</span><b>${esc(s.value)}</b></div>`)
    .join('');
  const charts = RENDERABLE_REPORT_IDS
    .map((id) => ({ id: id as string, svg: renderReportSvg(view, id, { width: 640, height: 340 }) }))
    .filter((c): c is { id: string; svg: string } => c.svg !== null)
    .map((c) => `<h2>${esc(reportImageTitle(c.id))}</h2>${c.svg}`)
    .join('');
  return `${style}<div class="rep">${chips}<div class="tiles">${tiles}</div>${charts}</div>`;
}

export async function handleReportsRequest(
  deps: ReportsServerDeps,
  req: SimpleRequest,
): Promise<SimpleResponse> {
  if (req.method === 'GET' && (req.path === '/' || req.path === '')) {
    return { status: 200, contentType: 'text/html; charset=utf-8', body: BOOTSTRAP };
  }
  if (req.method === 'POST' && req.path === '/page') {
    const params = new URLSearchParams(req.body);
    const token = await deps.botToken();
    if (!token) return { status: 503, contentType: 'text/plain', body: 'Telegram is not configured.' };
    const auth = validateInitData(params.get('initData') ?? '', token, deps.now?.() ?? new Date());
    if (!auth) return { status: 401, contentType: 'text/plain', body: 'Not signed by the bot.' };
    const allowed = await deps.allowedUserIds();
    if (!allowed.includes(auth.userId)) {
      // Deliberately instructive: the allowlist is built by using /reports
      // once in the chat, so the fix is one message away.
      return { status: 403, contentType: 'text/plain', body: 'Not authorized — send /charts to the bot once, then reopen.' };
    }
    const cube = await deps.readCube();
    const range = params.get('range') ?? '6';
    return { status: 200, contentType: 'text/html; charset=utf-8', body: dashboardHtml(cube, range) };
  }
  return { status: 404, contentType: 'text/plain', body: 'Not found.' };
}
