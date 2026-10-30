# career-ops-plugin-exa

A community plugin for [career-ops](https://github.com/career-ops-hq/career-ops).

## What it does

Adds an Exa-powered `search` hook. Exa is a semantic web search API, so a query written like a job posting ("Careers page: Search Relevance Engineer, remote, vector search") can surface postings and employers that are not in your `portals.yml`. Each call runs one query and returns the postings it found. career-ops then drops anything already in your tracker, pipeline or scan history, applies `data/blacklist.md` and your `title_filter` / `location_filter`, and writes the rest to `data/pipeline.md`.

It is built for a CLI agent to drive: `skill.md` tells the agent how to turn your profile into a few well-formed queries, without sending CV text or personal details to Exa.

## Install

```bash
# Once it's in the career-ops registry:
node plugins.mjs add exa

# Before listing (install directly from the repo at a pinned commit):
node plugins.mjs add Codexnever/career-ops-plugin-exa --sha <40-hex-commit>
```

Then enable and consent. The capability card shows that it contacts `api.exa.ai` and reads `EXA_API_KEY`:

```bash
node plugins.mjs enable exa
node plugins.mjs enable exa --confirm
```

## Configure

- Put `EXA_API_KEY=...` in your `.env` (data root).
- Optional, non-secret settings go in `config/plugins.yml` under `plugins.exa`: `numResults` (1-25), `type` (`auto` or `lite`), `includeDomains`, `excludeDomains`, `maxAgeDays`, `userLocation`, `requireJobUrl`. See `skill.md` for the full block.

```bash
node plugins.mjs run exa search "<query>" --dry-run
node plugins.mjs run exa search "<query>"
```

## Limits to know about

- **Leads, not vacancies.** Exa is a search index. The plugin does not check that a role is open; run career-ops' `pipeline` mode, which does.
- **No dates or structured location.** career-ops keeps only a posting's title, URL, company, location and salary from a plugin, and Exa gives no structured location. So `max_posting_age_days` does not apply to these results and `location_filter` passes an empty location. A title that says "Remote" is read as remote.
- **Heuristic filtering.** With `requireJobUrl` on (default), results whose URL does not look like a single posting (blogs, careers index pages, ATS board indexes) are dropped. Turn it off to keep everything.
- **Aggregator results.** Job boards that re-list employers' postings (Built In, Remote.com, LinkedIn and similar) can appear. Career Ops treats them as unconfirmed until the role is found on the employer's own page, and its `pipeline` mode does that. To keep them out, set `includeDomains` to employer job boards such as `jobs.ashbyhq.com`, `job-boards.greenhouse.io` and `jobs.lever.co`; that also hides employers on their own sites or on Workday.
- **Company names** come from the ATS slug, the title ("... at Acme") or the site's domain, so they can be rough. For known aggregators the title is not used, and the board's own name is shown instead.
- **Slow connections are retried once.** If the first request to Exa times out or drops, the plugin tries again, and both attempts fit inside Career Ops' 15 s hook limit. If the first request did reach Exa, you may be billed for both.
- **Every query is billed by Exa.** One call is one request. In one test, a 3-result search cost about $0.007; check Exa's current rates, as they can change.
- It never applies to jobs.

## Get it listed as approved

Publish this as its own public repo named `career-ops-plugin-exa`, file a Plugin registration issue, and open a registry PR as described in
[docs/PLUGINS.md](https://github.com/career-ops-hq/career-ops/blob/main/docs/PLUGINS.md).

## License

MIT
