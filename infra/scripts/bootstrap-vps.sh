#!/usr/bin/env bash
# rootcamp: готовит VPS к песочницам (spec §6.3, §11.2; docs/deploy/vps.md §13).
# Запуск на сервере из корня репозитория:  sudo bash infra/scripts/bootstrap-vps.sh
# Проверка результата:                     sudo bash infra/scripts/test/bootstrap-check.sh
#
# Идемпотентен: каждый шаг сначала сверяет состояние и печатает «ok», если менять нечего,
# или «changed», если поменял. Повторный запуск печатает только «ok».
#
# Что делает:
#   - Docker Engine из apt-репозитория Docker версии DOCKER_VERSION (infra/versions.env)
#     и держит её (apt-mark hold docker-ce docker-ce-cli): обновление — вручную, spec §11.5;
#   - /etc/docker/daemon.json (остальные ключи не трогает):
#       runtimes.sysbox-runc;
#       bip и default-address-pools — без них установщик Sysbox хочет перезапустить Docker и
#         отказывается ставиться, пока есть хоть один контейнер, даже остановленный;
#         значения — нынешние умолчания Docker без 172.30.0.0/16 (там сеть rc-sbx);
#       features.time-namespaces=false — с Docker ≥ 29.5 sysbox-runc иначе не создаёт
#         контейнеры («namespace {"time" ""} does not exist», nestybox/sysbox#1011);
#   - Sysbox CE .deb версии SYSBOX_VERSION, sha256 сверяется с SYSBOX_DEB_SHA256, и drop-in
#     Restart=on-failure для sysbox-fs (иногда зависает при старте, nestybox/sysbox#1047);
#   - swap: /swapfile на 2 ГБ (существующий файл увеличивается на месте, второй не создаётся);
#   - сеть rc-sbx (bridge, internal, enable_icc=false, 172.30.0.0/24, шлюз 172.30.0.1, мост rc-sbx0);
#   - файрвол: /opt/rootcamp/rc-sbx{,6}.rules и rc-sbx-jumps.sh, юнит rc-sbx-firewall.service;
#   - ufw: разрешает 22, 80, 443/tcp; unattended-upgrades включён; deploy в группе docker.
# Чего не делает (решения пользователя R-M4b-2, R-M4b-3): не трогает /etc/ssh, не включает
# автоперезагрузку unattended-upgrades, не удаляет правила ufw.
#
# Docker перезапускается только после изменения daemon.json или версии Docker. Если при этом
# работают контейнеры, скрипт ничего не меняет и просит сначала их остановить (стенд:
# `docker compose -p rootcamp … stop` — данные в томах сохраняются, потом `… up -d`).
# RC_BOOTSTRAP_ALLOW_DOCKER_RESTART=1 — перезапустить Docker вместе с работающими контейнерами.
set -euo pipefail

NETWORK=rc-sbx
BRIDGE=rc-sbx0
SUBNET=172.30.0.0/24
GATEWAY=172.30.0.1
SWAPFILE=/swapfile
SWAP_BYTES=$((2 * 1024 * 1024 * 1024))
OPT_DIR=/opt/rootcamp
UNIT=rc-sbx-firewall.service
DAEMON_JSON=/etc/docker/daemon.json
STATE_DIR=/var/lib/rootcamp
RESTART_MARK=$STATE_DIR/docker-restart-pending
DEB_CACHE=/var/cache/rootcamp
SYSBOX_FS_DROPIN=/etc/systemd/system/sysbox-fs.service.d/10-rootcamp-restart.conf
# Docker's built-in local address pools (v29) without 172.30.0.0/16, which is left to rc-sbx.
DEFAULT_POOLS='[{"base":"172.17.0.0/16","size":16},{"base":"172.18.0.0/16","size":16},{"base":"172.19.0.0/16","size":16},{"base":"172.20.0.0/14","size":16},{"base":"172.24.0.0/14","size":16},{"base":"172.28.0.0/15","size":16},{"base":"172.31.0.0/16","size":16},{"base":"192.168.0.0/16","size":20}]'

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
versions_file="$repo_root/infra/versions.env"

export DEBIAN_FRONTEND=noninteractive
# needrestart (Ubuntu 24.04) would otherwise restart services after apt on its own.
export NEEDRESTART_MODE=l
APT_INSTALL=(-y -q -o DPkg::Lock::Timeout=300 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)

changes=0
say() { printf '%-8s %s\n' "$1" "$2"; }
ok() { say ok "$1"; }
changed() {
  say changed "$1"
  changes=$((changes + 1))
}
warn() { say warn "$1"; }
die() {
  printf 'ОШИБКА: %s\n' "$1" >&2
  exit 1
}
version_of() { sed -n "s/^$1=//p" "$versions_file" | tail -n 1; }
pkg_installed() { [[ $(dpkg-query -W -f='${Status}' "$1" 2>/dev/null || true) == "install ok installed" ]]; }
# install_file <src> <dst> <mode>: copies when the content or the mode differs; 0 = copied.
install_file() {
  if [[ -f $2 ]] && cmp -s "$1" "$2" && [[ $(stat -c %a "$2") == "$3" ]]; then return 1; fi
  install -D -m "$3" "$1" "$2"
}
wait_for_docker() {
  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  die "Docker не отвечает через минуту после запуска (journalctl -u docker)"
}

# ---------------------------------------------------------------- проверки до изменений
[[ $EUID -eq 0 ]] || die "запустите через sudo"
# shellcheck source=/dev/null
. /etc/os-release
[[ ${ID:-} == ubuntu && ${VERSION_CODENAME:-} == noble ]] || die "нужна Ubuntu 24.04 (noble), а здесь ${PRETTY_NAME:-неизвестно что}"
IFS=. read -r kernel_major kernel_minor _ <<<"$(uname -r)"
((kernel_major > 6 || (kernel_major == 6 && kernel_minor >= 8))) || die "Sysbox на Ubuntu 24.04 нужно ядро 6.8+, а здесь $(uname -r)"
[[ $(dpkg --print-architecture) == amd64 ]] || die "скрипт ставит пакет Sysbox для amd64, а здесь $(dpkg --print-architecture)"

DOCKER_VERSION=$(version_of DOCKER_VERSION)
SYSBOX_VERSION=$(version_of SYSBOX_VERSION)
SYSBOX_DEB_SHA256=$(version_of SYSBOX_DEB_SHA256)
[[ $DOCKER_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "в $versions_file нет DOCKER_VERSION вида 29.9.2"
[[ $SYSBOX_VERSION =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "в $versions_file нет SYSBOX_VERSION вида 0.7.1"
[[ $SYSBOX_DEB_SHA256 =~ ^[0-9a-f]{64}$ ]] || die "в $versions_file нет SYSBOX_DEB_SHA256 (64 hex)"
echo "== rootcamp bootstrap: Docker $DOCKER_VERSION, Sysbox CE $SYSBOX_VERSION"

# ---------------------------------------------------------------- пакеты и репозиторий Docker
missing=()
for p in ca-certificates curl jq ufw unattended-upgrades iptables; do
  pkg_installed "$p" || missing+=("$p")
done
if ((${#missing[@]})); then
  apt-get update -q
  apt-get install "${APT_INSTALL[@]}" "${missing[@]}"
  changed "установлены пакеты: ${missing[*]}"
else
  ok "базовые пакеты (curl, jq, ufw, unattended-upgrades, iptables)"
fi

if grep -qs 'download.docker.com/linux/ubuntu' /etc/apt/sources.list.d/*; then
  ok "apt-репозиторий Docker подключён"
else
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  changed "подключён apt-репозиторий Docker"
fi

# Нужная сборка docker-ce (например 5:29.9.2-1~ubuntu.24.04~noble); пусто — уже стоит.
docker_target=""
if [[ $(dpkg-query -W -f='${Version}' docker-ce 2>/dev/null || true) != 5:"$DOCKER_VERSION"-* ]]; then
  find_build() { apt-cache madison docker-ce | awk -v want="5:$DOCKER_VERSION-" 'index($3, want) == 1 { print $3; exit }'; }
  docker_target=$(find_build)
  if [[ -z $docker_target ]]; then
    apt-get update -q
    docker_target=$(find_build)
  fi
  [[ -n $docker_target ]] || die "в репозитории Docker нет docker-ce $DOCKER_VERSION"
fi

# ---------------------------------------------------------------- daemon.json: что должно быть
current_json='{}'
if [[ -s $DAEMON_JSON ]]; then current_json=$(cat "$DAEMON_JSON"); fi
jq -e . >/dev/null <<<"$current_json" || die "$DAEMON_JSON — не JSON, поправьте его руками"
desired_json=$(jq --argjson pools "$DEFAULT_POOLS" '
    .runtimes["sysbox-runc"].path = "/usr/bin/sysbox-runc"
  | .bip = (.bip // "172.17.0.1/16")
  | ."default-address-pools" = (."default-address-pools" // $pools)
  | .features["time-namespaces"] = false
' <<<"$current_json")
daemon_json_differs=0
if [[ $(jq -S . <<<"$current_json") != "$(jq -S . <<<"$desired_json")" ]]; then daemon_json_differs=1; fi

# ---------------------------------------------------------------- можно ли перезапускать Docker
docker_running=0
if pkg_installed docker-ce && docker info >/dev/null 2>&1; then docker_running=1; fi
restart_reasons=()
((daemon_json_differs)) && restart_reasons+=("меняется $DAEMON_JSON")
[[ -n $docker_target ]] && pkg_installed docker-ce && restart_reasons+=("меняется версия Docker на $DOCKER_VERSION")
[[ -e $RESTART_MARK ]] && restart_reasons+=("прошлый запуск не успел перезапустить Docker")
if ((${#restart_reasons[@]})) && ((docker_running)) && [[ ${RC_BOOTSTRAP_ALLOW_DOCKER_RESTART:-0} != 1 ]]; then
  running=$(docker ps --format '{{.Names}}')
  if [[ -n $running ]]; then
    printf 'Нужен перезапуск Docker (%s), а работают контейнеры:\n%s\n' "${restart_reasons[*]}" "$running" >&2
    die "остановите их (стенд: docker compose -p rootcamp --env-file infra/versions.env --env-file infra/vps.env -f infra/compose.yaml -f infra/compose.vps-test.yaml stop) и запустите скрипт снова; ничего не изменено"
  fi
fi

sysbox_installed=$(dpkg-query -W -f='${Version}' sysbox-ce 2>/dev/null || true)
sysbox_matches() { [[ $1 == "$SYSBOX_VERSION" || $1 == "$SYSBOX_VERSION".* || $1 == "$SYSBOX_VERSION"-* ]]; }
if [[ -n $sysbox_installed ]] && ! sysbox_matches "$sysbox_installed" && ((docker_running)); then
  for id in $(docker ps -q); do
    if [[ $(docker inspect -f '{{.HostConfig.Runtime}}' "$id") == sysbox-runc ]]; then
      die "стоит Sysbox $sysbox_installed, а нужен $SYSBOX_VERSION: сначала остановите контейнеры sysbox-runc (песочницы: sandboxes:drain, spec §11.5)"
    fi
  done
fi

mkdir -p "$STATE_DIR"

# ---------------------------------------------------------------- Docker Engine
if [[ -n $docker_target ]]; then
  touch "$RESTART_MARK"
  apt-get install "${APT_INSTALL[@]}" --allow-downgrades --allow-change-held-packages \
    "docker-ce=$docker_target" "docker-ce-cli=$docker_target" containerd.io docker-buildx-plugin docker-compose-plugin
  changed "Docker Engine $docker_target"
else
  ok "Docker Engine $DOCKER_VERSION"
fi
held=$(apt-mark showhold)
if grep -qx docker-ce <<<"$held" && grep -qx docker-ce-cli <<<"$held"; then
  ok "docker-ce и docker-ce-cli закреплены (apt-mark hold)"
else
  apt-mark hold docker-ce docker-ce-cli >/dev/null
  changed "docker-ce и docker-ce-cli закреплены (apt-mark hold)"
fi
systemctl is-enabled --quiet docker || {
  systemctl enable docker
  changed "docker.service в автозапуске"
}

# ---------------------------------------------------------------- ufw
ufw_added=()
for rule in OpenSSH 80/tcp 443/tcp; do
  out=$(ufw allow "$rule" 2>&1)
  if grep -qv '^Skipping adding existing rule' <<<"$out"; then ufw_added+=("$rule"); fi
done
if ((${#ufw_added[@]})); then changed "ufw: разрешены ${ufw_added[*]}"; else ok "ufw: 22 (OpenSSH), 80/tcp, 443/tcp уже разрешены"; fi
if ufw status | grep -q '^Status: active'; then
  ok "ufw включён"
else
  ufw --force enable >/dev/null
  changed "ufw включён"
fi

# ---------------------------------------------------------------- unattended-upgrades (без автоперезагрузки)
if apt-config dump | grep -qx 'APT::Periodic::Update-Package-Lists "1";' &&
  apt-config dump | grep -qx 'APT::Periodic::Unattended-Upgrade "1";'; then
  ok "unattended-upgrades настроен (20auto-upgrades)"
else
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' >/etc/apt/apt.conf.d/20auto-upgrades
  changed "unattended-upgrades: записан 20auto-upgrades"
fi
if systemctl is-enabled --quiet unattended-upgrades && systemctl is-active --quiet unattended-upgrades; then
  ok "служба unattended-upgrades включена"
else
  systemctl enable --now unattended-upgrades
  changed "служба unattended-upgrades включена"
fi
if apt-config dump | grep -qiE '^Unattended-Upgrade::Automatic-Reboot "(1|true|yes)";'; then
  warn "включена автоперезагрузка unattended-upgrades, а решение R-M4b-2 — без неё; скрипт её не трогает"
fi

# ---------------------------------------------------------------- пользователь deploy
if id deploy >/dev/null 2>&1; then
  if id -nG deploy | tr ' ' '\n' | grep -qx docker; then
    ok "deploy в группе docker"
  else
    usermod -aG docker deploy
    changed "deploy добавлен в группу docker"
  fi
else
  warn "пользователя deploy нет: создайте его по docs/deploy/vps.md §2 и запустите скрипт снова"
fi

# ---------------------------------------------------------------- swap 2 ГБ
swap_size=$(stat -c %s "$SWAPFILE" 2>/dev/null || echo 0)
swap_active=0
if grep -q "^$SWAPFILE " /proc/swaps; then swap_active=1; fi
if [[ $swap_size -eq $SWAP_BYTES && $swap_active -eq 1 ]]; then
  ok "swap: $SWAPFILE на 2 ГБ включён"
else
  if [[ $swap_size -ne $SWAP_BYTES ]]; then
    if ((swap_active)); then
      used_kb=$(awk -v f="$SWAPFILE" '$1 == f { print $4 }' /proc/swaps)
      avail_kb=$(awk '/^MemAvailable:/ { print $2 }' /proc/meminfo)
      ((avail_kb > used_kb + 262144)) || die "чтобы увеличить swap, его надо выключить, а свободной памяти мало (MemAvailable ${avail_kb} КБ, в swap ${used_kb} КБ)"
      swapoff "$SWAPFILE"
    fi
    if [[ $swap_size -gt $SWAP_BYTES ]]; then truncate -s "$SWAP_BYTES" "$SWAPFILE"; fi
    fallocate -l "$SWAP_BYTES" "$SWAPFILE" 2>/dev/null ||
      dd if=/dev/zero of="$SWAPFILE" bs=1M count=$((SWAP_BYTES / 1024 / 1024)) status=none
    chmod 600 "$SWAPFILE"
    mkswap "$SWAPFILE" >/dev/null
  fi
  chmod 600 "$SWAPFILE"
  swapon "$SWAPFILE" 2>/dev/null || {
    mkswap "$SWAPFILE" >/dev/null
    swapon "$SWAPFILE"
  }
  changed "swap: $SWAPFILE — 2 ГБ, включён (было $swap_size байт)"
fi
if grep -qE "^${SWAPFILE}[[:space:]]" /etc/fstab; then
  ok "swap: $SWAPFILE в /etc/fstab"
else
  echo "$SWAPFILE none swap sw 0 0" >>/etc/fstab
  changed "swap: $SWAPFILE добавлен в /etc/fstab"
fi

# ---------------------------------------------------------------- daemon.json
if ((daemon_json_differs)); then
  touch "$RESTART_MARK"
  install -d -m 0755 "$(dirname "$DAEMON_JSON")"
  if [[ -f $DAEMON_JSON ]]; then cp -a "$DAEMON_JSON" "$DAEMON_JSON.rootcamp-$(date +%Y%m%d-%H%M%S).bak"; fi
  printf '%s\n' "$desired_json" >"$DAEMON_JSON.tmp"
  mv "$DAEMON_JSON.tmp" "$DAEMON_JSON"
  changed "$DAEMON_JSON: sysbox-runc, bip, default-address-pools, features.time-namespaces=false"
else
  ok "$DAEMON_JSON уже настроен"
fi

# ---------------------------------------------------------------- Sysbox CE
dropin=$(mktemp)
printf '# rootcamp: sysbox-fs sometimes hangs at start (nestybox/sysbox#1047)\n[Service]\nRestart=on-failure\nRestartSec=1\n' >"$dropin"
if install_file "$dropin" "$SYSBOX_FS_DROPIN" 644; then
  systemctl daemon-reload
  changed "sysbox-fs: drop-in Restart=on-failure"
else
  ok "sysbox-fs: drop-in Restart=on-failure"
fi
rm -f "$dropin"

if [[ -n $sysbox_installed ]] && sysbox_matches "$sysbox_installed"; then
  ok "Sysbox CE $sysbox_installed установлен"
else
  if [[ -n $sysbox_installed ]]; then
    apt-get purge "${APT_INSTALL[@]}" sysbox-ce
    changed "удалён Sysbox CE $sysbox_installed (обновление: сначала удалить, потом ставить)"
  fi
  deb="$DEB_CACHE/sysbox-ce_${SYSBOX_VERSION}.linux_amd64.deb"
  install -d -m 0755 "$DEB_CACHE"
  if ! sha256sum --status -c <<<"$SYSBOX_DEB_SHA256  $deb" 2>/dev/null; then
    curl -fsSL --retry 3 -o "$deb.part" \
      "https://github.com/nestybox/sysbox/releases/download/v$SYSBOX_VERSION/sysbox-ce_${SYSBOX_VERSION}.linux_amd64.deb"
    mv "$deb.part" "$deb"
    chmod 644 "$deb"
  fi
  sha256sum --status -c <<<"$SYSBOX_DEB_SHA256  $deb" || {
    rm -f "$deb"
    die "sha256 скачанного $deb не совпадает с SYSBOX_DEB_SHA256"
  }
  apt-get install "${APT_INSTALL[@]}" "$deb"
  sysbox_installed=$(dpkg-query -W -f='${Version}' sysbox-ce)
  sysbox_matches "$sysbox_installed" || die "после установки sysbox-ce версии $sysbox_installed, а нужна $SYSBOX_VERSION"
  changed "установлен Sysbox CE $sysbox_installed"
fi
for svc in sysbox-mgr sysbox-fs sysbox; do
  if ! systemctl is-active --quiet "$svc"; then
    systemctl restart sysbox
    changed "перезапущен sysbox ($svc не работал)"
    break
  fi
done

# ---------------------------------------------------------------- перезапуск Docker
if [[ -e $RESTART_MARK ]]; then
  systemctl restart docker
  wait_for_docker
  rm -f "$RESTART_MARK"
  changed "Docker перезапущен с новым $DAEMON_JSON"
fi
wait_for_docker
docker info --format '{{json .Runtimes}}' | jq -e 'has("sysbox-runc")' >/dev/null ||
  die "Docker не видит runtime sysbox-runc (docker info); проверьте $DAEMON_JSON и journalctl -u docker"
ok "Docker видит runtime sysbox-runc"

# ---------------------------------------------------------------- сеть rc-sbx
expected_net="bridge|true|false|$BRIDGE|$SUBNET $GATEWAY;"
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  actual_net=$(docker network inspect "$NETWORK" --format \
    '{{.Driver}}|{{.Internal}}|{{index .Options "com.docker.network.bridge.enable_icc"}}|{{index .Options "com.docker.network.bridge.name"}}|{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}};{{end}}')
  [[ $actual_net == "$expected_net" ]] ||
    die "сеть $NETWORK уже есть, но с другими параметрами ($actual_net); при остановленных песочницах удалите её (docker network rm $NETWORK) и запустите скрипт снова"
  ok "сеть $NETWORK ($SUBNET, шлюз $GATEWAY, internal, без icc, мост $BRIDGE)"
else
  docker network create --driver bridge --internal \
    --subnet "$SUBNET" --gateway "$GATEWAY" \
    --opt com.docker.network.bridge.enable_icc=false \
    --opt com.docker.network.bridge.name="$BRIDGE" \
    --label rootcamp.network=sandbox "$NETWORK" >/dev/null
  changed "создана сеть $NETWORK ($SUBNET, шлюз $GATEWAY, internal, без icc, мост $BRIDGE)"
fi

# ---------------------------------------------------------------- файрвол песочниц
fw_files_changed=0
if install_file "$repo_root/infra/iptables/rc-sbx.rules" "$OPT_DIR/rc-sbx.rules" 644; then fw_files_changed=1; fi
if install_file "$repo_root/infra/iptables/rc-sbx6.rules" "$OPT_DIR/rc-sbx6.rules" 644; then fw_files_changed=1; fi
if install_file "$repo_root/infra/iptables/rc-sbx-jumps.sh" "$OPT_DIR/rc-sbx-jumps.sh" 755; then fw_files_changed=1; fi
if install_file "$repo_root/infra/systemd/$UNIT" "/etc/systemd/system/$UNIT" 644; then
  fw_files_changed=1
  systemctl daemon-reload
fi
if ((fw_files_changed)); then changed "файлы файрвола в $OPT_DIR и /etc/systemd/system/$UNIT"; else ok "файлы файрвола на месте"; fi
if systemctl is-enabled --quiet "$UNIT"; then
  ok "$UNIT включён (WantedBy=docker.service)"
else
  systemctl enable "$UNIT"
  changed "$UNIT включён (WantedBy=docker.service)"
fi
if ((fw_files_changed)) || ! systemctl is-active --quiet "$UNIT" ||
  ! iptables -C INPUT -i "$BRIDGE" -j RC-SBX-INPUT 2>/dev/null ||
  ! iptables -C DOCKER-USER -s "$SUBNET" -j RC-SBX-FORWARD 2>/dev/null; then
  systemctl restart "$UNIT"
  changed "правила rc-sbx применены ($UNIT)"
else
  ok "правила rc-sbx применены ($UNIT активен)"
fi

echo
if ((changes)); then echo "Готово: изменений — $changes."; else echo "Готово: ничего менять не пришлось."; fi
