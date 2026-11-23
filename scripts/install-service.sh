#!/usr/bin/env bash
# Install one of the service units in ops/ for THIS user and machine (the units in the repository
# are templates; this fills in the __USER__ and __HOME__ placeholders, which also set PATH).
#
#   sudo scripts/install-service.sh work|mw-work <project-folder-name>   unattended work for ~/workspace/<name>
#   sudo scripts/install-service.sh unit                                 rewrite the shared mw-work@ unit from ops/
#                                                                        (when it differs) and always reload systemd;
#                                                                        restarts nothing
#   scripts/install-service.sh unit --check                              exit 0 when the installed unit matches ops/
#                                                                        and no loaded mw-work@<project> instance
#                                                                        needs a reload (or none is installed),
#                                                                        1 otherwise
#   scripts/install-service.sh --help                                    this usage (no root needed)
set -euo pipefail
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
kind=${1:-}; arg=${2:-}
usage="usage: sudo scripts/install-service.sh work|mw-work <project> | unit [--check]
  work, mw-work  install the mw-work@<project> unit (unattended 'mw work' for ~/workspace/<project>)
  unit [--check] rewrite the shared mw-work@ unit from ops/ and reload systemd (no restart);
                 with --check (no root needed) only say whether the installed one is out of date
                 (it differs, or a loaded mw-work@<project> instance needs a reload)"
# The argument is checked before anything else, so a wrong one is reported without root.
case $kind in
  -h|--help|help) echo "$usage"; exit 0 ;;
  work|mw-work) ;;
  unit) case $arg in ""|--check) ;; *) echo "$usage" >&2; exit 2 ;; esac ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
# MW_SYSTEMCTL exists for the tests (a fake systemctl).
if ! command -v "${MW_SYSTEMCTL:-systemctl}" >/dev/null 2>&1; then
  # Without systemd no unit is installed, so none is out of date.
  [ "$kind" = unit ] && [ "$arg" = --check ] && exit 0
  echo "install-service.sh: this system has no systemd (systemctl is not on PATH). The units in ops/ are for Linux with systemd; on this system start 'mw work' another way." >&2
  exit 1
fi
user=${SUDO_USER:-$USER}
home=$(getent passwd "$user" | cut -d: -f6)
[ -n "$home" ] || { echo "cannot find the home directory of $user" >&2; exit 1; }
render() { sed -e "s#__USER__#$user#g" -e "s#__HOME__#$home#g" "$1"; }
# MW_UNIT_DIR and MW_SYSTEMCTL exist for the tests (a temporary folder and a fake systemctl).
unit_dir=${MW_UNIT_DIR:-/etc/systemd/system}
systemctl=${MW_SYSTEMCTL:-systemctl}
work_unit=$unit_dir/mw-work@.service
if [ "$kind" = unit ] && [ "$arg" = --check ]; then
  [ -e "$work_unit" ] || exit 0
  if ! render "$repo/ops/mw-work@.service" | cmp -s - "$work_unit"; then
    echo "$work_unit differs from $repo/ops/mw-work@.service"
    exit 1
  fi
  # The file can match while systemd still runs the old one (a reload that failed or never ran).
  # NeedDaemonReload belongs to a loaded instance (systemd cannot load the template itself), so each
  # loaded mw-work@<project> instance is asked. A systemctl that fails or is missing, or no loaded
  # instance, counts as not needing a reload.
  instances=$("$systemctl" list-units --all --plain --no-legend 'mw-work@*.service' 2>/dev/null | awk '{print $1}' || true)
  for instance in $instances; do
    case $instance in mw-work@?*.service) ;; *) continue ;; esac
    if [ "$("$systemctl" show -p NeedDaemonReload --value "$instance" 2>/dev/null || true)" = yes ]; then
      echo "$work_unit matches ops/ but systemd has not reloaded it for $instance"
      exit 1
    fi
  done
  exit 0
fi
[ "$(id -u)" = 0 ] || [ -n "${MW_UNIT_DIR-}" ] || { echo "run with sudo: it writes to /etc/systemd/system" >&2; exit 1; }
case $kind in
  unit)
    # REQ-engine-011 AC-3: the unit's stop behaviour (KillMode=mixed) only takes effect once the installed
    # copy is rewritten and systemd has reloaded it; running instances use it from their next stop on.
    # The reload runs every time, also when the file is already up to date, so a rerun repairs a reload
    # that failed or was interrupted after the write. A reload is idempotent and restarts nothing.
    if [ -e "$work_unit" ] && render "$repo/ops/mw-work@.service" | cmp -s - "$work_unit"; then
      done_msg="$work_unit is up to date"
    else
      render "$repo/ops/mw-work@.service" > "$work_unit"
      done_msg="$work_unit was rewritten from ops/mw-work@.service"
    fi
    "$systemctl" daemon-reload || { echo "$done_msg, but systemctl daemon-reload failed, so systemd still uses the old unit; run this command again" >&2; exit 1; }
    echo "$done_msg and systemd reloaded it; running mw-work@ instances keep running and use it from their next stop or restart" ;;
  work|mw-work)
    [ -n "$arg" ] || { echo "give the project folder name under $home/workspace" >&2; exit 1; }
    [ -d "$home/workspace/$arg" ] || { echo "$home/workspace/$arg does not exist" >&2; exit 1; }
    unit=$work_unit
    existed=no; [ -e "$unit" ] && existed=yes
    render "$repo/ops/mw-work@.service" > "$unit"
    # --no-block: a restart waits for the instance's current card to finish (KillMode=mixed), which can take hours.
    "$systemctl" daemon-reload && "$systemctl" enable "mw-work@$arg" && "$systemctl" restart --no-block "mw-work@$arg"
    echo "mw-work@$arg is enabled (a card it is running finishes before the restart); follow it with: journalctl -u mw-work@$arg -f"
    if [ "$existed" = yes ]; then
      echo "note: the shared unit file $unit was rewritten; other mw-work@ instances pick it up on their next restart"
    fi ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
