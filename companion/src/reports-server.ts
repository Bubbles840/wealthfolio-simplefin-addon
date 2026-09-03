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
import {
  headlineStatValues, DEFAULT_HEADLINE_IDS, merchantTable, subscriptionSummary, dataCheckResult,
} from '../../shared/report-data.js';
import { renderReportSvg, renderCustomReportSvg, reportImageTitle, RENDERABLE_REPORT_IDS } from '../../shared/report-render.js';
import {
  resolveBoard, swapCard, toggleHidden, STANDARD_REPORT_IDS, POOL_ONLY_REPORT_IDS, type BudgetLayout,
} from '../../shared/budget-layout.js';
import { evaluateCustomReport, type CustomReport } from '../../shared/report-eval.js';

export interface ReportsServerDeps {
  botToken(): Promise<string | null>;
  allowedUserIds(): Promise<number[]>;
  readCube(): Promise<ReportCube | null>;
  /** The SAME layout secret the Budget tab arranges — the phone mirrors the
   *  desktop board, and the phone's controls write back to it. */
  readLayout(): Promise<BudgetLayout | null>;
  writeLayout(next: BudgetLayout): Promise<void>;
  readCustomReports(): Promise<CustomReport[]>;
  readHiddenSubscriptions(): Promise<string[]>;
  readConfirmedSubscriptions(): Promise<string[]>;
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
  var currentRange = '6';
  function load(range, action) {
    currentRange = range || currentRange;
    var params = { initData: initData, range: currentRange };
    if (action) params.action = action;
    fetch('page', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    }).then(function (r) { return r.text(); }).then(function (html) {
      document.body.innerHTML = html;
      document.querySelectorAll('[data-range]').forEach(function (b) {
        b.addEventListener('click', function () { load(b.getAttribute('data-range')); });
      });
      document.querySelectorAll('[data-action]').forEach(function (b) {
        b.addEventListener('click', function () { load(currentRange, b.getAttribute('data-action')); });
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

interface BoardData {
  cube: ReportCube | null;
  range: string;
  layout: BudgetLayout | null;
  customs: CustomReport[];
  hiddenSubs: string[];
  confirmedSubs: string[];
}

const usd2 = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 }).format(cents / 100);

function dashboardHtml(data: BoardData): string {
  const { cube, range, layout, customs } = data;
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
    .row{display:flex;justify-content:space-between;padding:5px 2px;border-bottom:1px solid #242927;font-size:14px}
    .row.total{font-weight:700;border-bottom:none}
    .sub{color:#8a9490;font-size:13px}
    .ctl{float:right;display:inline-flex;gap:4px}
    .ctl button{border:1px solid #37403d;background:transparent;color:#8a9490;border-radius:6px;padding:1px 7px;font-size:12px}
  </style>`;
  if (!cube) {
    return `${style}<div class="rep"><p>No report data yet — it arrives after the next sync.</p></div>`;
  }
  const slice = (r: string) => sliceCubeMonths(cube, r === 'all' ? 'all' : r === 'pool' ? 'pool' : Math.max(1, Number(r) || 6));
  const view = slice(range);
  const chips = `<div class="chips">${RANGES.map((r) =>
    `<button data-range="${r.value}"${r.value === range ? ' data-on' : ''}>${r.label}</button>`).join('')}</div>`;

  const stats = headlineStatValues(view);
  const pickIds = layout?.headline && layout.headline.length > 0
    ? layout.headline
    : DEFAULT_HEADLINE_IDS.concat(['net-flow', 'net-worth', 'subs-cost']);
  const tiles = pickIds
    .map((id) => stats.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map((s) => `<div class="tile"><span>${esc(s.label)}</span><b>${esc(s.value)}</b></div>`)
    .join('');

  // The SAME board the Budget tab shows, in reading order, hidden respected.
  const availableIds = [
    ...STANDARD_REPORT_IDS.filter((id) => !POOL_ONLY_REPORT_IDS.has(id) || cube.pool !== null),
    ...customs.map((r) => `custom:${r.id}`),
  ];
  const board = resolveBoard(layout, availableIds, cube.pool !== null)
    .sort((a, b) => a.y - b.y || a.x - b.x);

  const RENDERABLE = new Set<string>(RENDERABLE_REPORT_IDS);
  const ctl = (id: string) =>
    `<span class="ctl"><button data-action="up:${id}">▲</button><button data-action="down:${id}">▼</button><button data-action="hide:${id}">✕</button></span>`;
  const section = (id: string, title: string, inner: string) =>
    `<h2>${esc(title)}${ctl(id)}</h2>${inner}`;

  const cards = board.map(({ id }) => {
    const cardView = (() => {
      const pinned = layout?.ranges?.[id];
      if (pinned === undefined || (pinned === 'pool' && !cube.pool)) return view;
      return slice(String(pinned));
    })();
    if (id === 'headline-stats') return '';
    if (RENDERABLE.has(id)) {
      const svg = renderReportSvg(cardView, id, { width: 640, height: 340 });
      return svg ? section(id, reportImageTitle(id), svg) : '';
    }
    if (id === 'merchants') {
      const rows = merchantTable(cardView, 3).slice(0, 8)
        .map((r) => `<div class="row"><span>${esc(r.name)}</span><span>${usd2(Math.round(r.total * 100))}</span></div>`)
        .join('');
      return rows ? section(id, 'Merchants', rows) : '';
    }
    if (id === 'subscriptions') {
      const res = subscriptionSummary(cube);
      if (!res) return '';
      const hiddenSet = new Set(data.hiddenSubs);
      const confirmedSet = new Set(data.confirmedSubs);
      const visible = res.subs.filter((sub) => !hiddenSet.has(sub.name));
      const sure = visible.filter((sub) => (sub.kind ?? 'subscription') === 'subscription' || confirmedSet.has(sub.name));
      const rows = sure
        .map((sub) => `<div class="row"><span>${esc(sub.name)}</span><span>${usd2(sub.monthlyCents)}/mo</span></div>`)
        .join('');
      const total = sure.reduce((sum, sub) => sum + sub.monthlyCents, 0);
      return section(id, 'Subscriptions', `${rows}<div class="row total"><span>Total</span><span>${usd2(total)}/mo across ${sure.length}</span></div>`);
    }
    if (id === 'data-check') {
      const res = dataCheckResult(cube);
      const text = !res ? 'No check published yet.'
        : res.status === 'match' ? '✓ The Budget tab matches the ledger.'
          : `Measures disagree for ${res.month} — open the Budget tab for detail.`;
      return section(id, 'Data check', `<p class="sub">${esc(text)}</p>`);
    }
    if (id.startsWith('custom:')) {
      const def = customs.find((r) => `custom:${r.id}` === id);
      if (!def) return '';
      const svg = renderCustomReportSvg(cardView, def, { width: 640, height: 320 });
      if (svg) return section(id, def.name, svg);
      const out = evaluateCustomReport(cardView, def);
      const rows = out.months.map((m, mi) =>
        `<div class="row"><span>${esc(String(m))}</span><span>${out.series.map((sr) => {
          const v = sr.values[mi];
          return typeof v === 'number' ? usd2(v) : '—';
        }).join(' · ')}</span></div>`).join('');
      return section(id, def.name, rows);
    }
    // The remaining cards (seasonality, calendars, gauges) are Budget-tab
    // furniture — quietly absent here rather than badly translated.
    return '';
  }).filter((c) => c !== '').join('');

  const hiddenIds = (layout?.hidden ?? []).filter((id) => availableIds.includes(id));
  const hiddenRow = hiddenIds.length > 0
    ? `<h2>Hidden</h2><div class="chips">${hiddenIds.map((id) =>
      `<button data-action="unhide:${id}">${esc(reportImageTitle(id))} — unhide</button>`).join('')}</div>`
    : '';

  return `${style}<div class="rep">${chips}<div class="tiles">${tiles}</div>${cards}${hiddenRow}</div>`;
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
    const customs = await deps.readCustomReports();
    let layout = await deps.readLayout();

    // Phone-side board edits: the SAME mutations the Budget tab uses, written
    // to the SAME secret — arrange once, see it everywhere.
    const action = params.get('action');
    if (action && cube) {
      const [verb, id] = [action.slice(0, action.indexOf(':')), action.slice(action.indexOf(':') + 1)];
      const availableIds = [
        ...STANDARD_REPORT_IDS.filter((rid) => !POOL_ONLY_REPORT_IDS.has(rid) || cube.pool !== null),
        ...customs.map((r) => `custom:${r.id}`),
      ];
      const stored: BudgetLayout = layout ?? { heroes: [], order: [], hidden: [] };
      let next: BudgetLayout | null = null;
      if (verb === 'up') next = swapCard(stored, availableIds, cube.pool !== null, id, -1);
      else if (verb === 'down') next = swapCard(stored, availableIds, cube.pool !== null, id, 1);
      else if ((verb === 'hide' && !stored.hidden.includes(id)) || (verb === 'unhide' && stored.hidden.includes(id))) {
        next = toggleHidden(stored, availableIds, id);
      }
      if (next) {
        await deps.writeLayout(next);
        layout = next;
      }
    }

    return {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: dashboardHtml({
        cube, range, layout, customs,
        hiddenSubs: await deps.readHiddenSubscriptions(),
        confirmedSubs: await deps.readConfirmedSubscriptions(),
      }),
    };
  }
  return { status: 404, contentType: 'text/plain', body: 'Not found.' };
}
