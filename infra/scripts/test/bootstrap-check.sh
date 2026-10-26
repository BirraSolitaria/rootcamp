#!/usr/bin/env bash
# rootcamp: проверка состояния VPS после infra/scripts/bootstrap-vps.sh (spec §6.3, §11.2).
# Запуск на сервере из корня репозитория:  sudo bash infra/scripts/test/bootstrap-check.sh
#
# По каждой проверке печатает «ok» или «FAIL» с понятной фразой. Код возврата: 0 — всё в порядке,
# 1 — есть FAIL, 2 — проверку нельзя выполнить (не root или работают песочницы, см. ниже).
#
# ВНИМАНИЕ: последняя проверка перезапускает Docker. Она убирает правила rc-sbx (как после
# перезагрузки), делает `systemctl restart docker` и ждёт, что rc-sbx-firewall.service вернёт их.
# Контейнеры стенда с `restart: unless-stopped` поднимаются сами (простой ~15 с), а песочницы
# при перезапуске погибают, поэтому при запущенных песочницах (label rootcamp.sandbox) скрипт
# не работает. RC_CHECK_SKIP_RESTART=1 пропускает эту проверку.
set -euo pipefail

NETWORK=rc-sbx
BRIDGE=rc-sbx0
SUBNET=172.30.0.0/24
GATEWAY=172.30.0.1
UNIT=rc-sbx-firewall.service
SWAPFILE=/swapfile
SWAP_BYTES=$((2 * 1024 * 1024 * 1024))
TEST_IMAGE=${RC_CHECK_IMAGE:-alpine:3.22}
IPT=/usr/sbin/iptables
IP6T=/usr/sbin/ip6tables

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
versions_file="$repo_root/infra/versions.env"

failures=0
ok() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  failures=$((failures + 1))
}
# check "<что должно быть верно>" <команда…>: команда без вывода, по коду возврата.
check() {
  local what=$1
  shift
  if "$@" >/dev/null 2>&1; then ok "$what"; else fail "$what"; fi
}
# expect_eq "<что должно быть верно>" <фактическое> <ожидаемое>
expect_eq() {
  if [[ $2 == "$3" ]]; then ok "$1"; else fail "$1 — сейчас «$2», нужно «$3»"; fi
}
version_of() { sed -n "s/^$1=//p" "$versions_file" | tail -n 1; }
# ufw_allows <варианты To через |>: в `ufw status` есть IPv4-строка «… ALLOW Anywhere».
# shellcheck disable=SC2329 # вызывается через check "…" ufw_allows
# (вывод — через here-string, не `cmd | grep -q`: при pipefail ранний выход grep -q даёт SIGPIPE)
ufw_allows() { grep -qE "^($1)[[:space:]]+ALLOW[[:space:]]+Anywhere[[:space:]]*\$" <<<"$(ufw status)"; }
# shellcheck disable=SC2329 # вызывается через check "…" unit_bound_to_docker
unit_bound_to_docker() {
  [[ $(systemctl show -p After "$UNIT") == *docker.service* && $(systemctl show -p PartOf "$UNIT") == *docker.service* ]]
}

if [[ $EUID -ne 0 ]]; then
  echo "Запустите через sudo: проверке нужны iptables и systemctl."
  exit 2
fi

skip_restart=${RC_CHECK_SKIP_RESTART:-0}
if [[ $skip_restart != 1 ]] && command -v docker >/dev/null 2>&1; then
  sandboxes=$(docker ps -q --filter label=rootcamp.sandbox 2>/dev/null | wc -l || true)
  if [[ $sandboxes -gt 0 ]]; then
    echo "Работают песочницы ($sandboxes), а проверка перезапускает Docker и убила бы их."
    echo "Дождитесь, пока их не станет, или запустите с RC_CHECK_SKIP_RESTART=1."
    exit 2
  fi
fi

echo "== Версии (infra/versions.env)"
sysbox_version=$(version_of SYSBOX_VERSION)
docker_version=$(version_of DOCKER_VERSION)
if [[ -n $sysbox_version && -n $docker_version ]]; then
  ok "в versions.env заданы SYSBOX_VERSION=$sysbox_version и DOCKER_VERSION=$docker_version"
else
  fail "в $versions_file нет SYSBOX_VERSION или DOCKER_VERSION"
fi

echo "== Docker и Sysbox"
server_version=$(docker version --format '{{.Server.Version}}' 2>/dev/null || true)
if [[ -n $docker_version && $server_version == "$docker_version" ]]; then
  ok "Docker Engine $server_version, как в versions.env"
else
  fail "Docker Engine «$server_version», а в versions.env «$docker_version»"
fi
installed_sysbox=$(dpkg-query -W -f='${Version}' sysbox-ce 2>/dev/null || true)
if [[ -n $sysbox_version && ($installed_sysbox == "$sysbox_version" || $installed_sysbox == "$sysbox_version".* || $installed_sysbox == "$sysbox_version"-*) ]]; then
  ok "пакет sysbox-ce $installed_sysbox, как в versions.env"
else
  fail "пакет sysbox-ce «$installed_sysbox», а в versions.env «$sysbox_version»"
fi
for svc in sysbox sysbox-mgr sysbox-fs; do
  check "служба $svc работает" systemctl is-active --quiet "$svc"
done
check "docker info показывает runtime sysbox-runc" \
  bash -c "docker info --format '{{json .Runtimes}}' | jq -e 'has(\"sysbox-runc\")'"
uid_map=$(docker run --rm --runtime=sysbox-runc "$TEST_IMAGE" cat /proc/self/uid_map 2>/dev/null | head -n 1 || true)
if awk '{ exit !($1 == 0 && $2 >= 100000) }' <<<"${uid_map:-x}"; then
  ok "контейнер sysbox-runc запускается, root внутри — UID $(awk '{print $2}' <<<"$uid_map") на хосте"
else
  fail "docker run --runtime=sysbox-runc $TEST_IMAGE не запустился или root внутри не отображён в UID ≥ 100000 (uid_map: «$uid_map»)"
fi

echo "== Сеть $NETWORK"
if docker network inspect "$NETWORK" >/dev/null 2>&1; then
  net_field() { docker network inspect "$NETWORK" --format "$1"; }
  expect_eq "сеть $NETWORK — bridge" "$(net_field '{{.Driver}}')" bridge
  expect_eq "сеть $NETWORK internal (нет маршрута наружу)" "$(net_field '{{.Internal}}')" true
  expect_eq "в $NETWORK enable_icc=false (песочницы не видят друг друга)" \
    "$(net_field '{{index .Options "com.docker.network.bridge.enable_icc"}}')" false
  expect_eq "мост сети $NETWORK называется $BRIDGE (на это имя опираются правила)" \
    "$(net_field '{{index .Options "com.docker.network.bridge.name"}}')" "$BRIDGE"
  expect_eq "у $NETWORK подсеть $SUBNET и шлюз $GATEWAY" \
    "$(net_field '{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}};{{end}}')" "$SUBNET $GATEWAY;"
else
  fail "сети $NETWORK нет"
fi

echo "== Файрвол песочниц"
V4_INPUT_RULES=(
  "-m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT"
  "-s $SUBNET -d $GATEWAY/32 -p tcp -m tcp --dport 3142 -j ACCEPT"
  "-s $SUBNET -d $GATEWAY/32 -p tcp -m tcp --dport 5000 -j ACCEPT"
  "-s $SUBNET -d $GATEWAY/32 -p udp -m udp --dport 53 -j ACCEPT"
  "-s $SUBNET -d $GATEWAY/32 -p tcp -m tcp --dport 53 -j ACCEPT"
  "-j DROP"
)
V4_FORWARD_RULES=(
  "-m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT"
  "-i $BRIDGE -s $SUBNET -p tcp -m conntrack --ctorigdst $GATEWAY/32 --ctorigdstport 3142 -j ACCEPT"
  "-i $BRIDGE -s $SUBNET -p tcp -m conntrack --ctorigdst $GATEWAY/32 --ctorigdstport 5000 -j ACCEPT"
  "-i $BRIDGE -s $SUBNET -p udp -m conntrack --ctorigdst $GATEWAY/32 --ctorigdstport 53 -j ACCEPT"
  "-i $BRIDGE -s $SUBNET -p tcp -m conntrack --ctorigdst $GATEWAY/32 --ctorigdstport 53 -j ACCEPT"
  "-j DROP"
)
V6_RULES=("-j DROP")
# "<бинарь> <цепочка> <правило>": переходы в собственные цепочки, каждый ровно один раз.
JUMPS=(
  "$IPT INPUT -i $BRIDGE -j RC-SBX-INPUT"
  "$IPT DOCKER-USER -s $SUBNET -j RC-SBX-FORWARD"
  "$IPT DOCKER-USER -o $BRIDGE -j RC-SBX-FORWARD"
  "$IPT DOCKER-USER -i $BRIDGE -j RC-SBX-FORWARD"
  "$IP6T INPUT -i $BRIDGE -j RC-SBX-INPUT"
  "$IP6T DOCKER-USER -o $BRIDGE -j RC-SBX-FORWARD"
  "$IP6T DOCKER-USER -i $BRIDGE -j RC-SBX-FORWARD"
)

# chain_ok <бинарь> <цепочка> <правила…>: в цепочке ровно эти правила, последнее — DROP.
chain_ok() {
  local bin=$1 chain=$2 rule n
  shift 2
  local -a args
  for rule in "$@"; do
    read -r -a args <<<"$rule"
    "$bin" -C "$chain" "${args[@]}" 2>/dev/null || return 1
  done
  n=$("$bin" -S "$chain" 2>/dev/null | grep -c '^-A ' || true)
  [[ $n -eq $# ]] || return 1
  [[ $("$bin" -S "$chain" | tail -n 1) == "-A $chain -j DROP" ]]
}

# firewall_ok <пометка>: печатает ok/FAIL по всем правилам; 0 — всё на месте.
firewall_ok() {
  local label=$1 before=$failures spec bin chain rest count
  if chain_ok "$IPT" RC-SBX-INPUT "${V4_INPUT_RULES[@]}"; then
    ok "$label: RC-SBX-INPUT пускает из $SUBNET только к $GATEWAY tcp 3142, 5000, udp/tcp 53, остальное DROP"
  else
    fail "$label: цепочка RC-SBX-INPUT отсутствует или не совпадает с ожидаемой"
  fi
  if chain_ok "$IPT" RC-SBX-FORWARD "${V4_FORWARD_RULES[@]}"; then
    ok "$label: RC-SBX-FORWARD пропускает только опубликованные на $GATEWAY порты 3142, 5000, 53 и ответы, остальное DROP"
  else
    fail "$label: цепочка RC-SBX-FORWARD отсутствует или не совпадает с ожидаемой"
  fi
  if chain_ok "$IP6T" RC-SBX-INPUT "${V6_RULES[@]}" && chain_ok "$IP6T" RC-SBX-FORWARD "${V6_RULES[@]}"; then
    ok "$label: по IPv6 из $BRIDGE и в него всё DROP"
  else
    fail "$label: IPv6-цепочки RC-SBX-* отсутствуют или не из одного DROP"
  fi
  for spec in "${JUMPS[@]}"; do
    read -r bin chain rest <<<"$spec"
    count=$("$bin" -S "$chain" 2>/dev/null | grep -cxF -- "-A $chain $rest" || true)
    if [[ $count -eq 1 ]]; then
      ok "$label: $(basename "$bin") $chain: «$rest» ровно один раз"
    else
      fail "$label: $(basename "$bin") $chain: «$rest» встречается $count раз(а), нужен ровно один"
    fi
  done
  if [[ $("$IPT" -S INPUT | grep '^-A ' | head -n 1) == "-A INPUT -i $BRIDGE -j RC-SBX-INPUT" ]]; then
    ok "$label: переход в RC-SBX-INPUT первый в INPUT (выше правил ufw)"
  else
    fail "$label: переход в RC-SBX-INPUT не первый в INPUT — ufw пропустит песочницы к ssh"
  fi
  if [[ $("$IPT" -S DOCKER-USER | grep '^-A ' | head -n 3 | grep -c -- '-j RC-SBX-FORWARD') -eq 3 ]]; then
    ok "$label: DOCKER-USER начинается с переходов в RC-SBX-FORWARD (из $SUBNET — DROP, кроме разрешённого)"
  else
    fail "$label: DOCKER-USER не начинается с трёх переходов в RC-SBX-FORWARD"
  fi
  [[ $failures -eq $before ]]
}

remove_rules() {
  local spec bin chain rest c
  local -a args
  for spec in "${JUMPS[@]}"; do
    read -r bin chain rest <<<"$spec"
    read -r -a args <<<"$rest"
    while "$bin" -C "$chain" "${args[@]}" 2>/dev/null; do "$bin" -D "$chain" "${args[@]}"; done
  done
  for bin in "$IPT" "$IP6T"; do
    for c in RC-SBX-INPUT RC-SBX-FORWARD; do
      "$bin" -F "$c" 2>/dev/null || true
      "$bin" -X "$c" 2>/dev/null || true
    done
  done
}

check "юнит $UNIT включён" systemctl is-enabled --quiet "$UNIT"
check "юнит $UNIT активен" systemctl is-active --quiet "$UNIT"
check "юнит $UNIT запускается после docker.service и перезапускается вместе с ним" unit_bound_to_docker
rules_present=0
if firewall_ok "сейчас"; then rules_present=1; fi

echo "== Правила после перезапуска Docker"
if [[ $skip_restart == 1 ]]; then
  echo "skip  RC_CHECK_SKIP_RESTART=1: перезапуск Docker не проверялся"
elif [[ $rules_present -ne 1 ]] || ! systemctl is-enabled --quiet "$UNIT" 2>/dev/null; then
  fail "правила после перезапуска Docker не проверялись: их нет уже сейчас или юнит $UNIT не установлен"
else
  remove_rules
  if "$IPT" -S RC-SBX-INPUT >/dev/null 2>&1 || "$IPT" -C INPUT -i "$BRIDGE" -j RC-SBX-INPUT 2>/dev/null; then
    fail "не удалось убрать правила rc-sbx перед перезапуском Docker"
  else
    echo "      правила rc-sbx убраны (как после перезагрузки); systemctl restart docker…"
    systemctl restart docker
    for _ in $(seq 1 30); do
      systemctl is-active --quiet "$UNIT" && break
      sleep 1
    done
    check "после перезапуска Docker юнит $UNIT снова активен" systemctl is-active --quiet "$UNIT"
    firewall_ok "после рестарта Docker" || true
  fi
fi

echo "== Swap"
swap_size=$(stat -c %s "$SWAPFILE" 2>/dev/null || echo 0)
if [[ $swap_size -eq $SWAP_BYTES ]] && grep -q "^$SWAPFILE " /proc/swaps; then
  ok "swap: $SWAPFILE на 2 ГБ включён ($(swapon --show=NAME,SIZE --noheadings | tr -s ' ' | paste -sd ',' -))"
else
  fail "swap: $SWAPFILE не на 2 ГБ или не включён (размер файла $swap_size байт)"
fi
check "swap: $SWAPFILE прописан в /etc/fstab" grep -qE "^${SWAPFILE}[[:space:]]+[^[:space:]]+[[:space:]]+swap[[:space:]]" /etc/fstab
expect_eq "swap: включена одна область подкачки ($SWAPFILE), второй нет" "$(grep -vc '^Filename' /proc/swaps || true)" 1

echo "== ufw, обновления, пользователь deploy"
check "ufw включён" bash -c "ufw status | grep -q '^Status: active'"
check "ufw пропускает 22/tcp (ssh)" ufw_allows 'OpenSSH|22/tcp|22'
check "ufw пропускает 80/tcp" ufw_allows '80/tcp|80'
check "ufw пропускает 443/tcp" ufw_allows '443/tcp|443'
check "unattended-upgrades включён" systemctl is-enabled --quiet unattended-upgrades
check "автоперезагрузка unattended-upgrades не включена (решение R-M4b-2)" \
  bash -c "! apt-config dump | grep -qiE '^Unattended-Upgrade::Automatic-Reboot \"(1|true|yes)\"'"
check "пользователь deploy в группе docker" bash -c "id -nG deploy | tr ' ' '\n' | grep -qx docker"

echo
if [[ $failures -eq 0 ]]; then
  echo "PASS: хост готов к песочницам"
  exit 0
fi
echo "FAIL: проблем — $failures"
exit 1
