# Rules

<!-- Standing rules every agent follows in this project. Owner-controlled. One rule per bullet, with its reason. -->

- The model advises, the runtime acts: a model never performs a side effect directly. Every commit, merge, push, card change and memory change goes through `mw`, so each one is checked and recorded.
- A change is done when `npx tsc --noEmit` and `npm test` pass, so nobody builds on a broken base.
- Tests assert concrete state (file contents, commits, exit codes). A test that cannot fail is a defect.
- Behaviour that needs a real service or agent CLI is labelled unverified until a live run (`MW_LIVE=1`) has passed, and the report says which, because the hermetic suite fakes those.
- The product is spelled MergeWright; the command is `mw`.
- The framework prescribes the development process, never the layout of a project's source code.
