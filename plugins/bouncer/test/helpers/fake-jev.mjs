import { createServer } from 'node:http';

// answerFn(key, question, state) -> answer object
export async function startFakeJev(answerFn, { status = 200, delayMs = 0, failWhen = () => false } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const request = JSON.parse(body);
      calls.push({ headers: req.headers, body: request });
      setTimeout(() => {
        if (status !== 200 || failWhen(request)) {
          res.statusCode = status !== 200 ? status : 500;
          res.end('{"error":"fail"}');
          return;
        }
        const answers = {};
        for (const [key, q] of Object.entries(request.questions)) answers[key] = answerFn(key, q, request.state);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ model: 'jev-fake', answers, usage: { input_tokens: 100, output_tokens: 0 } }));
      }, delayMs);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

// Files whose question text contains `keyword` are relevant; needs_code is yes.
export function keywordAnswers(keyword, { needsCode = 0.95 } = {}) {
  return (key, q) => {
    const hit = JSON.stringify(q.instructions).toLowerCase().includes(keyword);
    if (q.type === 'noul') {
      if (key === 'needs_code') return { type: 'noul', noul: needsCode };
      return { type: 'noul', noul: hit ? 0.9 : 0.05 };
    }
    if (q.type === 'score') return { type: 'score', score: hit ? 3 : 0, confidence: 0.9, probabilities: {}, legend: {} };
    return { type: 'choice', choice: Object.keys(q.criteria)[0], probabilities: {}, confidence: 0.5 };
  };
}
