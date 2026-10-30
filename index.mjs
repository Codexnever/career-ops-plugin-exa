// @ts-check
// career-ops-plugin-exa: Exa semantic web search for job discovery.
// License: MIT
//
// One query per call:  node plugins.mjs run exa search "<query>"
//
// The hook only RETURNS Job[]. The engine then drops postings already in the
// tracker, the pipeline or scan history, applies data/blacklist.md and the
// portals.yml title_filter / location_filter (manifest jobPostings: true), and
// writes data/pipeline.md. Network access goes through ctx.fetch only; the
// manifest allowedHosts pins it to api.exa.ai.
//
// Results are LEADS, not confirmed vacancies. Nothing here checks that a role is
// still open. The pipeline mode does that before anything is evaluated.

const EXA_SEARCH_URL = 'https://api.exa.ai/search';
const MAX_QUERY_CHARS = 400;
const DEFAULT_NUM_RESULTS = 10;
const MAX_NUM_RESULTS = 25;
// The engine's default hook timeout is 15s, so two attempts must fit inside it
// together: a slow first connection is retried once, quickly, instead of failing.
const ATTEMPT_TIMEOUTS_MS = [6_500, 6_000];
const ALLOWED_TYPES = new Set(['auto', 'lite']); // deeper types can outlast the hook timeout

const ATS_HOST_RE = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|bamboohr\.com|teamtailor\.com|breezy\.hr|recruitee\.com|myworkdayjobs\.com|jobvite\.com|icims\.com|rippling\.com|personio\.(?:de|com)|join\.com|pinpointhq\.com|comeet\.com|dayforcehcm\.com)$/i;
// Job boards that re-list postings from employers. Their page titles are not
// reliable for the employer's name ("... at X | Board"), so the company is not
// read from the title there. Career Ops treats these listings as unconfirmed
// until they are found on the employer's own page.
const AGGREGATOR_HOST_RE = /(^|\.)(builtin\.com|remote\.com|remoteotter\.com|jobleads\.com|keywordise\.com|hirocareers\.com|aipplify\.com|linkedin\.com|indeed\.com|glassdoor\.com|ziprecruiter\.com|wellfound\.com|angel\.co|naukri\.com|instahyre\.com|cutshort\.io|internshala\.com|simplyhired\.com|monster\.com|jooble\.org|adzuna\.com|talent\.com|jobrapido\.com|lensa\.com|himalayas\.app|weworkremotely\.com|remoteok\.com|remotive\.com|workingnomads\.com|dice\.com)$/i;
const JOB_SEGMENT_RE =/^(jobs?|careers?|positions?|openings?|vacanc(?:y|ies)|opportunit(?:y|ies)|roles?|apply)$/i;
const LOCALE_SEGMENT_RE = /^[a-z]{2}(?:-[a-z]{2})?$/i;
const JOB_PARAMS = ['gh_jid', 'jid', 'jobid', 'job_id'];

// Same reading of a remote marker as the scanner's titleSignalsRemote: "remote"
// must end the title, be followed by punctuation, or by " in ...", and a
// negation before it ("Non-Remote") wins.
const REMOTE_RE = /(?<![a-z])remote(?=$|\s*[^a-z\s]|\s+in\b)/i;
const NOT_REMOTE_RE = /\b(?:non|not|no)[^a-z]*remote/i;

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Keep only plain domain / path-prefix entries (Exa accepts "host", "host/path", "*.host"). */
function domainList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((d) => typeof d === 'string')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0 && d.length <= 120 && /^[a-z0-9.*/_-]+$/.test(d))
    .slice(0, 20);
}

function redact(message, secret) {
  let out = String(message ?? '');
  if (typeof secret === 'string' && secret.length >= 6) out = out.split(secret).join('«redacted»');
  return out.slice(0, 300);
}

function titleCase(text) {
  return text.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function safeDecode(segment) {
  try { return decodeURIComponent(segment); } catch { return segment; }
}

/**
 * Whether a URL looks like one specific posting rather than a blog post, a
 * careers index or an ATS board index. Heuristic, deliberately conservative
 * about what it lets through: a wrong "no" costs one lead, a wrong "yes" costs
 * an evaluation of a page that is not a job description.
 * @param {URL} u
 */
function looksLikePosting(u) {
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean);
  const paramNames = [...u.searchParams.keys()].map((k) => k.toLowerCase());
  if (JOB_PARAMS.some((p) => paramNames.includes(p))) return true;
  if (ATS_HOST_RE.test(host)) return segs.length >= 2;
  if (/^(jobs|careers|apply)\./.test(host)) {
    return segs.length >= 1 && !(segs.length === 1 && LOCALE_SEGMENT_RE.test(segs[0]));
  }
  const at = segs.findIndex((s) => JOB_SEGMENT_RE.test(s));
  return at !== -1 && segs.length > at + 1;
}

/**
 * Employer name from the posting URL (ATS slug) or, failing that, the title
 * ("... at Acme", "... @ Acme"), or finally the site's own domain.
 * @param {URL} u
 * @param {string} title
 */
function companyFor(u, title) {
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean).map(safeDecode);
  const firstLabel = host.split('.')[0];
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const slug = segs[0] === 'embed' ? u.searchParams.get('for') : segs[0];
    if (slug) return titleCase(slug);
  } else if (/(^|\.)(lever\.co|ashbyhq\.com|smartrecruiters\.com|rippling\.com|pinpointhq\.com)$/.test(host) || host === 'apply.workable.com') {
    if (segs[0]) return titleCase(segs[0]);
  } else if (/(^|\.)(bamboohr\.com|teamtailor\.com|breezy\.hr|recruitee\.com|myworkdayjobs\.com)$/.test(host)) {
    if (firstLabel && firstLabel !== 'www') return titleCase(firstLabel);
  }
  if (!AGGREGATOR_HOST_RE.test(host)) {
    const fromTitle = title.match(/\b(?:at|@)\s+(.+?)(?=\s[-–—|]\s|$)/i);
    if (fromTitle && fromTitle[1].trim()) return fromTitle[1].trim().slice(0, 100);
  }
  const labels = host.replace(/^(www|careers|jobs|apply|boards)\./, '').split('.');
  if (labels.length >= 3 && labels[labels.length - 1].length === 2 && ['co', 'com', 'org', 'net'].includes(labels[labels.length - 2])) {
    return titleCase(labels[labels.length - 3]);
  }
  return labels.length >= 2 ? titleCase(labels[labels.length - 2]) : titleCase(labels[0] || '');
}

/** Exa returns no structured location, so only an explicit remote marker in the title is used. */
function locationFromTitle(title) {
  return REMOTE_RE.test(title) && !NOT_REMOTE_RE.test(title) ? 'Remote' : '';
}

export default {
  /**
   * @param {string} query one natural-language search, e.g. a posting-style phrase
   * @param {any} ctx engine context (fetch, env, settings, log, normalizePostingUrl)
   * @returns {Promise<Array<{title: string, url: string, company: string, location: string}>>}
   */
  async search(query, ctx) {
    const q = typeof query === 'string' ? query.trim().replace(/\s+/g, ' ') : '';
    if (!q) throw new Error('exa search needs a query: node plugins.mjs run exa search "<query>"');
    const apiKey = ctx?.env?.EXA_API_KEY;
    if (!apiKey) throw new Error('EXA_API_KEY is missing. Add it to your .env.');

    const settings = ctx.settings || {};
    const body = {
      query: q.slice(0, MAX_QUERY_CHARS),
      type: ALLOWED_TYPES.has(settings.type) ? settings.type : 'auto',
      numResults: clampInt(settings.numResults, 1, MAX_NUM_RESULTS, DEFAULT_NUM_RESULTS),
      // No `contents` option: Exa then returns only title, url and date, which is
      // all this plugin reads, and the request stays as small as it can be.
    };
    const include = domainList(settings.includeDomains);
    const exclude = domainList(settings.excludeDomains);
    if (include.length) body.includeDomains = include;
    if (exclude.length) body.excludeDomains = exclude;
    const maxAgeDays = clampInt(settings.maxAgeDays, 0, 3650, 0);
    if (maxAgeDays > 0) body.startPublishedDate = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    if (typeof settings.userLocation === 'string' && /^[A-Za-z]{2}$/.test(settings.userLocation.trim())) {
      body.userLocation = settings.userLocation.trim().toUpperCase();
    }

    if (typeof ctx.log === 'function') ctx.log(`exa: searching (${body.type}, up to ${body.numResults}): ${body.query}`);

    let data;
    let lastErr = null;
    for (let attempt = 0; attempt < ATTEMPT_TIMEOUTS_MS.length; attempt++) {
      try {
        const res = await ctx.fetch(EXA_SEARCH_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
          body: JSON.stringify(body),
          timeoutMs: ATTEMPT_TIMEOUTS_MS[attempt],
        });
        data = await res.json();
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        // Retry only a slow or dropped connection, never an HTTP error or a bad key.
        const text = `${err?.name ?? ''} ${err instanceof Error ? err.message : err} ${err?.cause?.code ?? ''}`;
        const transient = err?.status === undefined && /AbortError|aborted|fetch failed|timed out|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(text);
        if (!transient || attempt === ATTEMPT_TIMEOUTS_MS.length - 1) break;
        if (typeof ctx.log === 'function') ctx.log('exa: slow connection, retrying once');
      }
    }
    if (lastErr) {
      throw new Error(`Exa search failed: ${redact(lastErr instanceof Error ? lastErr.message : lastErr, apiKey)}`);
    }

    const results = Array.isArray(data?.results) ? data.results : [];
    const requireJobUrl = settings.requireJobUrl !== false;
    const seen = new Set();
    const jobs = [];
    for (const r of results) {
      const title = typeof r?.title === 'string' ? r.title.trim() : '';
      let u;
      try { u = new URL(String(r?.url ?? '')); } catch { continue; }
      if (!title || !/^https?:$/.test(u.protocol)) continue;
      if (requireJobUrl && !looksLikePosting(u)) continue;
      const key = (typeof ctx.normalizePostingUrl === 'function' ? ctx.normalizePostingUrl(u.href) : '') || u.href.split('#')[0];
      if (seen.has(key)) continue;
      seen.add(key);
      jobs.push({
        title: title.slice(0, 250),
        url: u.href,
        company: companyFor(u, title),
        location: locationFromTitle(title),
      });
    }
    return jobs;
  },
};
