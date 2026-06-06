export interface CodeLine {
  number: number;
  html: string;
}

export function toCodeLines(content: string): CodeLine[] {
  return content.split(/\r?\n/).map((text, index) => ({
    number: index + 1,
    html: highlightCode(text)
  }));
}

export function highlightCode(line: string): string {
  if (!line) {
    return "&nbsp;";
  }

  const tokenPattern =
    /\/\/.*$|(["'`])(?:\\.|(?!\1).)*\1|\b(?:async|await|break|case|class|const|constructor|continue|default|else|export|extends|for|from|function|if|import|interface|let|new|private|public|readonly|return|switch|this|type|while)\b|\b\d+(?:\.\d+)?\b/g;
  let html = "";
  let cursor = 0;

  for (const match of line.matchAll(tokenPattern)) {
    const index = match.index ?? 0;
    const token = match[0];
    html += escapeHtml(line.slice(cursor, index));

    if (token.startsWith("//")) {
      html += `<span class="syntax-comment">${escapeHtml(token)}</span>`;
    } else if (/^["'`]/.test(token)) {
      html += `<span class="syntax-string">${escapeHtml(token)}</span>`;
    } else if (/^\d/.test(token)) {
      html += `<span class="syntax-number">${escapeHtml(token)}</span>`;
    } else {
      html += `<span class="syntax-keyword">${escapeHtml(token)}</span>`;
    }

    cursor = index + token.length;
  }

  html += escapeHtml(line.slice(cursor));
  return html || "&nbsp;";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
