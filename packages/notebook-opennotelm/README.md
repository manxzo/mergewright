# notebook-opennotelm

Mirrors the project's documentation (`docs.paths`, minus `docs.exclude`) into one notebook of
[OpenNoteLM](https://github.com/daozen/opennotelm). The repository stays the source of truth; the
notebook is an index of it.

**Not verified against a live instance.** This package was written from the OpenNoteLM source at
commit `c709bfa0c31641f3aecca468c8be16ebee01a353` (`backend/opennotelm/main.py`, `source_routes.py`
and `source_service.py`; the project has no API documentation) and has been tested only against a
fake server built from those shapes. It has not been run against a running OpenNoteLM. The test
`test/packages-notebook-opennotelm.test.ts` has a live case for that:
`MW_LIVE=1 MW_OPENNOTELM_URL=http://127.0.0.1:3000`.

## Setup

1. `mw add notebook-opennotelm`, then set `packages.notebook-opennotelm.url` (e.g.
   `http://127.0.0.1:3000`, where OpenNoteLM serves its page and its API). `name` is the notebook's
   title, default the project's name; the first sync creates it.
2. OpenNoteLM has no authentication and accepts only the host names in its `ALLOWED_HOSTS`
   (default `localhost,127.0.0.1,[::1]`): to reach it by another name, add that name there, and keep
   it on a private network.
3. `mw doctor` shows whether it answers. `mw notebook-opennotelm sync --all` fills the notebook.

## What it does

- Each documentation file, read as a blob of the merged commit, is one uploaded source whose file
  name is its repository path with `%` and `/` escaped: `docs/guide.md` is `docs%2Fguide.md`
  (OpenNoteLM keeps only the base name of an upload, so the path is kept in the name). A file that
  does not end in `.md`, `.markdown` or `.txt` is sent as text, with `.txt` added.
- A changed file is uploaded again only when its bytes differ from its source's (OpenNoteLM's
  SHA-256 checksum); the new version is uploaded before the old source is deleted. A deleted file's
  source is deleted. `sync --all` sends only what changed, so running it again changes nothing.
- When OpenNoteLM does not answer, the batch is queued with its commit (kind `notebook-opennotelm`)
  and `mw queue flush` sends what that commit held.
- A file OpenNoteLM refuses (a 4xx answer: too large, the notebook's source limit, ...) and an empty
  file are reported and left out, not retried. A file with the same bytes as a source OpenNoteLM
  already holds is attached to the notebook as that source, with a warning.
- The `opennotelm` check of `mw doctor` (`GET /api/health`, and whether the notebook exists).

## What it does not do

- No `searchDocs` or `ask`: OpenNoteLM has no search endpoint, and its chat
  (`POST /api/notebooks/{id}/chat`) writes into the notebook's one stored conversation and answers
  through a background job, so it is not a matching call.
- It does not wait for OpenNoteLM to ingest an upload (the ingest runs as a background job); an
  ingest that fails shows in OpenNoteLM, not here.
- `sync --all` does not remove sources of files that left the repository outside a card's merge.

## What may break

- The API is undocumented upstream; the shapes are read from the source and may change in any
  release.
- A notebook holds at most 50 sources by default (`MAX_SOURCES_PER_NOTEBOOK`); beyond that each
  further file is refused and reported. Raise the limit for a larger documentation set.
- Deleting a source deletes it from every notebook: a source another notebook attached (by the
  duplicate rule above) disappears there too.
- The escaped file name assumes OpenNoteLM keeps `%` in a multipart file name as sent (read from the
  source, not verified live).
