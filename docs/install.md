# Installing

MergeWright needs git, one agent CLI (Claude Code or Codex) and either Node 24 or newer or the
single executable. Pick one install form:

| Form | How | When |
|---|---|---|
| From a checkout | `scripts/install.sh` copies the committed runtime to `~/.local/share/mergewright` and puts `mw` in `~/.local/bin`; run it again after pulling to update | Working on MergeWright itself |
| npm package | `npm i -g mergewright` (or a `.tgz` from `npm pack`) | Machines with Node 24 |
| Single executable, released | `scripts/install-binary.sh` downloads the release's `mw` for this machine and checks it (below) | Machines without Node: Linux x64 and arm64, Apple-silicon macOS |
| Single executable, built here | `scripts/build-binary.sh` (or `npm run build:binary`) makes `build/mw-<platform>-<arch>`, with `build/mw` a symbolic link to it and `build/SHA256SUMS` beside them; the result needs no Node | Building for this machine's platform (it cannot cross-build) |

Then `mw init` in any repository makes it a MergeWright project; `mw version` says which build is
running and `mw doctor` checks the machine and the project.

## Installing a released binary

`scripts/install-binary.sh` installs the single executable from a release. Download it, read it,
then run it with `sh`:

```bash
curl -fsSLO https://raw.githubusercontent.com/manxzo/mergewright/main/scripts/install-binary.sh
less install-binary.sh
sh install-binary.sh
```

It picks the asset for this machine (`mw-linux-x64`, `mw-linux-arm64` or `mw-darwin-arm64`; there is
none for Intel Macs, Windows or other processors, which install with `npm i -g mergewright` on Node 24
instead), downloads it with the release's `SHA256SUMS`, refuses to install when the checksum does
not match, and puts it at `$MW_INSTALL_DIR/mw`. Nothing else is changed. It reads three variables:

| Variable | Default | Means |
|---|---|---|
| `MW_REPO` | `manxzo/mergewright` | The GitHub repository to install from |
| `MW_BASE_URL` | that repository's latest release | Where the assets and `SHA256SUMS` are (another release, or a mirror) |
| `MW_INSTALL_DIR` | `~/.local/bin` | Where `mw` goes; the script says so when it is not on `PATH` |

`npm run test:release` (`MW_RELEASE_TEST=1 node --test test/release.test.ts`) checks a built binary.

## Unattended work as a service

| Script | Does |
|---|---|
| `scripts/install-service.sh` | `sudo scripts/install-service.sh work <name>` (or `mw-work <name>`, the unit's own name; both are accepted) writes `/etc/systemd/system/mw-work@.service` for this user, home and PATH, then enables and restarts `mw-work@<name>` for `~/workspace/<name>`. `--help` prints the usage without root, and a wrong first argument is refused (exit 2) before root is checked. The `mw-work@` unit file is shared by every project on the machine: when it already existed, the script says it was rewritten and that the other `mw-work@` instances pick it up on their next restart. `sudo scripts/install-service.sh unit` only rewrites that shared file from `ops/` and runs `systemctl daemon-reload`, restarting nothing (`unit --check`, without root, exits 1 when the installed copy differs or a loaded `mw-work@<project>` instance reports `NeedDaemonReload=yes`; `unit` reloads systemd also when the file is already up to date, so a rerun repairs a reload that failed); `scripts/install.sh` runs both after installing the runtime, the update through passwordless sudo, or prints the command. The unit has `KillMode=mixed`: a `systemctl stop` or `restart` signals only `mw work`, which waits for the current card to finish (up to `TimeoutStopSec`, 4 hours; `restart --no-block` does not wait for it, and the script restarts its instance that way) and exits 0, while the agent, gate and delivery processes keep running. To stop at once, `systemctl stop --no-block mw-work@<name>` and then `systemctl kill --kill-whom=main -s SIGINT mw-work@<name>`: the second signal stops the current phase, and the card continues from its last finished phase on the next run. `mw doctor` in a project names the `mw-work@<folder name>` unit and whether it is active. |

## Never automated

- **Logins.** `claude` (run it once) and `codex login`; `hermes setup` only if you use Hermes.
- **Hermes per project (optional).** `mw add hermes` (the official package), then `mw hermes init`,
  inside each project that Hermes drives or whose roles run on Hermes.
- **AppArmor.** On Ubuntu 24.04 and later, AppArmor restricts unprivileged user namespaces, which
  bubblewrap sandboxes (Codex, Claude Code) use. If a sandbox fails with a uid-map permission
  error, deciding whether to allow them (a profile for the tool, or the
  `kernel.apparmor_restrict_unprivileged_userns` sysctl) is yours; no script changes it.
- **sudoers.** No script edits sudoers or adds passwordless rules; steps that need root call
  `sudo` and ask first.

## Secrets

`~/.config/mergewright/env` (mode 600, outside every repository and synced folder) holds the
client keys `mw` reads, for example `GITEA_TOKEN` and `GITHUB_TOKEN`. MergeWright names a secret by
its variable, never by its value, in its output, its files and its logs.
