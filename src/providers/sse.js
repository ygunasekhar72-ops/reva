// Minimal SSE reader over fetch response bodies. Handles multi-line data
// fields, CRLF, and [DONE] sentinels. Zero dependencies.
export async function* sseLines(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, '');
      const dataLines = [];
      for (const line of rawEvent.split(/\r?\n/)) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        // event:/id:/retry: fields are ignored on purpose
      }
      if (dataLines.length > 0) yield dataLines.join('\n');
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const dataLines = [];
    for (const line of buffer.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) yield dataLines.join('\n');
  }
}

export async function readJsonResponse(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(`non-JSON response (HTTP ${response.status}): ${text.slice(0, 300)}`);
    err.status = response.status;
    throw err;
  }
}
