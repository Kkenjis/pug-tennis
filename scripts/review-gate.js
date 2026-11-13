// PUG 練習出欠アプリ：リリース前の自動チェック（GitHub Actions から実行）
//   node scripts/review-gate.js security   … コードのセキュリティ自動チェック
//   node scripts/review-gate.js human      … プルリクエストの目視チェックリストがすべて済んでいるか
// どちらも不合格なら終了コード1で止まり、main にマージできない（ブランチ保護で必須に設定）
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const mode = process.argv[2] || 'security';
const passed = [];
const failed = [];
const check = (cond, msg) => (cond ? passed : failed).push(msg);

function syntaxOk(code, name) {
  const tmp = path.join(os.tmpdir(), name);
  fs.writeFileSync(tmp, code);
  try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); return true; } catch (_) { return false; }
}

// 画面（HTML）ごとのチェック。本番の index.html と、お試し版の preview/index.html の両方に同じ基準をかける
function checkPage(file) {
  const html = fs.readFileSync(file, 'utf8');
  const tag = file === 'index.html' ? '' : '［' + file + '］';
  const checkP = (cond, msg) => check(cond, tag + msg);
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

  checkP(js.length > 0 && syntaxOk(js, 'front.js'), '画面のスクリプトに文法エラーがない');

  const srcs = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)].map(m => m[1]);
  checkP(srcs.length > 0 && srcs.every(s => s.startsWith('https://static.line-scdn.net/liff/')),
    '外部スクリプトはLIFF SDKだけ（' + (srcs.join(', ') || 'なし') + '）');

  const styles = [...html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g)].map(m => m[1]);
  checkP(styles.every(h => h.startsWith('https://fonts.googleapis.com/')), '外部スタイルはGoogleフォントだけ');

  const fetches = [...js.matchAll(/fetch\(\s*([^,)]+)/g)].map(m => m[1].trim());
  checkP(fetches.length > 0 && fetches.every(f => f === 'CONFIG.GAS_URL'), 'API呼び出し先は CONFIG.GAS_URL だけ');
  checkP(/GAS_URL:\s*'https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec'/.test(js), 'GAS_URL がApps Scriptの正規URL');
  checkP(!/XMLHttpRequest|sendBeacon|new WebSocket|\beval\(|new Function\(/.test(js),
    '想定外の通信や動的実行（XMLHttpRequest・sendBeacon・WebSocket・eval）がない');

  checkP(/const esc = /.test(js), 'エスケープ関数 esc() がある');
  // textContent への代入はHTMLとして解釈されないので対象外
  const htmlLines = js.split('\n').filter(l => !/\.textContent\s*=/.test(l)).join('\n');
  ['e.name', 'e.comment', 'ev.place', 'ev.note', 's.myComment', 'data.me.name'].forEach(k => {
    const raw = new RegExp('\\$\\{\\s*' + k.replace(/\./g, '\\.') + '\\s*\\}');
    checkP(!raw.test(htmlLines), k + ' をエスケープせずに画面へ埋め込んでいない');
  });
  checkP(/pugRelogin/.test(js), '再ログインの回数制限が残っている');
}

function security() {
  ['index.html', 'preview/index.html'].filter(f => fs.existsSync(f)).forEach(checkPage);

  const secretRe = /(channel[_ ]?secret\s*[:=]\s*['"][0-9a-f]{32}['"]|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[0-9A-Za-z]{36})/i;
  const mdUnder = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? mdUnder(dir + '/' + d.name) : d.name.endsWith('.md') ? [dir + '/' + d.name] : []) : [];
  const docs = mdUnder('docs');
  ['index.html', 'preview/index.html', 'README.md', 'CLAUDE.md', 'gas/Code.gs', ...docs].filter(f => fs.existsSync(f)).forEach(f => {
    check(!secretRe.test(fs.readFileSync(f, 'utf8')), f + ' に秘密情報らしき文字列がない');
  });

  if (fs.existsSync('gas/Code.gs')) {
    const gs = fs.readFileSync('gas/Code.gs', 'utf8');
    check(syntaxOk(gs, 'code.js'), 'Code.gs に文法エラーがない');
    check(/api\.line\.me\/oauth2\/v2\.1\/verify/.test(gs) && /client_id:\s*LINE_CHANNEL_ID/.test(gs) && /p\.aud !== LINE_CHANNEL_ID/.test(gs),
      'LINEの検証API（client_id指定・aud確認）で本人確認している');
    ['createEvents', 'deleteEvent', 'setGuestOpen', 'setNotice'].forEach(a => {
      const m = gs.match(new RegExp("case '" + a + "':([\\s\\S]*?)break;"));
      check(!!m && /requireAdmin\(\)/.test(m[1]), a + ' の前に管理者チェックがある');
    });
    // 一覧（list）と出欠（entry）以外の操作は、新しく増えたものも含めてすべて管理者だけ
    const cases = [...gs.matchAll(/case '([A-Za-z]+)':([\s\S]*?)break;/g)].filter(m => !['list', 'entry'].includes(m[1]));
    const noAdmin = cases.filter(m => !/requireAdmin\(\)/.test(m[2])).map(m => m[1]);
    check(cases.length >= 4 && noAdmin.length === 0,
      noAdmin.length ? '管理者チェックのない操作：' + noAdmin.join('、') : 'list・entry 以外の操作（' + cases.map(m => m[1]).join('、') + '）はすべて管理者チェックがある');
    check(/function guestsOf_\(v\) \{ return clamp_\(/.test(gs) && /guests: 9/.test(gs), 'ゲスト人数をサーバー側で 0〜9 に制限している');
    check(/!isMember && !isTrue_\(ev\.v\[5\]\)/.test(gs), 'ゲストのメンバー限定日への回答をサーバー側で拒否している');
    check((gs.match(/safeCell_\(/g) || []).length >= 8, 'シートへの書き込みに safeCell_() を使っている（数式インジェクション対策）');
    check(/audit_\(req, user, res\)/.test(gs), '操作ログ（audit_）が残っている');
  }
}

function human() {
  const event = process.env.GITHUB_EVENT_NAME || '';
  if (event !== 'pull_request') {
    passed.push('プルリクエスト以外の実行のため対象外');
    return;
  }
  const body = process.env.PR_BODY || '';
  const boxes = [...body.matchAll(/^\s*[-*] \[( |x|X)\] (.+)$/gm)];
  const open = boxes.filter(m => m[1] === ' ').map(m => m[2].trim());
  check(boxes.length >= 5, '目視チェックリストがプルリクエスト本文にある（テンプレートを消さない）');
  check(open.length === 0, open.length ? '未チェックの項目：' + open.join(' ／ ') : '目視チェックがすべて完了している');
}

if (mode === 'human') human(); else security();

const lines = [
  '## ' + (mode === 'human' ? '目視チェック' : 'セキュリティ自動チェック') + '：' + (failed.length ? '不合格 ❌' : '合格 ✅'),
  '',
  ...failed.map(m => '- ❌ ' + m),
  ...passed.map(m => '- ✅ ' + m),
];
console.log(lines.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
process.exit(failed.length ? 1 : 0);
