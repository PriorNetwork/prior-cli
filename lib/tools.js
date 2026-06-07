'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { exec } = require('child_process');
const fetch    = require('node-fetch');

const CLI_BASE   = 'https://priornetwork.com/cli-backend';
const PRIOR_BASE = 'https://priornetwork.com';
const MAX_FILE_SIZE = 500 * 1024; // 500 KB

const BLOCKED_PATTERNS = [
  'rm -rf /',
  'del /s /q c:\\',
  'format c:',
  'fdisk',
  ':(){:|:&};:',
  'dd if=',
  'mkfs',
  'bcdedit /delete',
  'reg delete hklm',
];

function resolvePath(inputPath, cwd) {
  if (!inputPath) return cwd;
  if (/^[a-zA-Z]:[/\\]/.test(inputPath) || path.isAbsolute(inputPath)) return inputPath;
  return path.resolve(cwd, inputPath);
}

function execAsync(command, opts = {}) {
  return new Promise((resolve, reject) => {
    const lower = command.toLowerCase().replace(/\\\\/g, '\\');
    for (const pattern of BLOCKED_PATTERNS) {
      if (lower.includes(pattern)) return reject(new Error(`Blocked: command contains "${pattern}"`));
    }
    exec(command, { timeout: 20000, maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err && !stdout && !stderr) return reject(new Error(err.message));
      resolve({ stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// Directories never worth walking for search/glob
const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', '.next', 'dist', 'build',
  '.venv', 'venv', '.cache', 'coverage', '.nyc_output', 'vendor',
  '.idea', '.vscode', 'bin/obj', 'obj', '.gradle', 'target',
]);

// Minimal glob → RegExp.  Supports **  *  ?  matched against a
// forward-slash relative path.  Anchored full-string.
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {           // ** → any depth (incl. slashes)
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;      // swallow the slash after **
      } else {
        re += '[^/]*';                     // * → within one path segment
      }
    } else if (ch === '?')                 re += '[^/]';
    else if ('.+^${}()|[]\\'.includes(ch)) re += '\\' + ch;
    else                                   re += ch;
  }
  return new RegExp('^' + re + '$', 'i');
}

// Recursively collect files under `root`, skipping SKIP_DIRS and oversized files.
function walkFiles(root, onFile, budget = { left: 20000 }) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (budget.left <= 0) return;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.git')) continue;
      walkFiles(full, onFile, budget);
    } else {
      budget.left--;
      onFile(full);
    }
  }
}

// ── Tool implementations ──────────────────────────────────────

const TOOLS = {

  async file_read({ path: filePath }, { cwd }) {
    if (!filePath) throw new Error('"path" is required');
    const resolved = resolvePath(filePath, cwd);
    if (!fs.existsSync(resolved)) throw new Error(`Not found: ${filePath}`);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) throw new Error(`"${filePath}" is a directory — use file_list`);
    if (stat.size > MAX_FILE_SIZE) throw new Error(`File too large (${formatSize(stat.size)}, max 500KB)`);
    const content = fs.readFileSync(resolved, 'utf8');
    return {
      output:  content,
      summary: `${content.split('\n').length} lines · ${formatSize(stat.size)}`,
    };
  },

  async file_write({ path: filePath, content }, { cwd }) {
    if (!filePath)             throw new Error('"path" is required');
    if (content === undefined) throw new Error('"content" is required');
    const resolved = resolvePath(filePath, cwd);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, content, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    return {
      output:  `Written: ${filePath} (${formatSize(bytes)})`,
      summary: `${formatSize(bytes)} → ${path.basename(filePath)}`,
    };
  },

  async file_append({ path: filePath, content }, { cwd }) {
    if (!filePath)             throw new Error('"path" is required');
    if (content === undefined) throw new Error('"content" is required');
    const resolved = resolvePath(filePath, cwd);
    fs.appendFileSync(resolved, content, 'utf8');
    const bytes = Buffer.byteLength(content, 'utf8');
    return {
      output:  `Appended ${formatSize(bytes)} to ${filePath}`,
      summary: `+${formatSize(bytes)} to ${path.basename(filePath)}`,
    };
  },

  async file_edit({ path: filePath, old_string, new_string, replace_all }, { cwd }) {
    if (!filePath)              throw new Error('"path" is required');
    if (old_string === undefined) throw new Error('"old_string" is required');
    if (new_string === undefined) throw new Error('"new_string" is required');
    if (old_string === new_string) throw new Error('old_string and new_string are identical — nothing to change');
    const resolved = resolvePath(filePath, cwd);
    if (!fs.existsSync(resolved)) throw new Error(`Not found: ${filePath} — use file_write to create a new file`);
    const stat = fs.statSync(resolved);
    if (stat.isDirectory())       throw new Error(`"${filePath}" is a directory`);
    if (stat.size > MAX_FILE_SIZE) throw new Error(`File too large (${formatSize(stat.size)}, max 500KB)`);

    const content = fs.readFileSync(resolved, 'utf8');
    const first   = content.indexOf(old_string);
    if (first === -1) throw new Error(`old_string not found in ${filePath} — it must match the file exactly, including whitespace and indentation`);

    let updated, count;
    if (replace_all) {
      count   = content.split(old_string).length - 1;
      updated = content.split(old_string).join(new_string);
    } else {
      if (content.indexOf(old_string, first + old_string.length) !== -1) {
        throw new Error(`old_string appears multiple times in ${filePath} — add more surrounding context to make it unique, or pass "replace_all": true`);
      }
      count   = 1;
      updated = content.slice(0, first) + new_string + content.slice(first + old_string.length);
    }
    fs.writeFileSync(resolved, updated, 'utf8');
    const delta = (new_string.split('\n').length) - (old_string.split('\n').length);
    return {
      output:  `Edited ${filePath} — ${count} replacement${count !== 1 ? 's' : ''}${delta ? ` (${delta > 0 ? '+' : ''}${delta} lines)` : ''}`,
      summary: `${count}× in ${path.basename(filePath)}`,
    };
  },

  async file_search({ pattern, path: searchPath = '.', glob, ignore_case, max_results }, { cwd }) {
    if (!pattern) throw new Error('"pattern" is required');
    let re;
    try { re = new RegExp(pattern, ignore_case ? 'i' : ''); }
    catch (e) { throw new Error(`Invalid regex pattern: ${e.message}`); }
    const root = resolvePath(searchPath, cwd);
    if (!fs.existsSync(root)) throw new Error(`Not found: ${searchPath}`);
    const cap    = Math.min(max_results || 100, 300);
    const globRe = glob ? globToRegExp(glob.includes('/') ? glob : '**/' + glob) : null;
    const hits   = [];
    let filesMatched = new Set();

    const scanFile = (full) => {
      if (hits.length >= cap) return;
      const rel = path.relative(cwd, full).replace(/\\/g, '/');
      if (globRe && !globRe.test(rel) && !globRe.test(path.basename(full))) return;
      let stat; try { stat = fs.statSync(full); } catch { return; }
      if (stat.size > MAX_FILE_SIZE) return;
      let text; try { text = fs.readFileSync(full, 'utf8'); } catch { return; }
      if (text.indexOf('\x00') !== -1) return; // skip binary files
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < cap; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) {
          filesMatched.add(rel);
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    };

    if (fs.statSync(root).isDirectory()) walkFiles(root, scanFile);
    else scanFile(root);

    if (!hits.length) return { output: `No matches for /${pattern}/${glob ? ` in ${glob}` : ''}`, summary: '0 matches' };
    const more = hits.length >= cap ? `\n… (capped at ${cap} matches)` : '';
    return {
      output:  hits.join('\n') + more,
      summary: `${hits.length} match${hits.length !== 1 ? 'es' : ''} in ${filesMatched.size} file${filesMatched.size !== 1 ? 's' : ''}`,
    };
  },

  async file_glob({ pattern, path: searchPath = '.' }, { cwd }) {
    if (!pattern) throw new Error('"pattern" is required');
    const root = resolvePath(searchPath, cwd);
    if (!fs.existsSync(root)) throw new Error(`Not found: ${searchPath}`);
    const globRe  = globToRegExp(pattern.includes('/') ? pattern : '**/' + pattern);
    const results = [];
    walkFiles(root, (full) => {
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (globRe.test(rel) || globRe.test(path.basename(full))) {
        let mtime = 0; try { mtime = fs.statSync(full).mtimeMs; } catch {}
        results.push({ rel: path.relative(cwd, full).replace(/\\/g, '/'), mtime });
      }
    });
    results.sort((a, b) => b.mtime - a.mtime);
    const top = results.slice(0, 200);
    const more = results.length > top.length ? `\n… and ${results.length - top.length} more` : '';
    return {
      output:  top.length ? top.map(r => '  ' + r.rel).join('\n') + more : `No files match "${pattern}"`,
      summary: `${results.length} file${results.length !== 1 ? 's' : ''} match "${pattern}"`,
    };
  },

  async file_list({ path: dirPath = '.' }, { cwd }) {
    const resolved = resolvePath(dirPath, cwd);
    if (!fs.existsSync(resolved)) throw new Error(`Not found: ${dirPath}`);
    if (!fs.statSync(resolved).isDirectory()) throw new Error(`Not a directory: ${dirPath}`);
    const entries = fs.readdirSync(resolved, { withFileTypes: true });
    const lines = entries.map(e => {
      if (e.isDirectory()) return `  📁  ${e.name}/`;
      try {
        const size = fs.statSync(path.join(resolved, e.name)).size;
        return `  📄  ${e.name}  ${formatSize(size)}`;
      } catch {
        return `  📄  ${e.name}`;
      }
    });
    return {
      output:  lines.join('\n') || '(empty directory)',
      summary: `${entries.length} items in ${dirPath}`,
    };
  },

  async file_delete({ path: filePath }, { cwd }) {
    if (!filePath) throw new Error('"path" is required');
    const resolved = resolvePath(filePath, cwd);
    if (!fs.existsSync(resolved)) throw new Error(`Not found: ${filePath}`);
    if (fs.statSync(resolved).isDirectory()) throw new Error('Use run_command to remove directories');
    fs.unlinkSync(resolved);
    return {
      output:  `Deleted: ${filePath}`,
      summary: path.basename(filePath),
    };
  },

  async file_write_docx({ path: filePath, content, title }, { cwd }) {
    if (!filePath)             throw new Error('"path" is required');
    if (content === undefined) throw new Error('"content" is required');
    const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
    const resolved = resolvePath(filePath, cwd);
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const lines    = content.split('\n');
    const children = [];
    if (title) children.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));

    for (const line of lines) {
      if      (line.startsWith('# '))   children.push(new Paragraph({ text: line.slice(2),  heading: HeadingLevel.HEADING_1 }));
      else if (line.startsWith('## '))  children.push(new Paragraph({ text: line.slice(3),  heading: HeadingLevel.HEADING_2 }));
      else if (line.startsWith('### ')) children.push(new Paragraph({ text: line.slice(4),  heading: HeadingLevel.HEADING_3 }));
      else if (line.trim() === '')      children.push(new Paragraph({ text: '' }));
      else {
        const runs  = [];
        const parts = line.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
        for (const part of parts) {
          if      (part.startsWith('**') && part.endsWith('**')) runs.push(new TextRun({ text: part.slice(2, -2), bold: true }));
          else if (part.startsWith('*')  && part.endsWith('*'))  runs.push(new TextRun({ text: part.slice(1, -1), italics: true }));
          else if (part)                                          runs.push(new TextRun({ text: part }));
        }
        children.push(new Paragraph({ children: runs }));
      }
    }

    const doc    = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(resolved, buffer);
    return {
      output:  `Word document saved: ${filePath} (${formatSize(buffer.length)})`,
      summary: `${formatSize(buffer.length)} → ${path.basename(filePath)}`,
    };
  },

  async get_weather({ location }, {}) {
    if (!location) throw new Error('"location" is required');
    const encoded = encodeURIComponent(location);
    const res = await fetch(`https://wttr.in/${encoded}?format=j1`, {
      headers: { 'User-Agent': 'prior-cli/1.0' },
      timeout: 10000,
    });
    if (!res.ok) throw new Error(`Weather service error: HTTP ${res.status}`);
    const data = await res.json();

    const cur  = data.current_condition?.[0] || {};
    const area = data.nearest_area?.[0] || {};
    const city = area.areaName?.[0]?.value || location;
    const country = area.country?.[0]?.value || '';

    const tempC     = cur.temp_C || '?';
    const feelsC    = cur.FeelsLikeC || '?';
    const humidity  = cur.humidity || '?';
    const windKmph  = cur.windspeedKmph || '?';
    const desc      = cur.weatherDesc?.[0]?.value || '?';
    const code      = parseInt(cur.weatherCode || '113');

    const forecast = (data.weather || []).slice(0, 3).map(d => ({
      date:  d.date,
      maxC:  d.maxtempC,
      minC:  d.mintempC,
      desc:  d.hourly?.[4]?.weatherDesc?.[0]?.value || '',
      code:  parseInt(d.hourly?.[4]?.weatherCode || '113'),
    }));

    // Build structured output for CLI to render as a card
    const result = { city, country, tempC, feelsC, humidity, windKmph, desc, code, forecast };
    return {
      output:  JSON.stringify(result),
      summary: `${city}${country ? ', ' + country : ''} · ${tempC}°C · ${desc}`,
      weather: result,
    };
  },

  async web_search({ query }, { token }) {
    if (!query) throw new Error('"query" is required');
    const res  = await fetch(`${CLI_BASE}/api/web-search`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ query }),
      timeout: 15000,
    });
    if (!res.ok) throw new Error(`Web search error: HTTP ${res.status}`);
    const data = await res.json();
    if (!data.items || !data.items.length) return { output: 'No results found.', summary: '0 results' };
    const results = data.items.map(item => {
      const parts = [`**${item.title}**`, item.link];
      if (item.snippet) parts.push(item.snippet);
      return parts.join('\n');
    });
    return {
      output:  results.join('\n\n'),
      summary: `${results.length} results for "${query}"`,
    };
  },

  async url_fetch({ url }, { token }) {
    if (!url) throw new Error('"url" is required');
    const res = await fetch(`${CLI_BASE}/api/url-fetch`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body:    JSON.stringify({ url }),
      timeout: 30000,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const data     = await res.json();
    const hostname = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    const content  = data.content || data.description || '(no readable content)';
    const titleStr = data.title ? `# ${data.title}\n\n` : '';
    return {
      output:  (titleStr + content).slice(0, 8000),
      summary: `${content.length} chars from ${hostname}`,
    };
  },

  async clipboard_read() {
    const { stdout } = await execAsync('powershell -command "Get-Clipboard"');
    return {
      output:  stdout || '(clipboard is empty)',
      summary: `${stdout.length} chars from clipboard`,
    };
  },

  async clipboard_write({ text }) {
    if (!text && text !== '') throw new Error('"text" is required');
    const escaped = text.replace(/'/g, "''");
    await execAsync(`powershell -command "Set-Clipboard -Value '${escaped}'"`);
    return {
      output:  `Copied to clipboard (${text.length} chars)`,
      summary: `${text.length} chars copied`,
    };
  },

  async generate_image({ prompt, width, height, steps }, { cwd, token, send }) {
    if (!prompt) throw new Error('"prompt" is required');
    const totalSteps = steps || 20;
    const authHdr = token ? { Authorization: `Bearer ${token}` } : {};

    // Pre-generate the caption BEFORE queuing — queuing kills Ollama for VRAM right
    // after, and the restart+prewarm cycle outlasts a normal post-gen inference call
    let preDescription = null;
    try {
      const descRes = await fetch(`${CLI_BASE}/api/describe-image`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ prompt, token }),
        timeout: 30000,
      });
      if (descRes.ok) {
        const d = await descRes.json();
        preDescription = (d.description || '').trim() || null;
      }
    } catch { /* non-fatal — falls back to a normal post-gen description */ }

    // Step 1: Queue
    const queueRes = await fetch(`${CLI_BASE}/api/generate-image/queue`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...authHdr },
      body:    JSON.stringify({ prompt, width: width || 896, height: height || 896, steps: totalSteps }),
      timeout: 15000,
    });
    if (!queueRes.ok) {
      const err = await queueRes.json().catch(() => ({}));
      throw new Error(err.error || err.message || `HTTP ${queueRes.status}`);
    }
    const { promptId } = await queueRes.json();
    if (!promptId) throw new Error('No promptId returned from image queue');

    // Step 2: Poll with progress
    let job = null;
    for (let i = 0; i < 240; i++) {
      await new Promise(r => setTimeout(r, 1500));
      try {
        const pr = await fetch(`${CLI_BASE}/api/generate-image/progress/${promptId}`, {
          headers: authHdr, timeout: 5000,
        });
        if (pr.ok) {
          job = await pr.json();
          if (job && send && job.step !== undefined) {
            const pct = job.percent || Math.round((job.step / (job.total || totalSteps)) * 100);
            send({ type: 'tool_progress', step: job.step, total: job.total || totalSteps, percent: pct });
          }
          if (job && (job.status === 'done' || job.status === 'error')) break;
        }
      } catch { /* keep polling */ }
    }

    if (!job || job.status === 'error') {
      throw new Error(job?.error || 'Image generation failed or timed out');
    }

    // Step 3: Watermark
    const wmRes = await fetch(`${CLI_BASE}/api/generate-image/watermark`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', ...authHdr },
      body:    JSON.stringify({ filename: job.filename }),
      timeout: 30000,
    });
    if (!wmRes.ok) {
      const err = await wmRes.json().catch(() => ({}));
      throw new Error(err.error || `Watermark failed: HTTP ${wmRes.status}`);
    }
    const data = await wmRes.json();
    if (!data.filename || !data.data) throw new Error('Invalid response from image generation service');
    const buffer = Buffer.from(data.data, 'base64');
    let savePath = path.join(cwd, data.filename);
    try {
      fs.writeFileSync(savePath, buffer);
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'EACCES') throw err;
      // cwd requires elevated permissions (e.g. C:\Windows\System32) — fall back to Downloads
      const downloads = path.join(os.homedir(), 'Downloads');
      if (!fs.existsSync(downloads)) fs.mkdirSync(downloads, { recursive: true });
      savePath = path.join(downloads, data.filename);
      fs.writeFileSync(savePath, buffer);
    }
    return {
      output:  `Image saved to: ${savePath}`,
      summary: savePath,
      preDescription,
    };
  },

  async run_command({ command }, { cwd }) {
    if (!command) throw new Error('"command" is required');
    const { stdout, stderr } = await execAsync(`cd /d "${cwd}" && ${command}`);
    const output = [stdout, stderr].filter(Boolean).join('\n') || '(no output)';
    return {
      output,
      summary: command.length > 60 ? command.slice(0, 57) + '…' : command,
    };
  },

  async prior_feed({}, { token }) {
    const res = await fetch(`${PRIOR_BASE}/network/api/feed`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      timeout: 8000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data  = await res.json();
    const posts = (data.posts || data || []).slice(0, 8);
    if (!posts.length) return { output: 'No posts found.', summary: '0 posts' };
    const lines = posts.map(p => {
      const date = p.created_at ? new Date(p.created_at).toLocaleDateString() : '';
      return `@${p.username || '?'}  ${date}\n${(p.content || '').slice(0, 200)}`;
    });
    return {
      output:  lines.join('\n\n─────────────────────\n\n'),
      summary: `${posts.length} posts`,
    };
  },

  async prior_profile({}, { token }) {
    const res = await fetch(`${PRIOR_BASE}/network/api/user/profile`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      timeout: 8000,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const u    = data.user || data;
    return {
      output: [
        `Username     : @${u.username || '?'}`,
        `Display Name : ${u.display_name || u.displayName || u.username || '?'}`,
        `Bio          : ${u.bio || '(none)'}`,
        `Posts        : ${u.post_count   ?? u.posts_count   ?? 0}`,
        `Friends      : ${u.friend_count ?? u.friends_count ?? 0}`,
        `Joined       : ${u.created_at ? new Date(u.created_at).toLocaleDateString() : 'unknown'}`,
      ].join('\n'),
      summary: `@${u.username || '?'}`,
    };
  },
  async zap_scan({ url, scan_type = 'passive' }, { token }) {
    if (!url) throw new Error('"url" is required');
    const res = await fetch(`${CLI_BASE}/api/zap/scan`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ url, scan_type }),
      timeout: 60000,
    });
    if (res.status === 403) throw new Error('ZAP tools are only available to Organization accounts.');
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
    const data = await res.json();
    return { output: data.output || JSON.stringify(data), summary: data.summary || `scan started for ${url}` };
  },

  async zap_alerts({ url }, { token }) {
    const res = await fetch(`${CLI_BASE}/api/zap/alerts`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ url }),
      timeout: 15000,
    });
    if (res.status === 403) throw new Error('ZAP tools are only available to Organization accounts.');
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
    const data = await res.json();
    return { output: data.output || JSON.stringify(data), summary: data.summary || 'alerts fetched' };
  },

  async zap_spider({ url }, { token }) {
    if (!url) throw new Error('"url" is required');
    const res = await fetch(`${CLI_BASE}/api/zap/spider`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ url }),
      timeout: 60000,
    });
    if (res.status === 403) throw new Error('ZAP tools are only available to Organization accounts.');
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.error || `HTTP ${res.status}`); }
    const data = await res.json();
    return { output: data.output || JSON.stringify(data), summary: data.summary || `spider started for ${url}` };
  },

  async get_time({}, {}) {
    const now = new Date();
    const iso  = now.toISOString();
    const local = now.toLocaleString('en-PH', {
      timeZone:     'Asia/Manila',
      weekday:      'long',
      year:         'numeric',
      month:        'long',
      day:          'numeric',
      hour:         '2-digit',
      minute:       '2-digit',
      second:       '2-digit',
      hour12:       true,
    });
    const utc = now.toUTCString();
    return {
      output:  `Local (PHT/GMT+8) : ${local}\nUTC               : ${utc}\nISO 8601          : ${iso}`,
      summary: local,
    };
  },

  async ip_lookup({ target }, {}) {
    if (!target) throw new Error('"target" is required — provide an IP address or domain');
    const encoded = encodeURIComponent(target.trim());
    const res = await fetch(`https://ipinfo.io/${encoded}/json`, {
      headers: { 'User-Agent': 'prior-cli/1.0', Accept: 'application/json' },
      timeout: 10000,
    });
    if (!res.ok) throw new Error(`ipinfo.io error: HTTP ${res.status}`);
    const d = await res.json();
    if (d.error) throw new Error(d.error.message || 'Lookup failed');
    const lines = [
      `IP        : ${d.ip || target}`,
      d.hostname  ? `Hostname  : ${d.hostname}`  : null,
      d.org       ? `Org / ASN : ${d.org}`        : null,
      d.city      ? `Location  : ${[d.city, d.region, d.country].filter(Boolean).join(', ')}` : null,
      d.postal    ? `Postal    : ${d.postal}`     : null,
      d.timezone  ? `Timezone  : ${d.timezone}`  : null,
      d.loc       ? `Coords    : ${d.loc}`        : null,
    ].filter(Boolean);
    return {
      output:  lines.join('\n'),
      summary: `${d.ip || target}${d.org ? ' · ' + d.org : ''}${d.city ? ' · ' + d.city : ''}`,
    };
  },

  async dns_lookup({ domain, type = 'A' }, {}) {
    if (!domain) throw new Error('"domain" is required');
    const validTypes = ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT', 'SOA', 'PTR', 'SRV'];
    const qtype = type.toUpperCase();
    if (!validTypes.includes(qtype)) throw new Error(`Invalid type. Choose from: ${validTypes.join(', ')}`);
    const res = await fetch(`https://dns.google/resolve?name=${encodeURIComponent(domain)}&type=${qtype}`, {
      headers: { Accept: 'application/json' },
      timeout: 10000,
    });
    if (!res.ok) throw new Error(`DNS query failed: HTTP ${res.status}`);
    const data = await res.json();
    if (data.Status !== 0) {
      const STATUS = { 1: 'Format error', 2: 'Server failure', 3: 'NXDOMAIN (not found)', 5: 'Refused' };
      throw new Error(STATUS[data.Status] || `DNS error code ${data.Status}`);
    }
    if (!data.Answer || data.Answer.length === 0) {
      return { output: `No ${qtype} records found for ${domain}`, summary: `0 ${qtype} records` };
    }
    const lines = data.Answer.map(r => {
      const ttl = `TTL ${r.TTL}s`;
      return `  ${String(r.type).padEnd(6)} ${ttl.padEnd(12)} ${r.data}`;
    });
    const header = `${domain}  ${qtype} records (${data.Answer.length})\n`;
    return {
      output:  header + lines.join('\n'),
      summary: `${data.Answer.length} ${qtype} record${data.Answer.length !== 1 ? 's' : ''} for ${domain}`,
    };
  },

  async ssl_check({ domain }, {}) {
    if (!domain) throw new Error('"domain" is required');
    // Strip protocol if provided
    const host = domain.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    // Use crt.sh to get cert info + check via HEAD for expiry details
    const [certRes, headRes] = await Promise.allSettled([
      fetch(`https://crt.sh/?q=${encodeURIComponent(host)}&output=json`, {
        headers: { 'User-Agent': 'prior-cli/1.0' },
        timeout: 12000,
      }),
      fetch(`https://${host}`, {
        method: 'HEAD',
        headers: { 'User-Agent': 'prior-cli/1.0' },
        timeout: 8000,
      }),
    ]);

    const lines = [`Domain : ${host}`];

    // Live cert check via HTTPS HEAD — Node's TLS gives us nothing in headers,
    // but we can confirm TLS works and check for errors
    if (headRes.status === 'fulfilled') {
      lines.push(`HTTPS  : ✓ reachable (HTTP ${headRes.value.status})`);
    } else {
      const msg = headRes.reason?.message || 'unreachable';
      const expired = /certificate has expired|CERT_HAS_EXPIRED/i.test(msg);
      lines.push(`HTTPS  : ✗ ${expired ? 'CERTIFICATE EXPIRED' : msg}`);
    }

    // crt.sh — most recent issuances
    if (certRes.status === 'fulfilled' && certRes.value.ok) {
      try {
        const certs = await certRes.value.json();
        const recent = certs
          .filter(c => c.name_value && !c.name_value.startsWith('*'))
          .sort((a, b) => new Date(b.not_after) - new Date(a.not_after))
          .slice(0, 3);
        if (recent.length) {
          lines.push('');
          lines.push('Recent certificates (crt.sh):');
          for (const c of recent) {
            const expiry  = new Date(c.not_after);
            const issued  = new Date(c.not_before);
            const daysLeft = Math.ceil((expiry - Date.now()) / 86400000);
            const status  = daysLeft < 0 ? '✗ EXPIRED' : daysLeft < 14 ? `⚠ expires in ${daysLeft}d` : `✓ ${daysLeft}d left`;
            lines.push(`  Issuer  : ${c.issuer_name?.replace(/^.*?CN=/, 'CN=') || '?'}`);
            lines.push(`  Issued  : ${issued.toLocaleDateString()}`);
            lines.push(`  Expires : ${expiry.toLocaleDateString()}  (${status})`);
            lines.push(`  Names   : ${c.name_value.replace(/\n/g, ', ')}`);
            lines.push('  ─────────────────────────────');
          }
        }
      } catch { /* crt.sh parse failed, HTTPS check is enough */ }
    }

    // Summary line
    const httpsOk = headRes.status === 'fulfilled';
    return {
      output:  lines.join('\n'),
      summary: `${host} · HTTPS ${httpsOk ? '✓' : '✗'}`,
    };
  },
};

async function executeTool(name, args, context) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unknown tool: "${name}"`);
  return await fn(args || {}, context);
}

const TOOL_NAMES = Object.keys(TOOLS);

module.exports = { executeTool, TOOL_NAMES };
