function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function safeHref(value) {
  try {
    const url = new URL(value, globalThis.location?.origin ?? 'https://local.invalid');
    if (['http:', 'https:', 'mailto:'].includes(url.protocol)) return url.href;
  } catch { /* invalid links render as text */ }
  return null;
}

export function renderMarkdown(input) {
  const source = String(input ?? '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const output = [];
  let inCode = false;
  let codeLines = [];
  let listOpen = false;
  const closeList = () => { if (listOpen) { output.push('</ul>'); listOpen = false; } };
  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) { output.push(`<pre><code>${escapeHTML(codeLines.join('\n'))}</code></pre>`); codeLines = []; inCode = false; }
      else { closeList(); inCode = true; }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { closeList(); output.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`); continue; }
    const checklist = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (checklist || bullet) {
      if (!listOpen) { output.push('<ul>'); listOpen = true; }
      if (checklist) output.push(`<li class="markdown-check"><input type="checkbox" disabled ${checklist[1].toLowerCase() === 'x' ? 'checked' : ''} />${inlineMarkdown(checklist[2])}</li>`);
      else output.push(`<li>${inlineMarkdown(bullet[1])}</li>`);
      continue;
    }
    if (line.startsWith('>')) { closeList(); output.push(`<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList(); output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  if (inCode) output.push(`<pre><code>${escapeHTML(codeLines.join('\n'))}</code></pre>`);
  closeList();
  return output.join('');
}

export function inlineMarkdown(value) {
  let result = escapeHTML(value);
  result = result.replace(/`([^`]+)`/g, '<code>$1</code>');
  result = result.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  result = result.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  result = result.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  result = result.replace(/_([^_]+)_/g, '<em>$1</em>');
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const safe = safeHref(href);
    return safe ? `<a href="${escapeHTML(safe)}" target="_blank" rel="noopener noreferrer">${label}</a>` : label;
  });
  return result;
}
