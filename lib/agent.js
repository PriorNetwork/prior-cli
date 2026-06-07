'use strict';

const fetch = require('node-fetch');
const { executeTool, TOOL_NAMES } = require('./tools');
const { getToken, getUsername } = require('./config');

const CLI_BASE  = 'https://priornetwork.com/cli-backend';
const PRIOR_BASE = 'https://priornetwork.com';
const MAX_ITER   = 14;

// ── Single inference call ─────────────────────────────────────

async function infer(messages, model, token, { cwd, uncensored, projectContext, images } = {}, signal) {
  const res = await fetch(`${CLI_BASE}/api/infer`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ messages, model, token, cwd, uncensored, projectContext, images }),
    timeout: 300000,
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Server error: HTTP ${res.status}`);
  }
  return await res.json();
}

// ── Token usage tracking ──────────────────────────────────────

async function trackTokenUsage(token, promptTokens, completionTokens) {
  if (!token || (!promptTokens && !completionTokens)) return;
  try {
    await fetch(`${PRIOR_BASE}/prior/api/user/token-usage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({ promptTokens, completionTokens }),
      timeout: 5000,
    });
  } catch { /* non-fatal */ }
}

// ── Tool call parsers (mirror server-side logic) ──────────────

function fixJsonLiterals(str) {
  let result = '';
  let inString = false;
  let escaped  = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (escaped)                { result += ch; escaped = false; continue; }
    if (ch === '\\' && inString) { result += ch; escaped = true; continue; }
    if (ch === '"')              { inString = !inString; result += ch; continue; }
    if (inString) {
      if      (ch === '\n') { result += '\\n'; continue; }
      else if (ch === '\r') { result += '\\r'; continue; }
      else if (ch === '\t') { result += '\\t'; continue; }
    }
    result += ch;
  }
  return result;
}

function parseToolCalls(text) {
  const calls = [];

  // Primary: <tool>{"name":"X","args":{...}}</tool>
  const re = /<tool>([\s\S]*?)<\/tool>/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    try {
      const fixed  = fixJsonLiterals(m[1].trim());
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed.name === 'string') {
        const { name, args, ...rest } = parsed;
        calls.push({ raw: m[0], offset: m.index, name, args: args || (Object.keys(rest).length > 0 ? rest : {}) });
      }
    } catch { /* skip */ }
  }

  // Fallback: unclosed <tool>{...}  (no closing </tool> — some models omit it)
  const reUnclosed = /<tool>(\{[\s\S]*?\})\s*(?=$|\n|<)/g;
  while ((m = reUnclosed.exec(text)) !== null) {
    const alreadyCaptured = calls.some(c => m.index >= c.offset && m.index < c.offset + c.raw.length);
    if (alreadyCaptured) continue;
    try {
      const fixed  = fixJsonLiterals(m[1].trim());
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed.name === 'string') {
        const { name, args, ...rest } = parsed;
        calls.push({ raw: m[0], offset: m.index, name, args: args || (Object.keys(rest).length > 0 ? rest : {}) });
      }
    } catch { /* skip */ }
  }

  // Primary variant: <tool name="X">{"args"}</tool>  (name as attribute — used by some models)
  const reAttr = /<tool\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/tool>/g;
  while ((m = reAttr.exec(text)) !== null) {
    const alreadyCaptured = calls.some(c => m.index >= c.offset && m.index < c.offset + c.raw.length);
    if (alreadyCaptured) continue;
    const toolName = m[1];
    try {
      const body   = m[2].trim();
      const parsed = body ? JSON.parse(fixJsonLiterals(body)) : {};
      const { args, ...rest } = parsed;
      calls.push({ raw: m[0], offset: m.index, name: toolName, args: args || (Object.keys(rest).length > 0 ? rest : {}) });
    } catch {
      calls.push({ raw: m[0], offset: m.index, name: toolName, args: {} });
    }
  }

  // Fallback 1: <tool_name>{...}</tool_name>
  for (const name of TOOL_NAMES) {
    const fbRe = new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`, 'g');
    let fm;
    while ((fm = fbRe.exec(text)) !== null) {
      const alreadyCaptured = calls.some(c => fm.index >= c.offset && fm.index < c.offset + c.raw.length);
      if (alreadyCaptured) continue;
      try {
        const fixed  = fixJsonLiterals(fm[1].trim());
        const parsed = JSON.parse(fixed);
        const { args, ...rest } = parsed || {};
        calls.push({ raw: fm[0], offset: fm.index, name, args: args || (parsed && Object.keys(rest).length > 0 ? rest : {}) });
      } catch { /* skip */ }
    }
  }

  // Fallback 2: <tool_name {"key":"val"}>...</tool_name>  (JSON in opening tag)
  for (const name of TOOL_NAMES) {
    const fbRe = new RegExp(`<${name}\\s*({[\\s\\S]*?})\\s*>[\\s\\S]*?<\\/${name}>`, 'g');
    let fm;
    while ((fm = fbRe.exec(text)) !== null) {
      const alreadyCaptured = calls.some(c => fm.index >= c.offset && fm.index < c.offset + c.raw.length);
      if (alreadyCaptured) continue;
      try {
        const fixed  = fixJsonLiterals(fm[1].trim());
        const parsed = JSON.parse(fixed);
        const { args, ...rest } = parsed || {};
        calls.push({ raw: fm[0], offset: fm.index, name, args: args || (parsed && Object.keys(rest).length > 0 ? rest : {}) });
      } catch { /* skip */ }
    }
  }

  // Fallback 3: <tool_name key="val" ...>...</tool_name>  (HTML attribute style — used by dolphin)
  for (const name of TOOL_NAMES) {
    const fbRe = new RegExp(`<${name}((?:\\s+[a-zA-Z_]\\w*="[^"]*")+)\\s*(?:>[\\s\\S]*?<\\/${name}>|/>)`, 'g');
    let fm;
    while ((fm = fbRe.exec(text)) !== null) {
      const alreadyCaptured = calls.some(c => fm.index >= c.offset && fm.index < c.offset + c.raw.length);
      if (alreadyCaptured) continue;
      const args = {};
      const attrRe = /([a-zA-Z_]\w*)="([^"]*)"/g;
      let am;
      while ((am = attrRe.exec(fm[1])) !== null) args[am[1]] = am[2];
      calls.push({ raw: fm[0], offset: fm.index, name, args });
    }
  }

  return calls;
}

function parseWriteTags(text) {
  const calls = [];
  for (const { tag, name } of [
    { tag: 'write',  name: 'file_write'  },
    { tag: 'append', name: 'file_append' },
  ]) {
    const re = new RegExp(`<${tag}\\s+path="([^"]+)"[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      calls.push({ raw: m[0], offset: m.index, name, args: { path: m[1], content: m[2] } });
    }
  }
  // <docx path="..." title="...">content</docx>
  const docxRe = /<docx\s+path="([^"]+)"(?:\s+title="([^"]*)")?[^>]*>([\s\S]*?)<\/docx>/g;
  let m;
  while ((m = docxRe.exec(text)) !== null) {
    calls.push({ raw: m[0], offset: m.index, name: 'file_write_docx', args: { path: m[1], title: m[2] || undefined, content: m[3] } });
  }
  // <edit path="..." [all="true"]>  <<<<<<< SEARCH … ======= … >>>>>>> REPLACE  </edit>
  // Conflict-marker form so multiline code needs no JSON escaping.
  const editRe = /<edit\s+path="([^"]+)"((?:\s+\w+="[^"]*")*)\s*>([\s\S]*?)<\/edit>/g;
  while ((m = editRe.exec(text)) !== null) {
    const body  = m[3];
    const split = body.match(/<{3,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n={3,}[ \t]*\r?\n([\s\S]*?)\r?\n>{3,}\s*REPLACE/);
    if (!split) continue;
    const all = /\ball="?(true|1|yes)"?/i.test(m[2]);
    calls.push({
      raw: m[0], offset: m.index, name: 'file_edit',
      args: { path: m[1], old_string: split[1], new_string: split[2], replace_all: all || undefined },
    });
  }
  return calls;
}

function stripThink(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// Some models (dolphin) hallucinate fake conversation turns after their response.
// Truncate at common boundary markers to prevent those being parsed as real tool calls.
function truncateAtFakeTurn(text) {
  const MARKERS = [
    /\n[-─]{3,}\s*\n+(?:user|human)\b/i,
    /\n+(?:user|human)\s*:\s/i,
    /\n+(?:assistant|prior)\s*:\s/i,
  ];
  let cut = text.length;
  for (const re of MARKERS) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut);
}

// Strip any residual tool-call tags the model echoes in its text output
function stripToolTags(text) {
  // <tool>...</tool>
  let out = text.replace(/<tool>[\s\S]*?<\/tool>/gi, '');
  // Unclosed <tool>{...}  (no closing tag)
  out = out.replace(/<tool>\{[\s\S]*?\}\s*/gi, '');
  // Bare <tool> with no content following
  out = out.replace(/<\/?tool>/gi, '');
  const namesPattern = TOOL_NAMES.join('|');
  // <tool_name ...>...</tool_name>  (with or without attributes/JSON)
  out = out.replace(new RegExp(`<(?:${namesPattern})[^>]*>[\\s\\S]*?<\\/(?:${namesPattern})>`, 'gi'), '');
  // Self-closing or unclosed: <tool_name attr="val" />  or  <tool_name attr="val">
  out = out.replace(new RegExp(`<(?:${namesPattern})(?:\\s[^>]*)?\\s*/?>`, 'gi'), '');
  // Tag-form file ops — never surface their bodies as chat text
  out = out.replace(/<(write|append|docx|edit)\s+[^>]*>[\s\S]*?<\/\1>/gi, '');
  return out.trim();
}

// ── Main agent loop ───────────────────────────────────────────

const CONFIRM_TOOLS = new Set(['run_command', 'file_delete', 'file_write', 'file_edit']);

async function runAgent({ messages, model, uncensored, cwd, projectContext, images, send, confirm, signal }) {
  const token = getToken();
  const history = [...messages];

  let totalPromptTokens     = 0;
  let totalCompletionTokens = 0;
  let pendingImages         = (images && images.length) ? images : null;

  for (let iter = 0; iter < MAX_ITER; iter++) {

    if (signal?.aborted) { send({ type: 'cancelled' }); send({ type: 'done' }); return; }

    send({ type: 'thinking' });

    const iterImages = pendingImages;
    pendingImages = null;

    let result;
    const MAX_INFER_RETRIES = 10;
    for (let attempt = 1; attempt <= MAX_INFER_RETRIES; attempt++) {
      try {
        result = await infer(history, model || 'qwen3.5:4b', token, { cwd, uncensored, projectContext, images: iterImages }, signal);
        break;
      } catch (err) {
        if (err.name === 'AbortError' || signal?.aborted) {
          await trackTokenUsage(token, totalPromptTokens, totalCompletionTokens);
          send({ type: 'cancelled' }); send({ type: 'done' }); return;
        }
        if (attempt >= MAX_INFER_RETRIES) {
          await trackTokenUsage(token, totalPromptTokens, totalCompletionTokens);
          send({ type: 'error', message: err.message });
          send({ type: 'done' });
          return;
        }
        send({ type: 'retry', attempt, max: MAX_INFER_RETRIES, message: err.message });
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    totalPromptTokens     += result.promptTokens     || 0;
    totalCompletionTokens += result.completionTokens || 0;

    const raw     = result.content;
    const cleaned = truncateAtFakeTurn(stripThink(raw)
      .replace(/<tool_result[\s\S]*?<\/tool_result>/gi, ''))
      .trim();

    const calls = [
      ...parseToolCalls(cleaned),
      ...parseWriteTags(cleaned),
    ].sort((a, b) => a.offset - b.offset);

    // ── No tool calls → final answer ──────────────────────────
    if (calls.length === 0) {
      const finalText = stripToolTags(cleaned);
      if (!finalText && iter < MAX_ITER - 1) {
        history.push({ role: 'assistant', content: raw });
        history.push({ role: 'user', content: '(Your response was empty. Please write your reply.)' });
        continue;
      }
      await trackTokenUsage(token, totalPromptTokens, totalCompletionTokens);
      send({ type: 'text', content: finalText });
      send({ type: 'done', promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens });
      return;
    }

    // ── Text before first tool call ───────────────────────────
    const textBefore = stripToolTags(cleaned.slice(0, calls[0].offset)).trim();
    if (textBefore) send({ type: 'text', content: textBefore });

    history.push({ role: 'assistant', content: raw });

    // ── Execute each tool locally ─────────────────────────────
    const resultParts = [];
    for (const call of calls) {
      send({ type: 'tool_start', name: call.name, args: call.args });

      if (confirm && CONFIRM_TOOLS.has(call.name)) {
        const approved = await confirm({ name: call.name, args: call.args });
        if (!approved) {
          send({ type: 'tool_skip', name: call.name });
          resultParts.push(`<tool_result name="${call.name}">\nThe user declined this action. Do NOT retry it, rephrase it, or attempt a workaround — that would go against their explicit choice. Simply acknowledge and move on, or ask what they'd like to do instead.\n</tool_result>`);
          continue;
        }
      }

      try {
        const toolResult = await executeTool(call.name, call.args, { cwd, token, send });
        // Pass output snippet so the CLI can show a rich preview
        send({ type: 'tool_done', name: call.name, summary: toolResult.summary, preview: toolResult.output, weather: toolResult.weather });
        resultParts.push(`<tool_result name="${call.name}">\n${toolResult.output}\n</tool_result>`);

        // generate_image pre-generates its caption before queuing (queuing kills Ollama
        // for VRAM) — emit it directly as the final response instead of looping back
        // into infer(), which would race the ~65-70s restart+prewarm cycle
        if (call.name === 'generate_image' && toolResult.preDescription && call === calls[calls.length - 1]) {
          await trackTokenUsage(token, totalPromptTokens, totalCompletionTokens);
          send({ type: 'text', content: toolResult.preDescription });
          send({ type: 'done', promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens });
          return;
        }
      } catch (err) {
        send({ type: 'tool_error', name: call.name, error: err.message });
        resultParts.push(`<tool_result name="${call.name}">\nERROR: ${err.message}\n</tool_result>`);
      }
    }

    history.push({ role: 'user', content: resultParts.join('\n\n') });
  }

  await trackTokenUsage(token, totalPromptTokens, totalCompletionTokens);
  send({ type: 'error', message: 'Reached maximum tool iterations.' });
  send({ type: 'done' });
}

module.exports = { runAgent, CONFIRM_TOOLS };
