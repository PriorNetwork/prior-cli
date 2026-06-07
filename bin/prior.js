#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const chalk       = require('chalk');
const readline    = require('readline');
const path        = require('path');
const os          = require('os');
const fs          = require('fs');
const { execSync } = require('child_process');
const { version } = require('../package.json');

const api = require('../lib/api');
const { renderMarkdown } = require('../lib/render');
const { getToken, getUsername, saveAuth, clearAuth } = require('../lib/config');
const { runAgent, CONFIRM_TOOLS } = require('../lib/agent');

function decodeToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload;
  } catch { return {}; }
}

// ── Theme ──────────────────────────────────────────────────────
const THEME = '#9CE2D4';
const c = {
  brand:  t => chalk.hex(THEME)(t),
  bold:   t => chalk.hex(THEME).bold(t),
  dim:    t => chalk.dim(t),
  muted:  t => chalk.gray(t),
  err:    t => chalk.red(t),
  warn:   t => chalk.yellow(t),
  ok:     t => chalk.green(t),
  link:   t => chalk.cyan.underline(t),
  white:  t => chalk.white(t),
};

const DIVIDER = c.muted('  ' + '─'.repeat(50));

// ── Session saves ──────────────────────────────────────────────
function savesDir(username) {
  return path.join(os.homedir(), '.prior', 'saves', username || 'default');
}

function sanitizeName(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').replace(/\s+/g, '_').slice(0, 60);
}

function listSaves(username) {
  const dir = savesDir(username);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { file: f, name: data.name, savedAt: data.savedAt, msgCount: (data.messages || []).length, model: data.model };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
}

function writeSession(username, name, messages, model) {
  const dir = savesDir(username);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filename = sanitizeName(name) + '.json';
  const data = { name, savedAt: new Date().toISOString(), model, messages };
  fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2), 'utf8');
  return filename;
}

function readSession(username, name) {
  const dir  = savesDir(username);
  const file = sanitizeName(name) + '.json';
  const full = path.join(dir, file);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, 'utf8'));
}

// Arrow-key picker for /load
async function showPicker(items, rl) {
  if (!process.stdout.isTTY) return null;
  return new Promise(resolve => {
    let sel = 0;
    const H = items.length;

    const render = () => {
      items.forEach((item, i) => {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
        const prefix = i === sel ? c.brand('  ❯ ') : c.muted('    ');
        const name   = i === sel ? c.bold(item.name) : c.white(item.name);
        const meta   = c.muted(` · ${item.msgCount} msgs · ${new Date(item.savedAt).toLocaleDateString()}`);
        process.stdout.write(prefix + name + meta + '\n');
      });
      process.stdout.write(c.muted('  ↑ ↓ navigate  ·  Enter select  ·  Esc cancel') + '\n');
      // move cursor back up to top of list
      process.stdout.moveCursor(0, -(H + 1));
    };

    const cleanup = () => {
      // move cursor past the list
      process.stdout.moveCursor(0, H + 1);
      process.stdout.clearLine(0);
      process.stdin.removeListener('keypress', onKey);
      rl.resume();
    };

    const onKey = (str, key) => {
      if (!key) return;
      if (key.name === 'up')                         { sel = (sel - 1 + H) % H; render(); }
      else if (key.name === 'down')                  { sel = (sel + 1) % H; render(); }
      else if (key.name === 'return')                { cleanup(); resolve(items[sel]); }
      else if (key.name === 'escape' || key.ctrl)    { cleanup(); resolve(null); }
    };

    rl.pause();
    process.stdin.on('keypress', onKey);
    console.log('');
    render();
  });
}

// ── Spinner ────────────────────────────────────────────────────
const SPIN_FRAMES = ['◐', '◓', '◑', '◒'];
let _spinTimer = null;
let _spinIdx   = 0;
let _spinStart = null;
let _spinLabel = '';

// ── Tool keyword hints ─────────────────────────────────────────
// Detects keywords in user input and prepends a hard directive so
// the model can't second-guess which tool to use.
const TOOL_HINTS = [
  {
    tool: 'get_time',
    patterns: [
      /\bwhat time\b/i, /\bwhat('s| is) the time\b/i, /\bcurrent time\b/i,
      /\btime (is it|now|right now)\b/i,
    ],
    hint: '[TOOL DIRECTIVE: You MUST call get_time — do NOT guess the time]',
  },
  {
    tool: 'ssl_check',
    patterns: [
      /\bssl\b/i, /\btls\b/i, /\bcertificate\b/i, /\bcert\b/i,
      /\bhttps check\b/i, /\bcert expir/i, /\bssl expir/i,
    ],
    hint: '[TOOL DIRECTIVE: You MUST call ssl_check — do NOT use zap_scan or zap_alerts]',
  },
  {
    tool: 'dns_lookup',
    patterns: [
      /\bdns\b/i, /\bmx record/i, /\bnameserver/i, /\bnslookup\b/i,
      /\bdig\b/i, /\bdns record/i, /\btxt record/i, /\bcname\b/i,
      /\bns record/i, /\baaaa record/i,
    ],
    hint: '[TOOL DIRECTIVE: You MUST call dns_lookup]',
  },
  {
    tool: 'ip_lookup',
    patterns: [
      /\bip lookup\b/i, /\blook up.*ip\b/i, /\bwhere is .+ hosted\b/i,
      /\bwho owns .+(ip|domain)\b/i, /\basn\b/i, /\bgeolocation\b/i,
      /\bwhat ip\b/i, /\bresolve .+(domain|host)\b/i,
      /\blookup\b.*\b(ip|domain|host)\b/i,
    ],
    hint: '[TOOL DIRECTIVE: You MUST call ip_lookup]',
  },
  {
    tool: 'file_edit',
    patterns: [
      /\bedit\b/i, /\bmodify\b/i, /\bchange\b.*\b(file|function|line|code|return|value|variable)\b/i,
      /\brefactor\b/i, /\brename\b.*\b(function|variable|method)\b/i,
      /\bfix\b.*\b(bug|file|code|function|typo)\b/i, /\breplace\b.*\b(in|line|text|code)\b/i,
      /\bupdate\b.*\b(file|function|code|line)\b/i,
    ],
    hint: '[TOOL DIRECTIVE: To change part of an existing file, you MUST use the <edit path="..."> tag with SEARCH/REPLACE markers — do NOT rewrite the whole file with <write>, and never say you cannot edit files]',
  },
  {
    tool: 'generate_image',
    patterns: [
      /\bgenerate\b/i, /\bcreate.*(image|picture|photo|illustration|art)\b/i,
      /\bdraw\b/i, /\brender\b/i, /\bpaint\b/i,
      /\bmake.*(image|picture|photo|illustration|art)\b/i,
      /\bimage of\b/i, /\bpicture of\b/i, /\bphoto of\b/i,
      /\billustrate\b/i, /\bvisualiz[es]\b/i,
    ],
    hint: '[TOOL DIRECTIVE: You MUST call generate_image — do NOT describe the image in text, actually call the tool]',
  },
];

function injectToolHint(text) {
  for (const { patterns, hint } of TOOL_HINTS) {
    if (patterns.some(re => re.test(text))) {
      return `${hint}\n${text}`;
    }
  }
  return text;
}

// ── @file context attachment ───────────────────────────────────
// Expands  @path/to/file  references in a prompt into inline file context,
// so the model sees the contents without a separate file_read round-trip.
const MAX_ATTACH_BYTES = 256 * 1024;
function expandFileRefs(input, cwd) {
  const refRe = /(?:^|\s)@([^\s]+)/g;
  const attached = [];
  const seen = new Set();
  let m;
  while ((m = refRe.exec(input)) !== null) {
    let ref = m[1].replace(/[.,;:)\]]+$/, ''); // trim trailing punctuation
    if (!ref || seen.has(ref)) continue;
    const resolved = (/^[a-zA-Z]:[/\\]/.test(ref) || path.isAbsolute(ref)) ? ref : path.resolve(cwd, ref);
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size > MAX_ATTACH_BYTES) continue;
      const content = fs.readFileSync(resolved, 'utf8');
      if (content.indexOf('\x00') !== -1) continue; // binary
      attached.push({ ref, content, lines: content.split('\n').length });
      seen.add(ref);
    } catch { /* not a readable file — leave the @token as literal text */ }
  }
  if (!attached.length) return { message: input, attached };
  const ctx = attached
    .map(a => `--- Contents of ${a.ref} ---\n${a.content}`)
    .join('\n\n');
  return { message: `${input}\n\n[Attached file context]\n${ctx}`, attached };
}

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

const THINK_LABELS = [
  'thinking…',
  'prioring…',
  'processing…',
  'reasoning…',
  'cooking…',
  'figuring it out…',
  'on it…',
  'analyzing…',
  'tapping into prior…',
  'syncing with the network…',
  'loading prior brain…',
  'consulting the feed…',
  'running it through synapse…',
  'give me a sec…',
  'doing the math…',
  'don\'t rush me…',
  'querying the void…',
  'prior is on it…',
  'booting up neurons…',
  'asking the BEN group…',
  'euwining…',
];

function spinStart(label = '') {
  spinStop();
  if (!process.stdout.isTTY) return;
  _spinLabel = label;
  _spinStart = Date.now();
  const startTime = Date.now(); // captured in closure — never reset by label cycling
  _spinTimer = setInterval(() => {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    const ms = Date.now() - startTime;
    const displayLabel = _spinLabel === 'thinking…'
      ? THINK_LABELS[Math.floor(ms / 4000) % THINK_LABELS.length]
      : _spinLabel;
    process.stdout.write(`  ${c.brand(SPIN_FRAMES[_spinIdx++ % 4])}  ${c.dim(displayLabel)}  ${c.dim('(' + fmtElapsed(ms) + ')')}`);
  }, 100);
}

function spinStop() {
  if (_spinTimer) { clearInterval(_spinTimer); _spinTimer = null; }
  _spinStart = null;
  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
}

// ── Helpers ────────────────────────────────────────────────────
function requireAuth() {
  if (!getToken()) {
    console.error(c.err('  ✗ Not logged in. Run: ') + c.brand('prior login'));
    process.exit(1);
  }
}

function progressBar(pct, width = 22) {
  const filled = Math.round((pct / 100) * width);
  return c.brand('█'.repeat(filled)) + c.muted('░'.repeat(width - filled));
}

function clearLine() {
  if (process.stdout.isTTY) {
    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
  }
}

// ── /learn scanner animation ───────────────────────────────────
async function runLearnAnimation(cwd) {
  const SKIP = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build',
                        '.venv', 'venv', '.cache', 'coverage', '.nyc_output', 'vendor']);
  const TEXT = new Set(['.js','.ts','.jsx','.tsx','.py','.json','.md','.txt','.html',
                        '.css','.scss','.yml','.yaml','.sh','.bat','.go','.rs','.java',
                        '.c','.cpp','.h','.php','.rb','.vue','.svelte','.env','.toml','.ini']);

  const files = [];
  function walk(dir, depth = 0) {
    if (depth > 6) return;
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, depth + 1);
        else files.push({ full, rel: path.relative(cwd, full), ext: path.extname(e.name).toLowerCase() });
      }
    } catch {}
  }
  walk(cwd);
  if (!files.length) return 0;

  const HEIGHT = 8;
  const cols   = Math.min(process.stdout.columns || 100, 120);
  const delay  = Math.max(15, Math.min(90, 3200 / files.length));
  const window = [];

  // Reserve space
  process.stdout.write('\n'.repeat(HEIGHT));
  process.stdout.write(`\x1b[${HEIGHT}A\x1b[s`);

  for (let i = 0; i < files.length; i++) {
    const f = files[i];

    // Read snippet for text files only
    if (TEXT.has(f.ext)) {
      try {
        if (fs.statSync(f.full).size < 150 * 1024) {
          f.snippet = fs.readFileSync(f.full, 'utf8').replace(/\s+/g, ' ').trim().slice(0, 70);
        }
      } catch {}
    }

    window.push(f);
    if (window.length > HEIGHT - 1) window.shift();

    process.stdout.write('\x1b[u');

    // Header
    const spin = SPIN_FRAMES[Math.floor(i / 2) % 4];
    const pct  = Math.round(((i + 1) / files.length) * 100);
    const bar  = progressBar(pct, 14);
    process.stdout.write(`\x1b[2K  ${c.brand(spin)}  ${c.bold('Learning directory')}  ${bar}  ${c.muted(`${i + 1}/${files.length}`)}\n`);

    // File lines
    for (let j = 0; j < HEIGHT - 1; j++) {
      process.stdout.write('\x1b[2K');
      const entry = window[j];
      if (!entry) { process.stdout.write('\n'); continue; }

      const isActive  = j === window.length - 1;
      const connector = isActive ? '└' : '├';
      const maxName   = 30;
      const name      = entry.rel.length > maxName
        ? '…' + entry.rel.slice(-(maxName - 1))
        : entry.rel;
      const snipLen   = cols - maxName - 16;
      const snippet   = (entry.snippet || '').slice(0, snipLen);

      if (isActive) {
        process.stdout.write(`  ${c.brand(connector)} ${c.bold(name.padEnd(maxName))}  ${c.muted(snippet)}\n`);
      } else {
        process.stdout.write(`  ${c.muted(connector)} ${c.muted(name.padEnd(maxName))}  ${c.dim(snippet.slice(0, 35))}\n`);
      }
    }

    await new Promise(r => setTimeout(r, delay));
  }

  // Final frame — full bar
  process.stdout.write('\x1b[u');
  process.stdout.write(`\x1b[2K  ${c.brand('◈')}  ${c.bold('Learning directory')}  ${progressBar(100, 14)}  ${c.ok(`${files.length} files`)}\n`);
  for (let i = 0; i < HEIGHT - 1; i++) process.stdout.write('\x1b[2K\n');
  process.stdout.write('\x1b[u');
  await new Promise(r => setTimeout(r, 400));

  // Clear
  for (let i = 0; i < HEIGHT; i++) process.stdout.write('\x1b[2K\n');
  process.stdout.write(`\x1b[${HEIGHT}A`);

  return files.length;
}

function promptPassword(question) {
  return new Promise(resolve => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, ans => { rl.close(); resolve(ans.trim()); });
      return;
    }
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    let input = '';
    function handler(ch) {
      switch (ch) {
        case '\n': case '\r': case '\u0004':
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', handler);
          process.stdin.pause();
          process.stdout.write('\n');
          resolve(input);
          break;
        case '\u0003': process.exit(); break;
        case '\u007f':
          if (input.length) { input = input.slice(0, -1); process.stdout.write('\b \b'); }
          break;
        default:
          input += ch;
          process.stdout.write('*');
      }
    }
    process.stdin.on('data', handler);
  });
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, ans => resolve(ans.trim())));
}

function banner() {
  console.log('');
  console.log(c.brand('  ██████╗ ██████╗ ██╗ ██████╗ ██████╗ '));
  console.log(c.brand('  ██╔══██╗██╔══██╗██║██╔═══██╗██╔══██╗'));
  console.log(c.brand('  ██████╔╝██████╔╝██║██║   ██║██████╔╝'));
  console.log(c.brand('  ██╔═══╝ ██╔══██╗██║██║   ██║██╔══██╗'));
  console.log(c.brand('  ██║     ██║  ██║██║╚██████╔╝██║  ██║'));
  console.log(c.brand('  ╚═╝     ╚═╝  ╚═╝╚═╝ ╚═════╝ ╚═╝  ╚═╝'));
  console.log('');
  console.log(c.muted(`  v${version}  ·  priornetwork.com`));
  console.log('');
}

// ── Time helpers ───────────────────────────────────────────────
function timeNow() {
  return new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}
function elapsed(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

// ── Tool call display ──────────────────────────────────────────
const TOOL_ICONS = {
  file_read:       '📄',
  file_write:      '✏️ ',
  file_append:     '📝',
  file_list:       '📁',
  file_delete:     '🗑 ',
  web_search:      '🔍',
  url_fetch:       '🌐',
  run_command:     '⚡',
  clipboard_read:  '📋',
  clipboard_write: '📋',
  generate_image:  '🎨',
  prior_feed:      '📰',
  prior_profile:   '👤',
};

function toolIcon(name) {
  return TOOL_ICONS[name] || '⎔ ';
}

let _toolStartTime = 0;

// ── Box drawing helpers ────────────────────────────────────────
function boxLine(text, width, color) {
  const col = process.stdout.columns || 90;
  const w   = Math.min(width || 56, col - 8);
  const pad = Math.max(0, w - text.length);
  return '  │  ' + (color ? color(text) : text) + ' '.repeat(pad) + '  │';
}

function drawBox(lines, opts = {}) {
  const col  = process.stdout.columns || 90;
  const w    = Math.min(opts.width || 56, col - 8);
  const top  = '  ╭' + '─'.repeat(w + 4) + '╮';
  const bot  = '  ╰' + '─'.repeat(w + 4) + '╯';
  process.stdout.write(c.muted(top) + '\n');
  for (const { text, color, dim } of lines) {
    const str   = String(text || '').slice(0, w);
    const pad   = ' '.repeat(Math.max(0, w - str.length));
    const styled = color ? color(str) : dim ? c.dim(str) : c.white(str);
    process.stdout.write(c.muted('  │  ') + styled + pad + c.muted('  │') + '\n');
  }
  process.stdout.write(c.muted(bot) + '\n');
}

// ── Per-tool rich preview ─────────────────────────────────────
function renderToolStart(name, args) {
  _toolStartTime = Date.now();
  const icon = toolIcon(name);

  switch (name) {

    case 'run_command': {
      const cmd = args.command || '';
      process.stdout.write(`\n  ${icon}  ${c.bold('run_command')}\n`);
      drawBox([{ text: cmd, color: c.brand }]);
      break;
    }

    case 'file_write': {
      const filePath = args.path || '';
      const content  = args.content || '';
      const lines    = content.split('\n');
      const preview  = lines.slice(0, 5);
      const more     = lines.length > 5 ? lines.length - 5 : 0;
      process.stdout.write(`\n  ${icon}  ${c.bold('file_write')}  ${c.muted('→')}  ${c.brand(filePath)}  ${c.muted(`${lines.length} line${lines.length !== 1 ? 's' : ''}`)}\n`);
      drawBox([
        ...preview.map(l => ({ text: l, dim: true })),
        ...(more > 0 ? [{ text: `… ${more} more line${more !== 1 ? 's' : ''}`, dim: true }] : []),
      ]);
      break;
    }

    case 'file_append': {
      const filePath = args.path || '';
      const content  = args.content || '';
      const lines    = content.split('\n');
      process.stdout.write(`\n  ${icon}  ${c.bold('file_append')}  ${c.muted('→')}  ${c.brand(filePath)}  ${c.muted(`+${lines.length} line${lines.length !== 1 ? 's' : ''}`)}\n`);
      drawBox(lines.slice(0, 4).map(l => ({ text: l, dim: true })));
      break;
    }

    case 'file_delete': {
      const filePath = args.path || '';
      process.stdout.write(`\n  ${icon}  ${c.bold('file_delete')}\n`);
      drawBox([{ text: filePath, color: chalk.red }]);
      break;
    }

    case 'file_read': {
      const filePath = args.path || '';
      process.stdout.write(`\n  ${icon}  ${c.bold('file_read')}  ${c.muted(filePath)}\n`);
      break;
    }

    case 'file_list': {
      const dirPath = args.path || '.';
      process.stdout.write(`\n  ${icon}  ${c.bold('file_list')}  ${c.muted(dirPath)}\n`);
      break;
    }

    case 'web_search': {
      const query = args.query || '';
      process.stdout.write(`\n  ${icon}  ${c.bold('web_search')}\n`);
      drawBox([{ text: query, color: c.brand }]);
      break;
    }

    case 'url_fetch': {
      const url = args.url || '';
      process.stdout.write(`\n  ${icon}  ${c.bold('url_fetch')}  ${c.muted(url.slice(0, 70))}\n`);
      break;
    }

    case 'generate_image': {
      const prompt = args.prompt || '';
      process.stdout.write(`\n  ${icon}  ${c.bold('generate_image')}\n`);
      drawBox([{ text: prompt, color: c.brand }]);
      process.stdout.write(c.muted('  This may take 1–3 minutes…\n'));
      break;
    }

    case 'clipboard_read':
      process.stdout.write(`\n  ${icon}  ${c.bold('clipboard_read')}\n`);
      break;

    case 'clipboard_write': {
      const text = String(args.text || '').slice(0, 60);
      process.stdout.write(`\n  ${icon}  ${c.bold('clipboard_write')}  ${c.muted(text)}\n`);
      break;
    }

    case 'prior_feed':
      process.stdout.write(`\n  ${icon}  ${c.bold('prior_feed')}  ${c.muted('fetching…')}\n`);
      break;

    case 'prior_profile':
      process.stdout.write(`\n  ${icon}  ${c.bold('prior_profile')}  ${c.muted('fetching…')}\n`);
      break;

    default: {
      const preview = Object.values(args || {})[0];
      const hint    = preview ? c.muted(String(preview).slice(0, 80)) : '';
      process.stdout.write(`\n  ${icon}  ${c.bold(name.padEnd(16))} ${hint}\n`);
    }
  }
}

function hyperlink(text, url) {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

const PREVIEW_TOOLS = new Set(['file_read', 'run_command', 'web_search', 'url_fetch']);

// ── Weather condition code → emoji ────────────────────────────
function weatherIcon(code) {
  if (code === 113)                          return '☀️ ';
  if (code === 116)                          return '⛅ ';
  if (code === 119 || code === 122)          return '☁️ ';
  if (code === 143 || code === 248 || code === 260) return '🌫️';
  if (code >= 176 && code <= 182)            return '🌦️';
  if (code >= 185 && code <= 227)            return '🌨️';
  if (code === 230)                          return '❄️ ';
  if (code >= 248 && code <= 260)            return '🌫️';
  if (code >= 263 && code <= 296)            return '🌧️';
  if (code >= 299 && code <= 314)            return '🌧️';
  if (code >= 317 && code <= 338)            return '🌨️';
  if (code >= 350 && code <= 395)            return '⛈️ ';
  return '🌡️';
}

function dayLabel(dateStr) {
  if (!dateStr) return '   ';
  const d = new Date(dateStr);
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
}

function renderWeatherCard(w) {
  // Use left-border-only style — avoids emoji column-width alignment issues
  const L  = '  │  ';
  const hr = '  ├─────────────────────────────────────\n';

  process.stdout.write(c.muted('  ┌─────────────────────────────────────\n'));
  process.stdout.write(c.muted(L) + c.bold(`📍 ${w.city}${w.country ? ', ' + w.country : ''}`) + '\n');
  process.stdout.write(c.muted(L) + '\n');
  process.stdout.write(c.muted(L) + `${weatherIcon(w.code)}  ${w.desc}` + '\n');
  process.stdout.write(c.muted(L) + `🌡  ${c.bold(w.tempC + '°C')}  ${c.dim('feels like ' + w.feelsC + '°C')}` + '\n');
  process.stdout.write(c.muted(L) + c.dim(`💧 ${w.humidity}%   💨 ${w.windKmph} km/h`) + '\n');

  if (w.forecast && w.forecast.length) {
    process.stdout.write(c.muted(hr));
    for (const f of w.forecast) {
      const day  = dayLabel(f.date).padEnd(4);
      const icon = weatherIcon(f.code);
      const tmp  = `${f.maxC}° / ${f.minC}°`;
      process.stdout.write(c.muted(L) + c.dim(day) + `  ${icon}  ` + c.dim(tmp) + '\n');
    }
  }

  process.stdout.write(c.muted('  └─────────────────────────────────────\n'));
}

function renderToolDone(name, summary, preview, weatherData) {
  const took  = _toolStartTime ? c.dim(` · ${elapsed(Date.now() - _toolStartTime)}`) : '';
  let display = summary || '';
  if (/^[a-zA-Z]:[/\\]/.test(display) || display.startsWith('/')) {
    const fileUrl = 'file:///' + display.replace(/\\/g, '/');
    display = hyperlink(c.dim(display), fileUrl);
  } else {
    display = c.dim(display);
  }
  process.stdout.write(`  ${c.ok('✓')}  ${c.muted(name)}  ${display}${took}\n`);

  // Weather card
  if (name === 'get_weather' && weatherData) {
    renderWeatherCard(weatherData);
    return;
  }

  // Rich preview for certain tools
  if (preview && PREVIEW_TOOLS.has(name)) {
    const lines   = String(preview).split('\n').filter(l => l.trim());
    const toShow  = lines.slice(0, 5);
    const more    = lines.length - toShow.length;
    if (toShow.length > 0) {
      drawBox([
        ...toShow.map(l => ({ text: l.replace(/\r/g, '').slice(0, 80), dim: true })),
        ...(more > 0 ? [{ text: `… ${more} more line${more !== 1 ? 's' : ''}`, dim: true }] : []),
      ]);
    }
  }
}

function renderToolError(name, error) {
  const took = _toolStartTime ? c.dim(` · ${elapsed(Date.now() - _toolStartTime)}`) : '';
  process.stdout.write(`  ${c.err('✗')}  ${c.muted(name)}  ${c.err(error || 'failed')}${took}\n`);
}

function renderToolSkip(name) {
  process.stdout.write(`  ${c.warn('⊘')}  ${c.muted(name)}  ${c.dim('skipped')}\n`);
}

// ── Confirm prompt (Enter-based, no raw mode) ─────────────────
function askConfirmKey(promptText, rl) {
  return new Promise(resolve => {
    if (!process.stdout.isTTY || !process.stdin.isTTY || !rl) {
      process.stdout.write(`  ${c.muted('┤')} ${promptText} ${c.muted('[Y/n]')}  ${c.ok('y')}\n\n`);
      return resolve(true);
    }

    rl.question(`  ${c.muted('┤')} ${promptText} ${c.muted('[Y/n]')}  `, ans => {
      const key = (ans || '').trim().toLowerCase();
      if (key === 'n' || key === 'no') {
        process.stdout.write('\n');
        resolve(false);
      } else {
        process.stdout.write('\n');
        resolve(true);
      }
    });
  });
}

// ── Browser login via public URL ───────────────────────────────
async function loginViaBrowser() {
  const open   = require('open');
  const crypto = require('crypto');

  // Generate a random state token to match the browser session to this CLI wait
  const state = crypto.randomBytes(16).toString('hex');
  const url   = `https://priornetwork.com/cli-auth?state=${state}`;

  await open(url).catch(() => {
    process.stdout.write('\n');
    console.log(c.muted(`  Open in browser: ${url}\n`));
  });

  // Long-poll the CLI backend until browser completes login (3 min timeout handled server-side)
  const fetch = require('node-fetch');
  const res = await fetch(`https://priornetwork.com/cli-backend/wait?state=${state}`, {
    timeout: 185000,
  });

  if (!res.ok) throw new Error('Login timed out or was cancelled');
  const data = await res.json();
  if (!data.token) throw new Error('No token received');
  return { token: data.token, username: data.username };
}

// ── Inline login flow ──────────────────────────────────────────
async function doLoginFlow() {
  process.stdout.write(c.dim('  Opening browser…'));
  try {
    const { token, username } = await loginViaBrowser();
    saveAuth(token, username);
    clearLine();
    console.log(c.ok('  ✓ Logged in as ') + c.bold(username));
    console.log('');
    return username;
  } catch (err) {
    clearLine();
    throw err;
  }
}

// ── Organization ToS flow ──────────────────────────────────────
const ORG_TOS = `
  PRIOR NETWORK — ORGANIZATION ACCOUNT TERMS OF SERVICE
  ══════════════════════════════════════════════════════

  By accepting, you agree to the following:

  1. USAGE LIMITS
     Organization accounts receive up to 500,000 tokens per day.
     Abuse, automated scraping, or intentional limit exhaustion
     may result in immediate account suspension.

  2. ACCEPTABLE USE
     You may use Prior AI for legitimate business, research, and
     productivity purposes. You may not use it to generate harmful,
     illegal, or malicious content.

  3. DATA & PRIVACY
     Conversations may be logged for safety and abuse monitoring.
     Do not share confidential credentials or personal data.

  4. ACCOUNTABILITY
     Organization account holders are responsible for all activity
     on their account. Sharing credentials with unauthorized users
     is prohibited.

  5. TERMINATION
     Prior Network reserves the right to revoke organization access
     at any time for violations of these terms.

  These terms are legally binding upon acceptance.
`;

async function checkOrgTos(rl) {
  const token = getToken();
  if (!token) return;
  const payload = decodeToken(token);
  if (payload.role !== 'organization') return;
  if (payload.tos_accepted) return;

  console.clear();
  banner();
  console.log(DIVIDER);
  console.log(c.bold('  Organization Account — Terms of Service'));
  console.log(DIVIDER);
  console.log(c.muted(ORG_TOS));
  console.log(DIVIDER);
  console.log(c.warn('  You must accept these terms to use your Organization account.'));
  console.log('');

  const accepted = await askConfirmKey('I accept the Terms of Service', rl);
  if (!accepted) {
    console.log('');
    console.log(c.err('  Terms not accepted. Exiting.'));
    console.log('');
    process.exit(0);
  }

  process.stdout.write(c.dim('  Saving acceptance…'));
  try {
    const result = await api.acceptTos();
    if (result.token) saveAuth(result.token, getUsername());
    clearLine();
    console.log(c.ok('  ✓ Terms accepted. Welcome to Prior Organization.'));
    console.log('');
  } catch (err) {
    clearLine();
    console.log(c.err(`  ✗ Could not save acceptance: ${err.message}`));
    console.log('');
  }
}

// ── Interactive Chat ───────────────────────────────────────────
async function startChat(opts = {}) {
  // If not logged in, prompt inline instead of erroring out
  if (!getToken()) {
    banner();
    try {
      await doLoginFlow();
    } catch (err) {
      clearLine();
      console.error(c.err(`  ✗ ${err.message}`));
      process.exit(1);
    }
  }

  const user = getUsername();
  const payload = decodeToken(getToken() || '');
  const isOrg = payload.role === 'organization';

  // ── Readline needed early for ToS prompt ─────────────────────
  const rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: true,
    historySize: 100,
    completer: line => {
      const cmds = ['/help', '/clear', '/censored', '/uncensored', '/login', '/logout', '/exit'];
      if (!line.startsWith('/')) return [[], line];
      const hits = cmds.filter(cmd => cmd.startsWith(line));
      return [hits, line];
    },
  });

  // ToS check for org accounts (before showing the chat UI)
  await checkOrgTos(rl);

  console.clear();
  banner();
  console.log(DIVIDER);

  // Header row
  const modelLabel = opts.model || 'default';
  const cwdShort   = process.cwd().replace(os.homedir(), '~');
  const accountBadge = isOrg
    ? c.brand('  ◈ Organization Account')
    : c.muted('  ◈ Standard Account');
  console.log(
    c.brand('  Prior AI') +
    c.muted('  ·  ') +
    c.bold(`@${user}`) +
    c.muted(`  ·  ${modelLabel}`)
  );
  console.log(accountBadge);
  console.log(c.muted(`  ${cwdShort}`));
  console.log(c.ok('  ◉') + c.muted('  Agent mode  ') + c.dim('· read  edit  search  web  shell  image  ·  @file to attach'));

  console.log(DIVIDER);
  console.log(c.muted('  /help  /clear  /update  /compact  /timer  /save  /load  /saves  /delete  /exit'));
  console.log(DIVIDER);
  console.log('');

  // Conversation history (for agent mode, keeps full multi-turn context)
  const chatHistory = [];
  let currentModel            = opts.model || null;
  let _currentAbortController = null;
  let _pendingImages          = [];   // set by alt+v clipboard paste (supports multiple)

  // ── Live slash-command suggestions ──────────────────────────
  let clearSuggestions = () => {};

  if (process.stdout.isTTY) {
    readline.emitKeypressEvents(process.stdin, rl);

    const SLASH_CMDS = [
      { cmd: '/update',      desc: 'Check for updates and install if available' },
      { cmd: '/compact',     desc: 'Compact conversation to save context' },
      { cmd: '/timer',       desc: 'Set a countdown timer  e.g. /timer 30s' },
      { cmd: '/saves',       desc: 'List all saved conversations'            },
      { cmd: '/save',        desc: 'Save current conversation  e.g. /save my session' },
      { cmd: '/load',        desc: 'Load a saved conversation'               },
      { cmd: '/delete',      desc: 'Delete a saved conversation'             },
      { cmd: '/help',        desc: 'Show help'         },
      { cmd: '/clear',       desc: 'Clear screen'      },
      { cmd: '/censored',    desc: 'Load Prior Standard model'   },
      { cmd: '/uncensored',  desc: 'Load Prior Uncensored model' },
      { cmd: '/usage',       desc: 'Token usage today'          },
      { cmd: '/learn',       desc: 'Learn this directory → prior.md' },
      { cmd: '/login',       desc: 'Sign in'           },
      { cmd: '/logout',      desc: 'Sign out'          },
      { cmd: '/exit',        desc: 'Exit'              },
    ];

    // Unified sub-row tracker — covers image indicator + slash suggestions
    let _subRowCount = 0;
    let _suggTimer   = null;

    // Clear all rows rendered below the input line
    function clearAllSubRows() {
      if (!_subRowCount) return;
      process.stdout.write('\x1b[s');
      for (let i = 0; i < _subRowCount; i++) process.stdout.write('\x1b[B\r\x1b[2K');
      process.stdout.write('\x1b[u');
      _subRowCount = 0;
    }

    // Alias used by the loop's rl.question callback
    clearSuggestions = clearAllSubRows;

    // Redraw image indicator + slash suggestions — always called together so
    // they share the same row-count and never stomp on each other.
    function renderSubRows(line) {
      clearAllSubRows();
      process.stdout.write('\x1b[s');
      let rows = 0;

      // Image indicator — always first, persists across backspace/typing
      if (_pendingImages.length > 0) {
        const tags = _pendingImages.map((_, i) => c.brand(`[Image ${i + 1}]`)).join(' ');
        const hint = _pendingImages.length > 0
          ? c.dim('  ·  alt+v to add more  ·  alt+v (empty clipboard) to remove last')
          : '';
        process.stdout.write(`\x1b[B\r\x1b[2K  ${c.brand('◈')}  ${tags}${hint}`);
        rows++;
      }

      // Slash-command suggestions
      if ((line || '').startsWith('/')) {
        const word    = line.split(' ')[0];
        const matches = SLASH_CMDS.filter(({ cmd }) => cmd.startsWith(word));
        for (const { cmd, desc } of matches) {
          process.stdout.write(`\x1b[B\r\x1b[2K${c.brand('  ' + cmd.padEnd(14))}${c.dim(desc)}`);
          rows++;
        }
      }

      process.stdout.write('\x1b[u');
      _subRowCount = rows;
    }

    // Show a one-off message below the input (cleared on next keypress)
    function flashSubRow(msg) {
      clearAllSubRows();
      process.stdout.write('\x1b[s');
      process.stdout.write(`\x1b[B\r\x1b[2K  ${msg}`);
      process.stdout.write('\x1b[u');
      _subRowCount = 1;
    }

    process.stdin.on('keypress', (ch, key) => {
      if (!key) return;

      if (_suggTimer) { clearTimeout(_suggTimer); _suggTimer = null; }

      if (key.name === 'escape' && _currentAbortController) {
        _currentAbortController.abort();
        return;
      }

      // Alt+V — add image from clipboard, or remove last if clipboard is empty
      if (key.meta && key.name === 'v') {
        try {
          const ps = `Add-Type -AssemblyName System.Windows.Forms; $img = [System.Windows.Forms.Clipboard]::GetImage(); if ($img) { $ms = New-Object System.IO.MemoryStream; $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($ms.ToArray()) } else { '' }`;
          const b64 = execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 5000 }).toString().trim();
          if (b64) {
            _pendingImages.push(b64);
            renderSubRows(rl.line || '');
          } else if (_pendingImages.length > 0) {
            _pendingImages.pop();
            renderSubRows(rl.line || '');
          } else {
            flashSubRow(c.muted('✗  No image found in clipboard'));
          }
        } catch {
          flashSubRow(c.muted('✗  Could not read clipboard'));
        }
        return;
      }

      if (key.name === 'return' || key.name === 'enter' || (key.ctrl && key.name === 'c')) {
        clearAllSubRows();
        return;
      }

      // Redraw sub-rows on every keypress so backspace / typing never wipes them
      _suggTimer = setTimeout(() => {
        _suggTimer = null;
        renderSubRows(rl.line || '');
      }, 50);
    });
  }

  // ── Load prior.md if present ────────────────────────────────
  const priorMdPath = path.join(process.cwd(), 'prior.md');
  let projectContext = null;
  try {
    projectContext = fs.readFileSync(priorMdPath, 'utf8');
    console.log(c.brand('  ◈') + c.muted('  prior.md loaded — project context active'));
    console.log('');
  } catch { /* no prior.md, fine */ }

  let restarting   = false;
  let msgCount     = 0;
  const sessionStart = Date.now();

  rl.on('close', () => {
    if (restarting) return;
    const dur = elapsed(Date.now() - sessionStart);
    console.log('');
    console.log(c.muted(`  ─────────────────────────────────────────────────`));
    console.log(c.muted(`  Session ended  ·  ${msgCount} message${msgCount !== 1 ? 's' : ''}  ·  ${dur}`));
    console.log('');
    process.exit(0);
  });

  const PROMPT    = () => c.brand('  ❯ ');
  const ML_PROMPT = () => c.brand('  … ');

  let _mlBuf = []; // multiline accumulation (\ continuation)

  const loop = () => {
    const isML = _mlBuf.length > 0;
    rl.question(isML ? ML_PROMPT() : PROMPT(), async raw => {
      clearSuggestions();

      // Backslash continuation — collect lines until one doesn't end with \
      if (raw.endsWith('\\')) {
        _mlBuf.push(raw.slice(0, -1));
        return loop();
      }
      _mlBuf.push(raw);
      const input = _mlBuf.join('\n').trim();
      _mlBuf = [];

      if (!input) return loop();

      // ── Slash commands ──────────────────────────────────────
      if (input.startsWith('/')) {
        const [cmd, ...args] = input.split(' ');
        switch (cmd) {

          case '/exit':
          case '/quit':
            return rl.close();

          case '/login': {
            restarting = true;
            rl.close();
            console.log('');
            try {
              await doLoginFlow();
            } catch (err) {
              clearLine();
              console.error(c.err(`  ✗ ${err.message}\n`));
            }
            return startChat({ model: currentModel });
          }

          case '/logout':
            clearAuth();
            console.log(c.ok('  ✓ Logged out.\n'));
            return loop();

          case '/saves': {
            const saves = listSaves(user);
            if (saves.length === 0) {
              console.log(c.muted('\n  No saved conversations yet. Use /save <name> to save one.\n'));
            } else {
              console.log('');
              console.log(c.bold(`  Saved conversations`) + c.muted(`  (${saves.length})`));
              console.log(DIVIDER);
              saves.forEach((s, i) => {
                const num  = c.muted(`  ${String(i + 1).padStart(2)}.  `);
                const name = c.white(s.name.padEnd(30));
                const meta = c.muted(`${s.msgCount} msgs · ${new Date(s.savedAt).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}`);
                console.log(num + name + meta);
              });
              console.log(DIVIDER);
              console.log(c.muted('  /load <name|#>  ·  /delete <name|#>\n'));
            }
            return loop();
          }

          case '/delete': {
            const saves = listSaves(user);
            if (saves.length === 0) {
              console.log(c.muted('\n  No saved conversations to delete.\n'));
              return loop();
            }

            let target = null;
            const query = args.join(' ').trim();

            if (query) {
              const num = parseInt(query, 10);
              if (!isNaN(num) && num >= 1 && num <= saves.length) {
                target = saves[num - 1];
              } else {
                const q = query.toLowerCase();
                target = saves.find(s => sanitizeName(s.name) === sanitizeName(query))
                      || saves.find(s => s.name.toLowerCase().includes(q));
              }
              if (!target) {
                console.log(c.err(`  No save found matching "${query}"\n`));
                return loop();
              }
            } else {
              // Show list and ask
              console.log('');
              console.log(c.bold('  Delete a conversation:'));
              console.log(DIVIDER);
              saves.forEach((s, i) => {
                const num  = c.brand(`  ${String(i + 1).padStart(2)}.  `);
                const name = c.white(s.name.padEnd(28));
                const meta = c.muted(`${s.msgCount} msgs · ${new Date(s.savedAt).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}`);
                console.log(num + name + meta);
              });
              console.log(DIVIDER);
              const answer = await new Promise(res => rl.question(c.muted('  Enter number or name (Enter to cancel): '), res));
              const trimmed = (answer || '').trim();
              if (!trimmed) {
                console.log(c.muted('  Cancelled.\n'));
                return loop();
              }
              const n = parseInt(trimmed, 10);
              if (!isNaN(n) && n >= 1 && n <= saves.length) {
                target = saves[n - 1];
              } else {
                const q = trimmed.toLowerCase();
                target = saves.find(s => sanitizeName(s.name) === sanitizeName(trimmed))
                      || saves.find(s => s.name.toLowerCase().includes(q));
              }
              if (!target) {
                console.log(c.err(`  No save found matching "${trimmed}"\n`));
                return loop();
              }
            }

            // Confirm
            const confirm = await new Promise(res => rl.question(c.warn(`  Delete "${target.name}"? [y/N] `), res));
            if ((confirm || '').trim().toLowerCase() !== 'y') {
              console.log(c.muted('  Cancelled.\n'));
              return loop();
            }

            try {
              const filePath = path.join(savesDir(user), sanitizeName(target.name) + '.json');
              fs.unlinkSync(filePath);
              console.log(c.ok(`  ✓  Deleted "${target.name}"\n`));
            } catch (err) {
              console.log(c.err(`  Failed to delete: ${err.message}\n`));
            }
            return loop();
          }

          case '/save': {
            const saveName = args.join(' ').trim();
            if (!saveName) {
              console.log(c.err('  Usage: /save <name>   e.g. /save debugging session\n'));
              return loop();
            }
            if (chatHistory.length === 0) {
              console.log(c.muted('  Nothing to save yet — start a conversation first.\n'));
              return loop();
            }
            try {
              writeSession(user, saveName, chatHistory, currentModel);
              const savedPath = path.join(savesDir(user), sanitizeName(saveName) + '.json');
              console.log(c.ok(`  ✓  Saved "${saveName}"`) + c.muted(` · ${chatHistory.length} messages`));
              console.log(c.muted(`     ${savedPath}\n`));
            } catch (err) {
              console.log(c.err(`  Failed to save: ${err.message}\n`));
            }
            return loop();
          }

          case '/load': {
            const saves = listSaves(user);
            if (saves.length === 0) {
              console.log(c.muted('\n  No saved conversations yet. Use /save <name> to create one.\n'));
              return loop();
            }

            let chosen = null;
            const query = args.join(' ').trim();

            if (query) {
              // Match by number or name
              const num = parseInt(query, 10);
              if (!isNaN(num) && num >= 1 && num <= saves.length) {
                chosen = saves[num - 1];
              } else {
                const q = query.toLowerCase();
                chosen = saves.find(s => sanitizeName(s.name) === sanitizeName(query))
                      || saves.find(s => s.name.toLowerCase().includes(q));
              }
              if (!chosen) {
                console.log(c.err(`  No save found matching "${query}"\n`));
                return loop();
              }
            } else {
              // Numbered list prompt — reliable across all terminals
              console.log('');
              console.log(c.bold('  Load a conversation:'));
              console.log(DIVIDER);
              saves.forEach((s, i) => {
                const num  = c.brand(`  ${String(i + 1).padStart(2)}.  `);
                const name = c.white(s.name.padEnd(28));
                const meta = c.muted(`${s.msgCount} msgs · ${new Date(s.savedAt).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' })}`);
                console.log(num + name + meta);
              });
              console.log(DIVIDER);

              const answer = await new Promise(res => rl.question(c.muted('  Enter number or name (Esc to cancel): '), res));
              const trimmed = (answer || '').trim();
              if (!trimmed) {
                console.log(c.muted('  Cancelled.\n'));
                return loop();
              }
              const n = parseInt(trimmed, 10);
              if (!isNaN(n) && n >= 1 && n <= saves.length) {
                chosen = saves[n - 1];
              } else {
                const q = trimmed.toLowerCase();
                chosen = saves.find(s => sanitizeName(s.name) === sanitizeName(trimmed))
                      || saves.find(s => s.name.toLowerCase().includes(q));
              }
              if (!chosen) {
                console.log(c.err(`  No save found matching "${trimmed}"\n`));
                return loop();
              }
            }

            // Load it
            const session = readSession(user, chosen.name);
            if (!session) {
              console.log(c.err(`  Could not read save file for "${chosen.name}"\n`));
              return loop();
            }
            chatHistory.length = 0;
            for (const msg of session.messages) chatHistory.push(msg);
            if (session.model) currentModel = session.model;
            console.log('');
            console.log(c.ok(`  ✓  Loaded "${chosen.name}"`) + c.muted(` · ${chatHistory.length} messages · model: ${currentModel}`));
            console.log(c.muted(`  Saved ${new Date(chosen.savedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}\n`));
            return loop();
          }

          case '/clear':
            console.clear();
            banner();
            console.log(DIVIDER);
            console.log(c.brand('  Prior AI') + c.muted('  ·  ') + c.muted(`@${user}`));
            console.log(c.ok('  ◉') + c.muted('  Agent mode  ') + c.dim('· read  edit  search  web  shell  image  ·  @file to attach'));
            console.log(DIVIDER);
            console.log('');
            return loop();


          case '/censored':
            currentModel = 'qwen3.5:4b';
            console.log(c.ok('  ✓  Prior Standard Model Loaded\n'));
            return loop();

          case '/uncensored':
            currentModel = 'dolphin-uncensored:latest';
            console.log(c.warn('  ✓  Prior Uncensored Model Loaded\n'));
            return loop();

          case '/learn': {
            // Sanity check — warn if not a project directory
            const cwdBase = path.basename(process.cwd()).toLowerCase();
            const NON_PROJECT = ['downloads', 'desktop', 'documents', 'pictures', 'videos', 'music', 'temp', 'tmp'];
            if (NON_PROJECT.includes(cwdBase)) {
              console.log('');
              console.log(c.warn(`  ⚠  You're in "${path.basename(process.cwd())}" — this doesn't look like a project directory.`));
              console.log(c.muted('     cd into your project folder first, then run /learn.'));
              console.log('');
              return loop();
            }

            console.log('');
            await runLearnAnimation(process.cwd());
            console.log('');

            // ── Build flat file list ──────────────────────────
            const flatFiles = [];
            function collectFiles(dir, depth = 0) {
              if (depth > 4) return;
              const SKIP = new Set(['node_modules','.git','__pycache__','.next','dist','build','.venv','venv','.cache']);
              try {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                  if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
                  const full = path.join(dir, e.name);
                  const rel  = path.relative(process.cwd(), full).replace(/\\/g, '/');
                  if (e.isDirectory()) collectFiles(full, depth + 1);
                  else flatFiles.push(rel);
                }
              } catch {}
            }
            collectFiles(process.cwd());

            // ── Read key files locally (no agent tool calls needed) ──
            const KEY_NAMES = ['package.json','README.md','readme.md','README.txt',
                               'server.js','Server.js','app.js','App.js','index.js',
                               'main.js','main.py','app.py','index.ts','main.ts',
                               'pyproject.toml','requirements.txt','Cargo.toml','go.mod'];

            const readSnippets = [];
            const MAX_READ = 6;
            const MAX_BYTES = 2000;

            // First pass: exact key name matches at root or one level deep
            const keyMatches = flatFiles.filter(f => {
              const base = path.basename(f);
              return KEY_NAMES.includes(base);
            }).slice(0, MAX_READ);

            for (const rel of keyMatches) {
              try {
                const full    = path.join(process.cwd(), rel);
                const content = fs.readFileSync(full, 'utf8').slice(0, MAX_BYTES);
                readSnippets.push(`### ${rel}\n\`\`\`\n${content}\n\`\`\``);
              } catch {}
            }

            const fileList = flatFiles.slice(0, 120).join('\n');

            const learnPrompt = `You are analyzing a project directory. Based on the file list and file contents below, write a prior.md file that documents this project.

## File list
${fileList}${flatFiles.length > 120 ? `\n… (${flatFiles.length - 120} more files)` : ''}

## Key file contents
${readSnippets.length ? readSnippets.join('\n\n') : '(no key files found)'}

## Instructions
Write prior.md immediately using the <write path="prior.md"> tag. Include:
- Project name and purpose (1-2 sentences)
- Tech stack (languages, frameworks, key libraries)
- Key files and what they do
- Any important conventions or notes

Keep it under 350 words. Write prior.md now.`;

            let learnTextBuffer = '';

            try {
              await runAgent({
                messages:       [{ role: 'user', content: learnPrompt }],
                model:          currentModel,

                cwd:            process.cwd(),
                projectContext: null,
                send: ev => {
                  switch (ev.type) {
                    case 'thinking':   spinStart('writing…'); break;
                    case 'tool_start':
                      spinStop();
                      renderToolStart(ev.name, ev.args);
                      spinStart('working…');
                      break;
                    case 'tool_done':  spinStop(); renderToolDone(ev.name, ev.summary, ev.preview, ev.weather); break;
                    case 'tool_error': spinStop(); renderToolError(ev.name, ev.error); break;
                    case 'text':
                      spinStop();
                      learnTextBuffer += (ev.content || '');
                      break;
                    case 'done': spinStop(); break;
                    case 'retry': spinStop(); process.stdout.write(c.warn(`  ↻  retrying… (${ev.attempt}/${ev.max})\n`)); spinStart('reconnecting…'); break;
                    case 'error': spinStop(); console.error(c.err(`  ✗ ${ev.message}`)); break;
                  }
                },
              });

              // Text fallback: if model returned markdown content but didn't use write tag
              if (!fs.existsSync(priorMdPath) && learnTextBuffer.length > 80) {
                try { fs.writeFileSync(priorMdPath, learnTextBuffer, 'utf8'); } catch {}
              }

              // Reload prior.md into context
              try {
                projectContext = fs.readFileSync(priorMdPath, 'utf8');
                console.log(c.ok('  ✓') + c.muted('  prior.md written — context active for this session'));
              } catch {
                console.log(c.warn('  ⚠  prior.md was not created'));
              }
            } catch (err) {
              spinStop();
              console.error(c.err(`  ✗ ${err.message}`));
            }
            console.log('');
            return loop();
          }

          case '/usage': {
            try {
              const data  = await api.getUsage();
              const used  = data.used ?? data.tokens_used ?? data.tokensUsed ?? data.totalTokens ?? 0;
              const limit = data.limit ?? data.token_limit ?? data.dailyLimit ?? null;
              const pct   = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
              const role  = data.role || decodeToken(getToken() || '').role || 'user';
              const acctLabel = role === 'organization' ? c.brand('  Organization Account') : c.muted('  Standard Account');
              console.log('');
              console.log(acctLabel);
              if (pct !== null) {
                console.log(`  ${progressBar(pct)}`);
                console.log(`  ${c.bold(used.toLocaleString())} ${c.muted('/')} ${limit.toLocaleString()} tokens  ${c.muted(`(${pct}%)`)}`);
              } else {
                console.log(`  ${c.bold(used.toLocaleString())} tokens used today`);
              }
              console.log('');
            } catch (err) {
              console.error(c.err(`  ✗ ${err.message}\n`));
            }
            return loop();
          }

          case '/update': {
            console.log('');
            process.stdout.write(c.dim('  Checking for updates…'));
            const _fetch = require('node-fetch');
            let _latest;
            try {
              const _res  = await _fetch('https://registry.npmjs.org/prior-cli/latest', { timeout: 8000 });
              if (!_res.ok) throw new Error(`HTTP ${_res.status}`);
              _latest = (await _res.json()).version;
            } catch (err) {
              process.stdout.clearLine(0); process.stdout.cursorTo(0);
              console.log(c.err(`  ✗ Could not reach npm registry: ${err.message}\n`));
              return loop();
            }
            process.stdout.clearLine(0); process.stdout.cursorTo(0);
            if (_latest === version) {
              console.log(c.ok('  ✓ Already up to date  ') + c.muted(`v${version}\n`));
              return loop();
            }
            console.log(`  ${c.muted('Current :')} ${c.white(`v${version}`)}`);
            console.log(`  ${c.muted('Latest  :')} ${c.bold(`v${_latest}`)}`);
            console.log('');
            process.stdout.write(c.dim('  Installing update…'));
            try {
              require('child_process').execSync('npm install -g prior-cli@latest', { stdio: 'ignore' });
              process.stdout.clearLine(0); process.stdout.cursorTo(0);
              console.log(c.ok(`  ✓ Updated to v${_latest}  `) + c.muted('restart prior to apply\n'));
            } catch (err) {
              process.stdout.clearLine(0); process.stdout.cursorTo(0);
              console.log(c.err(`  ✗ Install failed: ${err.message}`));
              console.log(c.muted('  Try manually: npm install -g prior-cli@latest\n'));
            }
            return loop();
          }

          case '/compact': {
            if (chatHistory.length === 0) {
              console.log(c.muted('  Nothing to compact yet.\n'));
              return loop();
            }
            const msgsBefore = chatHistory.length;
            const tokensBefore = chatHistory.reduce((n, m) => n + (m.content?.length || 0), 0);

            // Animation frames while waiting
            const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
            const steps = [
              'analyzing conversation…',
              'identifying key context…',
              'building summary…',
              'compressing history…',
            ];
            let fi = 0; let si = 0;
            process.stdout.write('\n');
            const animTimer = setInterval(() => {
              process.stdout.clearLine(0);
              process.stdout.cursorTo(0);
              if (fi % 8 === 0 && si < steps.length - 1) si++;
              process.stdout.write(`  ${c.brand(FRAMES[fi % FRAMES.length])}  ${c.dim(steps[si])}`);
              fi++;
            }, 100);

            try {
              const compactPrompt = [
                ...chatHistory,
                {
                  role: 'user',
                  content: `Please produce a compact summary of our conversation so far. Structure it as:

**What we were doing:** (1-2 sentences on the task/goal)
**Key decisions made:** (bullet points)
**Important context:** (facts, file paths, code details worth remembering)
**Current state:** (where things stand right now)

Be concise but thorough — this summary replaces the full history to save context.`,
                },
              ];

              const token = require('../lib/config').getToken();
              const res = await fetch('https://priornetwork.com/cli-backend/api/infer', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: compactPrompt, model: currentModel, token, cwd: process.cwd() }),
                timeout: 120000,
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const data = await res.json();
              const summary = data.content?.trim() || '';

              clearInterval(animTimer);
              process.stdout.clearLine(0);
              process.stdout.cursorTo(0);

              if (!summary) throw new Error('Empty summary returned');

              // Replace history with single compact message
              chatHistory.length = 0;
              chatHistory.push({ role: 'user', content: '[Conversation compacted]' });
              chatHistory.push({ role: 'assistant', content: summary });

              const tokensAfter = summary.length;
              const saved = Math.round((1 - tokensAfter / tokensBefore) * 100);

              process.stdout.write(`  ${c.ok('✓')}  ${c.bold('Compacted')}  ${c.dim(`${msgsBefore} messages → 1 summary  ·  ~${saved}% smaller`)}\n\n`);

              // Draw summary box
              const summaryLines = summary.split('\n');
              process.stdout.write(c.muted('  ┌─────────────────────────────────────\n'));
              for (const line of summaryLines) {
                process.stdout.write(c.muted('  │  ') + c.dim(line) + '\n');
              }
              process.stdout.write(c.muted('  └─────────────────────────────────────\n\n'));

            } catch (err) {
              clearInterval(animTimer);
              process.stdout.clearLine(0);
              process.stdout.cursorTo(0);
              console.error(c.err(`  ✗ Compact failed: ${err.message}\n`));
            }
            return loop();
          }

          case '/timer': {
            const timerArg = args.join(' ').trim();
            // Parse duration: e.g. 30, 30s, 5m, 1m30s, 1h
            const parseDuration = (str) => {
              if (!str) return null;
              let total = 0;
              const re = /(\d+(?:\.\d+)?)\s*([hms]?)/gi;
              let m, matched = false;
              while ((m = re.exec(str)) !== null) {
                const val = parseFloat(m[1]);
                const unit = (m[2] || 's').toLowerCase();
                if      (unit === 'h') total += val * 3600;
                else if (unit === 'm') total += val * 60;
                else                  total += val;
                matched = true;
              }
              return matched ? Math.round(total) : null;
            };
            const fmtCountdown = (sec) => {
              const h = Math.floor(sec / 3600);
              const m = Math.floor((sec % 3600) / 60);
              const s = sec % 60;
              if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
              return `${m > 0 ? m + ':' : ''}${m > 0 ? String(s).padStart(2,'0') : s + 's'}`;
            };
            const totalSec = parseDuration(timerArg);
            if (!totalSec || totalSec <= 0) {
              console.log(c.err('  Usage: /timer 30s  or  /timer 5m  or  /timer 1m30s\n'));
              return loop();
            }
            console.log(c.brand(`  Timer set for ${timerArg} — starting now.\n`));
            let remaining = totalSec;
            const timerInterval = setInterval(() => {
              if (process.stdout.isTTY) {
                process.stdout.clearLine(0);
                process.stdout.cursorTo(0);
              }
              if (remaining <= 0) {
                clearInterval(timerInterval);
                if (process.stdout.isTTY) {
                  process.stdout.clearLine(0);
                  process.stdout.cursorTo(0);
                }
                // Bell + done message
                process.stdout.write('\x07');
                console.log(c.bold(`  ⏰  Time's up!  (${timerArg})\n`));
                rl.prompt(true);
                return;
              }
              const bar = '█'.repeat(Math.ceil((remaining / totalSec) * 20)).padEnd(20, '░');
              process.stdout.write(`  ${c.brand('⏱')}  ${c.brand(fmtCountdown(remaining).padStart(6))}  ${c.dim(bar)}`);
              remaining--;
            }, 1000);
            return loop();
          }

          case '/help':
            console.log('');
            console.log(c.bold('  Commands'));
            console.log(c.muted('  /update              ') + 'Check for updates and install if available');
            console.log(c.muted('  /compact             ') + 'Compact conversation to save context');
            console.log(c.muted('  /timer <duration>    ') + 'Countdown timer  e.g. /timer 30s, /timer 5m');
            console.log(c.muted('  /saves               ') + 'List all saved conversations');
            console.log(c.muted('  /save <name>         ') + 'Save current conversation');
            console.log(c.muted('  /load [name|number]  ') + 'Load a saved conversation (picker if no arg)');
            console.log(c.muted('  /delete [name|number]') + 'Delete a saved conversation');
            console.log(c.muted('  /clear               ') + 'Clear screen');
            console.log(c.muted('  /censored            ') + 'Load Prior Standard model');
            console.log(c.muted('  /uncensored          ') + 'Load Prior Uncensored model');
            console.log(c.muted('  /usage               ') + 'Token usage for today');
            console.log(c.muted('  /learn               ') + 'Scan directory and write prior.md context file');
            console.log(c.muted('  /login               ') + 'Sign in to a different account');
            console.log(c.muted('  /logout              ') + 'Sign out');
            console.log(c.muted('  /exit                ') + 'Exit Prior');
            console.log(c.muted('  ↑ ↓                  ') + 'Browse message history');
            console.log('');
            console.log(c.bold('  Other commands  ') + c.muted('(run outside chat)'));
            console.log(c.muted('  prior imagine <prompt>  ') + 'Generate an image');
            console.log(c.muted('  prior models            ') + 'List AI models');
            console.log(c.muted('  prior history           ') + 'Chat history');
            console.log(c.muted('  prior usage             ') + 'Token usage');
            console.log(c.muted('  prior weather <city>    ') + 'Weather');
            console.log('');
            return loop();

          default:
            console.log(c.err(`  Unknown command: ${cmd}\n`));
            return loop();
        }
      }

      // ── Send message ────────────────────────────────────────
      msgCount++;
      console.log('');

      {
        const imagesForThisMsg = [..._pendingImages];
        _pendingImages         = [];

        if (imagesForThisMsg.length > 0) {
          const label = imagesForThisMsg.length === 1 ? '1 image' : `${imagesForThisMsg.length} images`;
          console.log(c.brand('  ◈') + c.dim(`  ${label} attached`));
        }

        // Expand any @file references into inline context
        const { message: expandedInput, attached } = expandFileRefs(input, process.cwd());
        if (attached.length) {
          console.log(c.brand('  ◈') + c.muted('  attached: ' +
            attached.map(a => `${a.ref} (${a.lines} line${a.lines !== 1 ? 's' : ''})`).join(', ')));
        }

        let responseText     = '';
        let _progressStarted = false;
        const _thinkStart    = Date.now();

        spinStart('thinking…');

        try {
          const confirm = async ({ name, args }) => {
            spinStop();
            const PROMPTS = {
              run_command:  'Run this command?',
              file_write:   'Write this file?',
              file_delete:  'Delete this file?',
            };
            const approved = await askConfirmKey(PROMPTS[name] || `Execute ${name}?`, rl);
            if (approved) spinStart('working…');
            return approved;
          };

          _currentAbortController = new AbortController();
          await runAgent({
            messages:       [...chatHistory, { role: 'user', content: injectToolHint(expandedInput) }],
            model:          currentModel,
            cwd:            process.cwd(),
            projectContext,
            images:         imagesForThisMsg,
            confirm,
            signal:         _currentAbortController.signal,
            send: ev => {
              switch (ev.type) {

                case 'thinking':
                  spinStart('thinking…');
                  break;

                case 'retry':
                  spinStop();
                  process.stdout.write(c.warn(`  ↻  retrying… (${ev.attempt}/${ev.max})\n`));
                  spinStart('reconnecting…');
                  break;

                case 'cancelled':
                  spinStop();
                  console.log(c.muted('  ✗ Cancelled'));
                  break;

                case 'tool_start':
                  spinStop();
                  _progressStarted = false;
                  renderToolStart(ev.name, ev.args);
                  if (!CONFIRM_TOOLS.has(ev.name)) spinStart('working…');
                  break;

                case 'tool_progress': {
                  if (!_progressStarted) {
                    spinStop();
                    process.stdout.write('\n');
                    _progressStarted = true;
                  } else {
                    process.stdout.clearLine(0);
                    process.stdout.cursorTo(0);
                  }
                  const pct = ev.percent || 0;
                  const bar = progressBar(pct, 20);
                  process.stdout.write(`  ${c.brand('◈')}  ${bar}  ${c.muted(`${ev.step}/${ev.total}`)}  ${c.brand(`${pct}%`)}`);
                  break;
                }

                case 'tool_done':
                  spinStop();
                  renderToolDone(ev.name, ev.summary, ev.preview, ev.weather);
                  break;

                case 'tool_skip':
                  spinStop();
                  renderToolSkip(ev.name);
                  break;

                case 'tool_error':
                  spinStop();
                  renderToolError(ev.name, ev.error);
                  break;

                case 'text': {
                  spinStop();
                  if (!ev.content) break;
                  const rendered  = renderMarkdown(ev.content);
                  const thinkTime = elapsed(Date.now() - _thinkStart);
                  console.log(c.brand('  Prior  ') + c.muted(`·  ${timeNow()}  ·  ${thinkTime}`));
                  console.log('');
                  console.log(rendered);
                  responseText += ev.content;
                  break;
                }

                case 'done': {
                  spinStop();
                  const pt = ev.promptTokens || 0;
                  const ct = ev.completionTokens || 0;
                  if (pt || ct) {
                    process.stdout.write(c.dim(`  ◦  ${pt.toLocaleString()} in  ·  ${ct.toLocaleString()} out  ·  ${(pt + ct).toLocaleString()} total\n`));
                  }
                  break;
                }

                case 'error':
                  spinStop();
                  console.error(c.err(`  ✗ ${ev.message}`));
                  break;
              }
            },
          });
        } catch (err) {
          spinStop();
          if (err.name !== 'AbortError') {
            console.error(c.err(`  ✗ ${err.message}`));
          }
        } finally {
          _currentAbortController = null;
        }

        chatHistory.push({ role: 'user', content: expandedInput });
        if (responseText) chatHistory.push({ role: 'assistant', content: responseText });

        process.stdout.write('\n');
      }

      loop();
    });
  };

  loop();
}

// ── LOGIN ──────────────────────────────────────────────────────
program
  .command('login')
  .description('Log in to your Prior Network account')
  .action(async () => {
    banner();
    console.log(c.bold('  Sign in\n'));
    const rl       = readline.createInterface({ input: process.stdin, output: process.stdout });
    const username = await ask(rl, c.muted('  Username : '));
    rl.close();
    const password = await promptPassword(c.muted('  Password : '));
    console.log('');
    process.stdout.write(c.dim('  Authenticating…'));
    try {
      const data = await api.login(username, password);
      saveAuth(data.token, username);
      clearLine();
      console.log(c.ok('  ✓ Logged in as ') + c.bold(username));
      console.log(c.muted('\n  Run "prior" to start chatting.\n'));
    } catch (err) {
      clearLine();
      console.error(c.err(`  ✗ ${err.message}`));
      process.exit(1);
    }
  });

// ── LOGOUT ─────────────────────────────────────────────────────
program
  .command('logout')
  .description('Log out and clear saved credentials')
  .action(() => {
    clearAuth();
    console.log(c.ok('  ✓ Logged out.'));
  });

// ── WHOAMI ─────────────────────────────────────────────────────
program
  .command('whoami')
  .description('Show currently logged-in user')
  .action(() => {
    const user = getUsername();
    console.log('');
    if (!user) console.log(c.muted('  Not logged in.'));
    else       console.log(`  ${c.bold(user)}`);
    console.log('');
  });

// ── CHAT ───────────────────────────────────────────────────────
program
  .command('chat', { isDefault: false })
  .description('Open Prior AI chat session (default when no command given)')
  .option('-m, --model <model>', 'Model to use')
  .action(opts => startChat(opts));

// ── RUN (one-shot / non-interactive) ───────────────────────────
program
  .command('run [prompt...]')
  .description('One-shot prompt — prints the answer and exits (scriptable, pipe-able)')
  .option('-m, --model <model>', 'Model to use')
  .option('-y, --yes',           'Auto-approve tool actions (run_command, file edits/writes)')
  .option('-q, --quiet',         'Print only the final answer (suppress tool activity)')
  .action(async (promptParts, opts) => {
    requireAuth();

    // Gather prompt from args + piped stdin
    let prompt = (promptParts || []).join(' ').trim();
    if (!process.stdin.isTTY) {
      const piped = await new Promise(res => {
        let buf = ''; process.stdin.setEncoding('utf8');
        process.stdin.on('data', d => buf += d);
        process.stdin.on('end', () => res(buf.trim()));
        setTimeout(() => res(buf.trim()), 50); // no pipe → don't hang
      });
      if (piped) prompt = prompt ? `${prompt}\n\n${piped}` : piped;
    }
    if (!prompt) { console.error(c.err('  ✗ No prompt. Usage: prior run "your question"  (or pipe via stdin)')); process.exit(1); }

    const cwd = process.cwd();
    const { message, attached } = expandFileRefs(prompt, cwd);
    if (attached.length && !opts.quiet) {
      console.error(c.muted('  ◈ attached: ' + attached.map(a => a.ref).join(', ')));
    }

    // Load prior.md if present
    let projectContext = null;
    try { projectContext = fs.readFileSync(path.join(cwd, 'prior.md'), 'utf8'); } catch {}

    let responseText = '';
    let hadError     = false;
    try {
      await runAgent({
        messages:       [{ role: 'user', content: injectToolHint(message) }],
        model:          opts.model || null,
        cwd,
        projectContext,
        confirm: async ({ name }) => {
          if (opts.yes) return true;
          console.error(c.warn(`  ⚠ Skipping ${name} — re-run with --yes to allow tool actions in one-shot mode.`));
          return false;
        },
        send: ev => {
          switch (ev.type) {
            case 'tool_start':
              if (!opts.quiet) console.error(c.dim(`  ◈ ${ev.name}`));
              break;
            case 'tool_error':
              if (!opts.quiet) console.error(c.err(`  ✗ ${ev.name}: ${ev.error}`));
              break;
            case 'text':
              if (ev.content) { process.stdout.write(ev.content); responseText += ev.content; }
              break;
            case 'error':
              hadError = true;
              console.error(c.err(`  ✗ ${ev.message}`));
              break;
          }
        },
      });
    } catch (err) {
      console.error(c.err(`  ✗ ${err.message}`));
      process.exit(1);
    }
    if (responseText && !responseText.endsWith('\n')) process.stdout.write('\n');
    process.exit(hadError ? 1 : 0);
  });

// ── IMAGINE ────────────────────────────────────────────────────
program
  .command('imagine <prompt>')
  .description('Generate an image with Prior Diffusion')
  .option('-s, --size <WxH>', 'Resolution e.g. 1024x1024', '896x896')
  .option('--steps <n>',      'Diffusion steps', '20')
  .option('--open',           'Open saved image when done')
  .action(async (prompt, opts) => {
    requireAuth();
    const fs   = require('fs');
    const [width, height] = (opts.size || '896x896').split('x').map(Number);
    const steps = parseInt(opts.steps) || 20;
    console.log('');
    console.log(c.bold('  Prior Diffusion'));
    console.log(c.muted('  Prompt : ') + c.white(`"${prompt}"`));
    console.log(c.muted(`  Size   : ${width}×${height}  ·  Steps: ${steps}`));
    console.log('');
    try {
      const { promptId } = await api.generateImage(prompt, { width, height, steps });
      if (!promptId) throw new Error('No promptId returned.');
      let done = false;
      while (!done) {
        await new Promise(r => setTimeout(r, 900));
        try {
          const p = await api.pollImageProgress(promptId);
          clearLine();
          process.stdout.write(`  ${progressBar(p.percent ?? 0)} ${String(p.percent ?? 0).padStart(3)}%`);
          if (p.status === 'complete' || p.filename) {
            done = true;
            clearLine();
            const downloadsDir = path.join(os.homedir(), 'Downloads');
            const savePath = path.join(downloadsDir, p.filename);
            process.stdout.write(c.dim('  Downloading…'));
            try {
              const imgRes = await api.downloadImage(p.filename);
              const buf = await imgRes.buffer();
              fs.writeFileSync(savePath, buf);
              clearLine();
              console.log(c.ok('  ✓ Saved  ') + c.white(savePath));
            } catch (dlErr) {
              clearLine();
              console.log(c.ok('  ✓ Done!'));
              console.log(c.warn(`  ⚠  Could not save: ${dlErr.message}`));
            }
            console.log('');
            if (opts.open) { const open = require('open'); await open(savePath); }
          } else if (p.status === 'error') {
            done = true; clearLine();
            console.error(c.err('  ✗ Generation failed.'));
          }
        } catch { /* keep polling */ }
      }
    } catch (err) {
      console.error(c.err(`  ✗ ${err.message}`));
    }
  });

// ── MODELS ─────────────────────────────────────────────────────
program
  .command('models')
  .description('List available AI models')
  .action(async () => {
    requireAuth();
    try {
      const data   = await api.getModels();
      const models = data.models || data;
      console.log('');
      console.log(c.bold('  Available Models\n'));
      (Array.isArray(models) ? models : []).forEach(m => {
        const name = typeof m === 'string' ? m : (m.name || m.model || '');
        console.log(`  ${c.brand('▸')} ${name}`);
      });
      console.log('');
    } catch (err) { console.error(c.err(`  ✗ ${err.message}`)); }
  });

// ── HISTORY ────────────────────────────────────────────────────
program
  .command('history')
  .description('List recent chat sessions')
  .option('-n, --limit <n>', 'Number to show', '20')
  .action(async opts => {
    requireAuth();
    try {
      const data  = await api.getChats();
      const chats = (data.chats || data || []).slice(0, parseInt(opts.limit));
      console.log('');
      console.log(c.bold('  Chat History\n'));
      if (!chats.length) { console.log(c.muted('  No chats yet.')); }
      else chats.forEach((ch, i) => {
        const title = (ch.title || 'Untitled').slice(0, 50);
        const msgs  = ch.message_count ? c.muted(` ${ch.message_count} msgs`) : '';
        const date  = ch.updated_at ? c.muted(' · ' + new Date(ch.updated_at).toLocaleDateString()) : '';
        console.log(`  ${c.muted(String(i + 1).padStart(3))}  ${c.white(title)}${msgs}${date}`);
      });
      console.log('');
    } catch (err) { console.error(c.err(`  ✗ ${err.message}`)); }
  });

// ── USAGE ──────────────────────────────────────────────────────
program
  .command('usage')
  .description('Show token usage for today')
  .action(async () => {
    requireAuth();
    try {
      const data  = await api.getUsage();
      const used  = data.used ?? data.tokens_used ?? data.tokensUsed ?? 0;
      const limit = data.limit ?? data.token_limit ?? data.dailyLimit ?? null;
      const pct   = limit ? Math.min(100, Math.round((used / limit) * 100)) : null;
      console.log('');
      console.log(c.bold('  Token Usage — Today\n'));
      if (pct !== null) {
        console.log(`  ${progressBar(pct)}`);
        console.log(`  ${c.bold(used.toLocaleString())} / ${limit.toLocaleString()} tokens  ${c.muted(`(${pct}%)`)}`);
      } else {
        console.log(`  ${c.bold(used.toLocaleString())} tokens used today`);
      }
      console.log('');
    } catch (err) { console.error(c.err(`  ✗ ${err.message}`)); }
  });

// ── WEATHER ────────────────────────────────────────────────────
program
  .command('weather <location>')
  .description('Get weather for a location')
  .action(async location => {
    requireAuth();
    try {
      const data   = await api.getWeather(location);
      const pretty = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      console.log('');
      console.log(c.bold(`  Weather — ${location}\n`));
      console.log('  ' + pretty.split('\n').join('\n  '));
      console.log('');
    } catch (err) { console.error(c.err(`  ✗ ${err.message}`)); }
  });

// ── UPDATE ─────────────────────────────────────────────────────
program
  .command('update')
  .description('Check for updates and install if available')
  .action(async () => {
    const { execSync } = require('child_process');
    console.log('');
    process.stdout.write(c.dim('  Checking for updates…'));

    const fetch = require('node-fetch');
    let latest;
    try {
      const res  = await fetch('https://registry.npmjs.org/prior-cli/latest', { timeout: 8000 });
      if (!res.ok) throw new Error(`Registry error: HTTP ${res.status}`);
      const data = await res.json();
      latest = data.version;
    } catch (err) {
      clearLine();
      console.error(c.err(`  ✗ Could not reach npm registry: ${err.message}\n`));
      return;
    }

    clearLine();

    if (latest === version) {
      console.log(c.ok('  ✓ Already up to date  ') + c.muted(`v${version}`));
      console.log('');
      return;
    }

    console.log(`  ${c.muted('Current :')} ${c.white(`v${version}`)}`);
    console.log(`  ${c.muted('Latest  :')} ${c.bold(`v${latest}`)}`);
    console.log('');
    process.stdout.write(c.dim('  Installing update…'));

    try {
      execSync('npm install -g prior-cli@latest', { stdio: 'ignore' });
      clearLine();
      console.log(c.ok(`  ✓ Updated to v${latest}  `) + c.muted('restart prior to apply'));
    } catch (err) {
      clearLine();
      console.error(c.err(`  ✗ Install failed: ${err.message}`));
      console.error(c.muted('  Try manually: npm install -g prior-cli@latest'));
    }
    console.log('');
  });

// ── Entry point ────────────────────────────────────────────────
program
  .name('prior')
  .description('Prior Network — AI command-line interface')
  .version(version, '-v, --version', 'Print version');

const args = process.argv.slice(2);

if (args.length === 0 || (args.length === 1 && args[0].startsWith('-') && args[0] !== '--help' && args[0] !== '-h')) {
  startChat();
} else {
  program.parse(process.argv);
}
