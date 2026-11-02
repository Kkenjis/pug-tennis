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

function security() {
  const html = fs.readFileSync('index.html', 'utf8');
  const js = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

  check(js.length > 0 && syntaxOk(js, 'front.js'), '画面のスクリプトに文法エラーがない');

  const srcs = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)].map(m => m[1]);
  check(srcs.length > 0 && srcs.every(s => s.startsWith('https://static.line-scdn.net/liff/')),
    '外部スクリプトはLIFF SDKだけ（' + (srcs.join(', ') || 'なし') + '）');

  const styles = [...html.matchAll(/<link[^>]*rel=["']stylesheet["'][^>]*href=["']([^"']+)["']/g)].map(m => m[1]);
  check(styles.every(h => h.startsWith('https://fonts.googleapis.com/')), '外部スタイルはGoogleフォントだけ');

  const fetches = [...js.matchAll(/fetch\(\s*([^,)]+)/g)].map(m => m[1].trim());
  check(fetches.length > 0 && fetches.every(f => f === 'CONFIG.GAS_URL'), 'API呼び出し先は CONFIG.GAS_URL だけ');
  check(/GAS_URL:\s*'https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec'/.test(js), 'GAS_URL がApps Scriptの正規URL');
  check(!/XMLHttpRequest|sendBeacon|new WebSocket|\beval\(|new Function\(/.test(js),
    '想定外の通信や動的実行（XMLHttpRequest・sendBeacon・WebSocket・eval）がない');

  check(/const esc = /.test(js), 'エスケープ関数 esc() がある');
  // textContent への代入はHTMLとして解釈されないので対象外
  const htmlLines = js.split('\n').filter(l => !/\.textContent\s*=/.test(l)).join('\n');
  ['e.name', 'e.comment', 'ev.place', 'ev.note', 's.myComment', 'data.me.name'].forEach(k => {
    const raw = new RegExp('\\$\\{\\s*' + k.replace(/\./g, '\\.') + '\\s*\\}');
    check(!raw.test(htmlLines), k + ' をエスケープせずに画面へ埋め込んでいない');
  });
  check(/pugRelogin/.test(js), '再ログインの回数制限が残っている');

  const secretRe = /(channel[_ ]?secret\s*[:=]\s*['"][0-9a-f]{32}['"]|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[0-9A-Za-z]{36})/i;
  const docs = fs.existsSync('docs') ? fs.readdirSync('docs').filter(f => f.endsWith('.md')).map(f => 'docs/' + f) : [];
  ['index.html', 'README.md', 'gas/Code.gs', ...docs].filter(f => fs.existsSync(f)).forEach(f => {
    check(!secretRe.test(fs.readFileSync(f, 'utf8')), f + ' に秘密情報らしき文字列がない');
  });

  if (fs.existsSync('gas/Code.gs')) {
    const gs = fs.readFileSync('gas/Code.gs', 'utf8');
    check(syntaxOk(gs, 'code.js'), 'Code.gs に文法エラーがない');
    check(/api\.line\.me\/oauth2\/v2\.1\/verify/.test(gs) && /client_id:\s*LINE_CHANNEL_ID/.test(gs) && /p\.aud !== LINE_CHANNEL_ID/.test(gs),
      'LINEの検証API（client_id指定・aud確認）で本人確認している');
    ['createEvents', 'deleteEvent', 'setGuestOpen'].forEach(a => {
      const m = gs.match(new RegExp("case '" + a + "':([\\s\\S]*?)break;"));
      check(!!m && /requireAdmin\(\)/.test(m[1]), a + ' の前に管理者チェックがある');
    });
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
