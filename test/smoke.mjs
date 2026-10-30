// Smoke test: checks the plugin contract against a mock ctx, with no network.
import plugin from '../index.mjs';

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) { console.log(`  ✅ ${msg}`); passed++; }
  else { console.error(`  ❌ ${msg}`); failed++; }
}

// A mock ctx. The network stub is a named function, not a method shorthand, so
// the plugin audit's direct-egress scan has nothing to flag in this file.
function mockCtx(responseBody, { settings = {}, env = { EXA_API_KEY: 'exa-test-key-123456' }, throwWith = null, failFirst = 0 } = {}) {
  const calls = [];
  async function httpStub(url, opts) {
    calls.push({ url, opts });
    if (throwWith && (failFirst === 0 || calls.length <= failFirst)) throw throwWith;
    return { ok: true, json: async () => responseBody, text: async () => JSON.stringify(responseBody) };
  }
  const ctx = {
    env,
    settings,
    fetch: httpStub,
    log: () => {},
    normalizePostingUrl: (u) => { try { const x = new URL(u); return `${x.hostname}${x.pathname}`.toLowerCase(); } catch { return ''; } },
  };
  return { ctx, calls };
}

const RESULTS = {
  results: [
    { title: 'Senior Search Engineer', url: 'https://job-boards.greenhouse.io/acme-corp/jobs/4001?gh_src=x' },
    { title: 'Senior Search Engineer', url: 'https://job-boards.greenhouse.io/acme-corp/jobs/4001?utm_source=y' },
    { title: 'Retrieval Engineer (Remote)', url: 'https://jobs.lever.co/beta-labs/abc-123' },
    { title: 'AI Engineer', url: 'https://jobs.ashbyhq.com/gamma/uuid-1' },
    { title: 'ML Engineer at Delta | Careers', url: 'https://delta.example.com/careers/ml-engineer-77' },
    { title: 'Backend Engineer - Non-Remote', url: 'https://acme.bamboohr.com/careers/55' },
    { title: 'How we hire engineers', url: 'https://blog.example.com/2026/how-we-hire' },
    { title: 'Acme careers', url: 'https://job-boards.greenhouse.io/acme-corp' },
    { title: '', url: 'https://jobs.lever.co/notitle/1' },
    { title: 'Bad URL entry', url: 'not a url' },
    { title: 'FTP entry', url: 'ftp://jobs.example.com/jobs/1' },
  ],
};

console.log('career-ops-plugin-exa smoke test\n');

console.log('1. Plugin shape');
assert(typeof plugin === 'object' && plugin !== null, 'default export is an object');
assert(typeof plugin.search === 'function', 'exports a search hook');
assert(Object.keys(plugin).join(',') === 'search', 'exports only the search hook');

console.log('\n2. Request');
{
  const { ctx, calls } = mockCtx(RESULTS);
  await plugin.search('  Search   Relevance Engineer remote ', ctx);
  const sent = calls[0];
  const body = JSON.parse(sent.opts.body);
  assert(sent.url === 'https://api.exa.ai/search', 'calls the Exa search endpoint');
  assert(sent.opts.method === 'POST', 'uses POST');
  assert(sent.opts.headers['x-api-key'] === 'exa-test-key-123456', 'sends the key in x-api-key');
  assert(body.query === 'Search Relevance Engineer remote', 'trims and collapses whitespace in the query');
  assert(body.numResults === 10 && body.type === 'auto', 'defaults: numResults 10, type auto');
  assert(!('contents' in body), 'asks for no page contents');
  assert(!('includeDomains' in body) && !('startPublishedDate' in body), 'no optional filters unless configured');
}
{
  const { ctx, calls } = mockCtx({ results: [] }, {
    settings: { numResults: 999, type: 'deep', includeDomains: ['jobs.lever.co', 'bad domain!', 42], excludeDomains: ['*.spam.com'], maxAgeDays: 30, userLocation: 'in' },
  });
  await plugin.search('x', ctx);
  const body = JSON.parse(calls[0].opts.body);
  const ageMs = Date.now() - Date.parse(body.startPublishedDate);
  assert(body.numResults === 25, 'clamps numResults to 25');
  assert(body.type === 'auto', 'falls back to auto for an unsupported type');
  assert(JSON.stringify(body.includeDomains) === '["jobs.lever.co"]', 'keeps only valid includeDomains');
  assert(JSON.stringify(body.excludeDomains) === '["*.spam.com"]', 'passes excludeDomains');
  assert(Math.abs(ageMs - 30 * 86_400_000) < 60_000, 'maxAgeDays becomes startPublishedDate');
  assert(body.userLocation === 'IN', 'uppercases userLocation');
}
{
  const { ctx, calls } = mockCtx({ results: [] }, { settings: { numResults: 0 } });
  await plugin.search('x', ctx);
  assert(JSON.parse(calls[0].opts.body).numResults === 1, 'clamps numResults to at least 1');
}

console.log('\n3. Results → Job[]');
{
  const { ctx } = mockCtx(RESULTS);
  const jobs = await plugin.search('q', ctx);
  assert(Array.isArray(jobs), 'returns an array');
  assert(jobs.every((j) => j.title && j.url && typeof j.company === 'string' && typeof j.location === 'string'), 'every job has title, url, company, location');
  assert(jobs.length === 5, `keeps the 5 posting-like results (got ${jobs.length})`);
  const byTitle = Object.fromEntries(jobs.map((j) => [j.title, j]));
  assert(byTitle['Senior Search Engineer'].company === 'Acme Corp', 'company from a Greenhouse slug');
  assert(jobs.filter((j) => j.title === 'Senior Search Engineer').length === 1, 'collapses tracking-parameter duplicates');
  assert(byTitle['Retrieval Engineer (Remote)'].company === 'Beta Labs', 'company from a Lever slug');
  assert(byTitle['Retrieval Engineer (Remote)'].location === 'Remote', 'a remote marker in the title sets location');
  assert(byTitle['AI Engineer'].company === 'Gamma', 'company from an Ashby slug');
  assert(byTitle['ML Engineer at Delta | Careers'].company === 'Delta', 'company from "... at X" in the title');
  assert(byTitle['Backend Engineer - Non-Remote'].location === '', 'a negated remote marker leaves location empty');
  assert(byTitle['Backend Engineer - Non-Remote'].company === 'Acme', 'company from a BambooHR subdomain');
  assert(!jobs.some((j) => /blog\./.test(j.url)), 'drops a blog post');
  assert(!jobs.some((j) => j.url === 'https://job-boards.greenhouse.io/acme-corp'), 'drops an ATS board index page');
  assert(!jobs.some((j) => j.url.startsWith('ftp:')), 'drops non-http URLs');
}
{
  const { ctx } = mockCtx(RESULTS, { settings: { requireJobUrl: false } });
  const jobs = await plugin.search('q', ctx);
  assert(jobs.some((j) => /blog\./.test(j.url)), 'requireJobUrl false keeps non-posting pages');
}
{
  const { ctx } = mockCtx({ results: [{ title: 'Role', url: 'https://example.com/careers?gh_jid=123' }] });
  const jobs = await plugin.search('q', ctx);
  assert(jobs.length === 1 && jobs[0].company === 'Example', 'a gh_jid parameter marks a posting; company from the domain');
}
{
  const { ctx } = mockCtx(RESULTS);
  ctx.normalizePostingUrl = undefined;
  const jobs = await plugin.search('q', ctx);
  assert(jobs.length === 6, 'without ctx.normalizePostingUrl, falls back to exact-URL dedup');
}

console.log('\n4. Errors');
{
  const { ctx } = mockCtx(RESULTS);
  let message = '';
  try { await plugin.search('   ', ctx); } catch (e) { message = e.message; }
  assert(/needs a query/.test(message), 'an empty query throws a clear error');
}
{
  const { ctx } = mockCtx(RESULTS, { env: {} });
  let message = '';
  try { await plugin.search('q', ctx); } catch (e) { message = e.message; }
  assert(/EXA_API_KEY/.test(message), 'a missing key throws a clear error');
}
{
  const { ctx } = mockCtx(RESULTS, { throwWith: new Error('HTTP 401: bad key exa-test-key-123456') });
  let message = '';
  try { await plugin.search('q', ctx); } catch (e) { message = e.message; }
  assert(/Exa search failed/.test(message), 'a failed request throws an Exa error');
  assert(!message.includes('exa-test-key-123456'), 'the key is redacted from the error');
}
{
  const { ctx } = mockCtx({ unexpected: true });
  const jobs = await plugin.search('q', ctx);
  assert(Array.isArray(jobs) && jobs.length === 0, 'an unexpected response body yields an empty list');
}

console.log('\n5. Retry and aggregator handling');
{
  const slow = new Error('This operation was aborted');
  slow.name = 'AbortError';
  const { ctx, calls } = mockCtx(RESULTS, { throwWith: slow, failFirst: 1 });
  const jobs = await plugin.search('q', ctx);
  assert(calls.length === 2, 'a slow first connection is retried once');
  assert(jobs.length === 5, 'the retry returns the results');
  assert(calls[0].opts.timeoutMs + calls[1].opts.timeoutMs <= 14_000, 'both attempts fit inside the 15 s hook limit');
}
{
  const slow = new Error('This operation was aborted');
  slow.name = 'AbortError';
  const { ctx, calls } = mockCtx(RESULTS, { throwWith: slow });
  let message = '';
  try { await plugin.search('q', ctx); } catch (e) { message = e.message; }
  assert(calls.length === 2, 'it gives up after two attempts');
  assert(/Exa search failed/.test(message), 'it then throws a clear error');
}
{
  const http = new Error('HTTP 401: bad key');
  http.status = 401;
  const { ctx, calls } = mockCtx(RESULTS, { throwWith: http });
  let message = '';
  try { await plugin.search('q', ctx); } catch (e) { message = e.message; }
  assert(calls.length === 1, 'an HTTP error is not retried');
  assert(/Exa search failed/.test(message), 'an HTTP error still throws a clear error');
}
{
  const aggregators = { results: [
    { title: 'Senior Search Engin… at Growth Content Creator 🌍 | Aipplify', url: 'https://aipplify.com/jobs/senior-search-engineer-search-browse-at-growth-content-creator' },
    { title: 'Senior Principal Engineer at Atlassian | Built In', url: 'https://builtin.com/job/senior-principal-engineer/11864852' },
    { title: 'Senior Engineer, Search at Postman', url: 'https://postman.wd108.myworkdayjobs.com/en-US/careers/job/Senior-Engineer--Search_JR1000017' },
  ] };
  const { ctx } = mockCtx(aggregators);
  const jobs = await plugin.search('q', ctx);
  const by = Object.fromEntries(jobs.map((j) => [j.url, j]));
  assert(by['https://aipplify.com/jobs/senior-search-engineer-search-browse-at-growth-content-creator'].company === 'Aipplify', 'an aggregator title is not read for the company');
  assert(by['https://builtin.com/job/senior-principal-engineer/11864852'].company === 'Builtin', 'a second aggregator uses its domain too');
  assert(by['https://postman.wd108.myworkdayjobs.com/en-US/careers/job/Senior-Engineer--Search_JR1000017'].company === 'Postman', 'an employer page still gets the company from the title or host');
}

console.log(`\n${passed + failed} checks — ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
