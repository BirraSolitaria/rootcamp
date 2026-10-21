# Тестовый стенд rootcamp на VPS

Как поднять на VPS **тестовый** стенд rootcamp и дальше тестировать на нём. Образы собираются из исходников прямо на сервере. Письма до подключения SMTP перехватывает Mailpit. Сайт открывается по `http://<IP>:8080`, HTTPS подключается позже, когда появится домен (§12).

Основной путь — **Ubuntu 24.04 LTS** (так настроен реальный сервер, все шаги проверены на нём). Если VPS на CentOS Stream 9, шаги 1–5 замените приложением «Если CentOS Stream 9» в конце, а в §8 и §12 вместо ufw используйте команды firewalld оттуда же; остальное одинаково.

VPS: 4 vCPU, 7,8 ГБ RAM, KVM, Ubuntu 24.04.5 LTS (штатное ядро `6.8.0-…-generic`), файрвол ufw, swap 512 МБ (`/swapfile` из образа провайдера). Команды ниже выполняются в bash на сервере, если не сказано другое. Команды для Windows-ПК даны для PowerShell 5.1. Каждый шаг заканчивается строкой **Проверка** с ожидаемым результатом.

> **Текущий стенд**
>
> - Адрес: **http://87.251.86.80:8080**.
> - Сервер: Ubuntu 24.04.5 LTS, ядро `6.8.0-147-generic`, Docker Engine 29.9.2, Compose v5.6.1.
> - Вход: `ssh deploy@87.251.86.80` (только по ключу; у `deploy` sudo без пароля). Запасной вход `ssh root@87.251.86.80` — тоже только по ключу.
> - Код: `~/rootcamp` пользователя `deploy`, секреты в `~/rootcamp/infra/vps.env` (права `600`).
> - Mailpit (письма): **http://87.251.86.80:8025**, вход по логину и паролю (basic auth). Посмотреть их с ПК: `ssh deploy@87.251.86.80 'cat ~/rootcamp/infra/mailpit-ui.auth'` (строка `логин:пароль`). Подробности и как закрыть обратно — §8, «Mailpit в браузере».
> - Обновление до свежего `main` (на сервере):
>
>   ```bash
>   cd ~/rootcamp && git pull --ff-only && docker compose -p rootcamp --env-file infra/versions.env --env-file infra/vps.env -f infra/compose.yaml -f infra/compose.vps-test.yaml up -d --build
>   ```
>
> - Автообновления безопасности ставит unattended-upgrades, но сервер сам не перезагружается. Если появился файл `/var/run/reboot-required` (в нём и в `/var/run/reboot-required.pkgs` — причина, обычно новое ядро), выполните `sudo reboot`. Стенд поднимется сам: Docker включён в автозапуск, у всех сервисов (`postgres`, `api`, `caddy`, `mailpit`) стоит `restart: unless-stopped` (проверено перезагрузкой).
>
> **Проверка:** `curl -s http://87.251.86.80:8080/api/health` с ПК печатает `{"db":true,"smtpLastOkAt":…}` (`null` только до первого отправленного письма, дальше — время последней отправки); `ssh deploy@87.251.86.80 uname -r` показывает `6.8.0-147-generic` или новее.

## 0. Чем этот стенд отличается от продакшена

Продакшен-деплой входит в веху M6 и пока не сделан. На тестовом стенде нет следующего:

| Нет сейчас                                                                             | Где появится                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Продакшен-`Caddyfile` с HSTS, CSP и маршрутами sandboxd и контента                     | M6, Task 1                                                         |
| Образы в GHCR, `deploy.sh <sha>` с откатом, деплой из GitHub Actions                   | M6                                                                 |
| Ежедневные бэкапы (`pg_dump` + restic в S3), `restore-test.sh`                         | M6. До тех пор бэкап делается вручную (§10)                        |
| Алерты админам (RAM, диск, бэкап, 5xx)                                                 | M6                                                                 |
| `bootstrap-vps.sh`, Sysbox, сеть `rc-sbx`, зеркала пакетов/registry/dnsmasq, песочницы | M4b (§13, что проверить перед установкой)                          |
| Реальный SMTP                                                                          | Как только выбран провайдер (§11). До этого письма лежат в Mailpit |
| HTTPS                                                                                  | Как только есть домен (§12). До этого `COOKIE_SECURE=false`        |

Файлы стенда в репозитории:

- `infra/compose.vps-test.yaml` — overlay поверх `infra/compose.yaml`. Включает сборку из исходников, Mailpit на `127.0.0.1:8025` (наружу — только с паролем, §8) и Caddy с `Caddyfile.dev` на порту 8080. Postgres наружу не публикуется.
- `infra/vps.env.example` — шаблон. На сервере из него создаётся `infra/vps.env` с секретами. Этот файл есть в `.gitignore` и в git не попадает.
- `infra/compose.vps-tls.yaml` и `infra/Caddyfile.vps-tls` — необязательный HTTPS-слой для домена (§12).

Почему не годится обычный `docker compose up --build` из корня репозитория. Корневой `compose.yaml` подключает dev-overlay. Тот публикует Postgres (`5432`, пароль `rootcamp`) и Mailpit (`8025`) на всех интерфейсах, а опубликованные порты Docker **обходят файрвол** (ufw, как и firewalld, §4). На VPS такая база с известным паролем оказалась бы открыта в интернет. Голый `infra/compose.yaml` тоже не запустится: у Postgres пустой пароль, у Caddy нет конфига сайта и опубликованных портов, а у api нет секретов и сборки.

## 1. Первый вход и обновление системы

На ПК (PowerShell) создайте SSH-ключ, если его ещё нет, и положите публичную часть на сервер. `<IP>` — адрес VPS из панели провайдера. Образ провайдера пускает root по паролю (он спросит его один раз); в журнале сразу видны попытки подбора паролей ботами, вход по паролю закрывается в §3.

```powershell
# только если файла $env:USERPROFILE\.ssh\id_ed25519 ещё нет
ssh-keygen -t ed25519 -C "rootcamp-vps"
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@<IP> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

**Проверка:** `ssh -o BatchMode=yes root@<IP> "echo ok"` печатает `ok` без запроса пароля.

Обновления — первым шагом, до настройки SSH и файрвола. **Важно:** при обновлении пакета `openssh-server` на 24.04 скрипты пакета останавливают `ssh.service` и закрывают `ssh.socket`, а открывают его снова, только когда dpkg дойдёт до настройки openssh в общей очереди. На текущем сервере порт 22 был закрыт ~11 минут: **новые** подключения получали `Connection refused`. Это не поломка, уже открытая сессия живёт. Поэтому:

- не закрывайте текущую SSH-сессию и не открывайте новые, пока apt не закончит;
- запускайте обновление в `tmux` (есть в образе: `tmux new -s up`, после обрыва — `tmux attach -t up`) или через `nohup`, чтобы обрыв сессии не прервал apt на полпути (SIGHUP) с полунастроенным dpkg.

Под root:

```bash
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold full-upgrade
apt-get install -y -q unattended-upgrades curl ca-certificates openssl git
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable --now unattended-upgrades
```

Пояснения:

- `full-upgrade`, а не `upgrade`: `upgrade` не ставит новые пакеты, а новое ядро (`linux-image-6.8.0-…`) — это новый пакет, он остался бы «held back».
- `DEBIAN_FRONTEND=noninteractive` и `--force-confdef --force-confold` убирают вопросы debconf, needrestart и dpkg про изменённые конфиги (остаются локальные версии). Без них apt может зависнуть на вопросе, который в неинтерактивном `ssh … 'cmd'` некому прочитать.
- Пара пакетов может остаться «not upgraded» (на сервере — `cloud-init` и `tmux`): это phased updates Ubuntu, они доедут позже сами.
- `20auto-upgrades` пишется файлом вместо `dpkg-reconfigure -plow unattended-upgrades`: тот задаёт вопрос в диалоге и для неинтерактивной установки не годится. По умолчанию unattended-upgrades ставит только обновления безопасности и сам **не** перезагружает сервер.

Нужна ли перезагрузка, показывает файл `/var/run/reboot-required` (аналог `dnf needs-restarting -r`), причина — в `/var/run/reboot-required.pkgs`. После первого обновления она нужна почти всегда (на сервере: `libc6`, `apparmor`, новое ядро):

```bash
cat /var/run/reboot-required.pkgs 2>/dev/null || echo no-reboot-needed
reboot
```

SSH возвращается примерно через 30 секунд. Перезагрузку можно отложить до конца §5, но стенд проще запускать уже на новом ядре.

**Проверка:** apt заканчивается строкой `… upgraded, … newly installed, 0 to remove …` без ошибок, `dpkg --audit` ничего не печатает. `systemctl is-enabled unattended-upgrades` и `systemctl is-active unattended-upgrades` печатают `enabled` и `active`; `apt-config dump | grep -E 'Periodic::(Update-Package-Lists|Unattended-Upgrade) '` показывает обе настройки со значением `"1"`; `systemctl list-timers apt-daily-upgrade.timer` показывает время следующего запуска. После перезагрузки `uname -r` показывает новое ядро (`6.8.0-147-generic` или новее), а `ls /var/run/reboot-required` — `No such file or directory`.

## 2. Пользователь `deploy`

На сервере, под root. В Ubuntu группа администраторов называется `sudo`. Ключи копируются через `install` (одинаково для Ubuntu и CentOS):

```bash
useradd -m -s /bin/bash -G sudo deploy
passwd -l deploy                      # пароля нет: вход только по ключу
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deploy
chmod 440 /etc/sudoers.d/deploy
visudo -cf /etc/sudoers.d/deploy      # parsed OK
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
install -m 600 -o deploy -g deploy /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
```

`passwd -l` на Ubuntu печатает `passwd: password changed.` — это нормально, пароль именно заблокирован. Заблокированный пароль не мешает входу по ключу (`UsePAM yes`). sudo без пароля нужен, чтобы Claude мог работать неинтерактивно (`sudo -n`, §14). Если он не нужен, вместо `passwd -l` и файла в `sudoers.d` задайте пароль командой `passwd deploy`: группа `sudo` уже даёт sudo с паролем.

**Проверка** (в новом окне PowerShell): `ssh -o BatchMode=yes deploy@<IP> "sudo -n true && echo ok"` входит без пароля и печатает `ok`; `ssh deploy@<IP> id` показывает группу `27(sudo)`.

Дальше все команды выполняются под `deploy`.

## 3. Только ключи, без входа root по паролю

Не закрывайте текущую сессию, пока не убедитесь, что вход по ключу работает.

В образе провайдера вход по паролю включён в двух местах: `/etc/ssh/sshd_config.d/50-cloud-init.conf` содержит `PasswordAuthentication yes` (так cloud-init применяет `ssh_pwauth`), а сам `/etc/ssh/sshd_config` — `PermitRootLogin yes` и `PasswordAuthentication yes`.

```bash
sudo tee /etc/ssh/sshd_config.d/00-rootcamp.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sudo chmod 600 /etc/ssh/sshd_config.d/00-rootcamp.conf
# нейтрализовать 50-cloud-init.conf (оригинал — в /root):
sudo cp -a /etc/ssh/sshd_config.d/50-cloud-init.conf /root/50-cloud-init.conf.orig
printf '# rootcamp: was PasswordAuthentication yes (cloud-init ssh_pwauth); original in /root/50-cloud-init.conf.orig\nPasswordAuthentication no\n' \
  | sudo tee /etc/ssh/sshd_config.d/50-cloud-init.conf >/dev/null
sudo sshd -t && sudo systemctl reload ssh
```

Пояснения:

- В sshd побеждает первое найденное значение, а drop-in'ы читаются по алфавиту, поэтому файл называется `00-…`. Он уже перебивает `50-cloud-init.conf`, но тот всё равно переписывается на `no`: иначе при удалении или переименовании нашего файла вход по паролю молча вернётся.
- Строки `PermitRootLogin yes` и `PasswordAuthentication yes` в самом `sshd_config` не трогайте: `Include /etc/ssh/sshd_config.d/*.conf` стоит в начале файла (строка 12), поэтому drop-in'ы их перебивают, а правка основного файла создаст конфликт конфигов при следующем обновлении `openssh-server`.
- `PermitRootLogin prohibit-password`, а не `no`: пароль для root всё равно не принимается, но вход root по ключу остаётся запасным путём, если сломается `deploy` или его sudo. В выводе `sshd -T` это значение показывается как `without-password`.
- Служба в Ubuntu называется `ssh` (в CentOS — `sshd`). В 24.04 включена socket activation: порт 22 держит `ssh.socket`, а `ssh.service` запускается от него. `systemctl reload ssh` при этом работает как обычно; `ssh.socket` трогать нужно, только если меняете `Port` или `ListenAddress`.

**Проверка:** `sudo sshd -T | grep -E '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication)'` печатает `passwordauthentication no`, `kbdinteractiveauthentication no` и `permitrootlogin without-password`. С ПК новые подключения `ssh -o BatchMode=yes deploy@<IP> "echo ok"` и `ssh -o BatchMode=yes root@<IP> "echo ok"` печатают `ok` (по ключу), а `ssh -o PubkeyAuthentication=no deploy@<IP>` и `ssh -o PubkeyAuthentication=no root@<IP>` получают `Permission denied (publickey).`

## 4. Файрвол ufw

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 8080/tcp      # сайт тестового стенда по http
sudo ufw allow 8025/tcp      # Mailpit в браузере (§8); без этого режима не нужен
# позже, для HTTPS (§12): sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp && sudo ufw delete allow 8080/tcp
sudo ufw show added          # до включения: OpenSSH должен быть в списке
sudo ufw --force enable
```

`--force` нужен, потому что `ufw enable` иначе спрашивает подтверждение, а в неинтерактивном `ssh … 'cmd'` ответить некому. `deny incoming` и `allow outgoing` в Ubuntu и так значения по умолчанию, но здесь они заданы явно и видны в проверке.

ufw **не защищает** порты, опубликованные Docker. Docker пропускает трафик к опубликованным портам собственными правилами iptables (цепочки `DOCKER`/`DOCKER-USER`), которые срабатывают раньше правил ufw. Поэтому в `compose.vps-test.yaml` Postgres не опубликован вовсе, а Mailpit по умолчанию привязан к `127.0.0.1`; это не перестраховка, а единственная защита. Не добавляйте `ports:` без `127.0.0.1:` в начале. Единственное исключение — Mailpit с паролем (§8, «Mailpit в браузере»); правило `8025/tcp` в ufw для него добавлено для наглядности, открывает порт всё равно Docker. И наоборот, `ufw delete allow …` опубликованный Docker порт не закрывает.

**Проверка:** `sudo ufw status verbose` показывает `Status: active`, `Default: deny (incoming), allow (outgoing), disabled (routed)` и строки `22/tcp (OpenSSH)`, `8080/tcp`, `8025/tcp` с `ALLOW IN Anywhere` (и то же для v6); `systemctl is-enabled ufw` печатает `enabled`; новое подключение `ssh deploy@<IP>` с ПК проходит. После запуска стенда (§8) с ПК `Test-NetConnection <IP> -Port 5432` даёт `TcpTestSucceeded : False`, `-Port 8080` — `True`, `-Port 8025` — `False`, пока Mailpit не открыт по §8.

## 5. Docker Engine и compose plugin (официальный apt-репозиторий Docker)

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update -q
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy
```

apt сам запускает Docker и включает его в автозапуск. Группа `docker` применяется при следующем входе: в интерактивной сессии выйдите из SSH и зайдите снова; неинтерактивный `ssh deploy@<IP> 'cmd'` — каждый раз новый вход, там группа действует сразу. Членство в `docker` равносильно root, поэтому так настраивается только `deploy`.

**Проверка** (под `deploy`, новый вход): `id` показывает группу `docker`; `docker run --rm hello-world` печатает `Hello from Docker!`; `docker version` показывает клиент и сервер (на сервере Engine 29.9.2); `docker compose version` печатает `Docker Compose version v2.x` или новее (на сервере v5.6.1); `systemctl is-enabled docker` печатает `enabled`.

Если не скачиваются образы с Docker Hub (на части российских VPS бывает), сначала проверьте `docker pull postgres:16`. Без доступа к Docker Hub стенд не соберётся.

## 6. Код

Node.js и pnpm на сервер ставить не нужно. Оба Dockerfile (`apps/api/Dockerfile`, `apps/web/Dockerfile`) сами берут `node:22-alpine`, включают pnpm через corepack и собирают всё внутри Docker.

```bash
git clone https://github.com/BirraSolitaria/rootcamp.git ~/rootcamp
cd ~/rootcamp
```

**Проверка:** `git -C ~/rootcamp log --oneline -1` показывает последний коммит `main`, а `ls ~/rootcamp/infra` содержит `compose.vps-test.yaml`, `versions.env` и `vps.env.example`.

## 7. Секреты и адрес: `infra/vps.env`

Подставьте публичный IP VPS вместо `<IP>`.

```bash
cd ~/rootcamp
cp infra/vps.env.example infra/vps.env
chmod 600 infra/vps.env
sed -i "s|^PUBLIC_ORIGIN=.*|PUBLIC_ORIGIN=http://<IP>:8080|"                infra/vps.env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" infra/vps.env
sed -i "s|^INTERNAL_TOKEN=.*|INTERNAL_TOKEN=$(openssl rand -hex 32)|"       infra/vps.env
sed -i "s|^TICKET_SECRET=.*|TICKET_SECRET=$(openssl rand -hex 32)|"         infra/vps.env
```

Правила для этих значений:

- **`PUBLIC_ORIGIN` должен в точности совпадать с адресом в строке браузера**: схема, хост и порт, без `/` в конце. CSRF-защита сравнивает заголовок `Origin` с этим значением побуквенно. При любом расхождении каждый POST (регистрация, вход) получит `403 csrf`. Например, сайт открыт по домену, а в `PUBLIC_ORIGIN` записан IP. Или открыто `https://`, а записано `http://`.
- Особенность с `localhost` и `127.0.0.1` (IPv6 `::1`) касается только Windows-стенда разработчика. На VPS используйте публичный IP, а позже домен.
- **`COOKIE_SECURE=false` оставляйте, пока сайт работает по http.** Браузер не сохраняет cookie с флагом `Secure` по http: вход вроде бы проходит, но сессия сразу теряется. Когда появится HTTPS, флаг включает `compose.vps-tls.yaml` (§12).
- `INTERNAL_TOKEN` и `TICKET_SECRET` должны быть длиной от 16 символов, иначе api не стартует. Пароль Postgres задан в hex, чтобы `DATABASE_URL` работал без экранирования.
- `POSTGRES_PASSWORD` применяется только при первом создании тома `pg-data`. Если поменять его позже, пароль в базе останется прежним (см. §9, сброс).
- `vps.env` никогда не попадает в git (`git status` его не показывает) и не пересылается в чат.

**Проверка:**

```bash
grep -E '^(PUBLIC_ORIGIN|COOKIE_SECURE|SITE_BIND)=' infra/vps.env
awk -F= '/^(POSTGRES_PASSWORD|INTERNAL_TOKEN|TICKET_SECRET)=/{print $1, length($2)}' infra/vps.env
git status --short          # vps.env в списке быть не должно
```

Ожидается `PUBLIC_ORIGIN=http://<IP>:8080`, `COOKIE_SECURE=false`, `SITE_BIND=8080`, затем `POSTGRES_PASSWORD 48`, `INTERNAL_TOKEN 64`, `TICKET_SECRET 64`. `git status` ничего не выводит.

## 8. Запуск

Чтобы не набирать длинную команду каждый раз, заведите алиас `rc` (на текущем сервере он не заведён, там используется полная команда из блока «Текущий стенд»):

```bash
cat >> ~/.bashrc <<'EOF'
alias rc='docker compose -p rootcamp --env-file $HOME/rootcamp/infra/versions.env --env-file $HOME/rootcamp/infra/vps.env -f $HOME/rootcamp/infra/compose.yaml -f $HOME/rootcamp/infra/compose.vps-test.yaml'
EOF
source ~/.bashrc
rc config --quiet && echo config-ok
```

**Проверка:** выводится `config-ok`. Если какой-то секрет пуст, compose остановится с сообщением `required variable … is missing a value: set … in infra/vps.env`.

Первая сборка занимает 5–7 минут на 4 vCPU (на текущем сервере ~6,5 минуты). Если запускаете неинтерактивно по SSH, удобнее в фоне с логом: `nohup sh -c 'docker compose … up -d --build; echo EXIT=$?' > ~/up.log 2>&1 < /dev/null &` (алиасы в `sh -c` не работают, нужна полная команда).

```bash
rc up -d --build
rc ps
curl -s http://127.0.0.1:8080/api/health; echo
sudo ss -tlnp | grep -E ':(5432|8025|8080)\b'
```

В логе сборки бывают строки `cpu-features: Unable to detect compiler type`, `gyp ERR! Could not find any Python installation` и предупреждения pnpm (`WARN … deprecated`, `Failed to create bin … vite`). Это необязательные нативные зависимости `ssh2` и шум pnpm. Ошибки не фатальные: сборка завершается, api работает. Обращать внимание стоит, только если сама команда `up --build` завершилась с ошибкой.

**Проверка:**

- `rc ps`: `postgres`, `api` и `mailpit` в статусе `Up … (healthy)`, `caddy` в статусе `Up` (у caddy в этом overlay нет healthcheck, поэтому `(healthy)` не бывает).
- `curl` печатает `{"db":true,"smtpLastOkAt":null}`. Миграции api применяет сам при старте. `null` здесь — пока не отправлено ни одного письма; после первого письма там время последней успешной отправки.
- `ss`: порт 8080 слушается на `0.0.0.0` и `[::]` (`docker-proxy`), порта 5432 в списке нет. Порт 8025 в режиме по умолчанию — только на `127.0.0.1`, а в режиме «Mailpit в браузере» (ниже) — на `0.0.0.0` и `[::]`.

С ПК (PowerShell):

```powershell
curl.exe -s http://<IP>:8080/api/health
curl.exe -s -X POST -H "X-RC: 1" -H "Origin: http://wrong.example" http://<IP>:8080/api/auth/logout
curl.exe -s -o NUL -w "%{http_code}`n" -X POST -H "X-RC: 1" -H "Origin: http://<IP>:8080" http://<IP>:8080/api/auth/logout
```

Если на ПК задан `HTTP_PROXY`/`HTTPS_PROXY`, добавляйте к `curl.exe` ключ `--noproxy "*"`. Иначе ответы (например, `503` на порт 8025) придут от локального прокси, а не от VPS. Для проверки открытых портов надёжнее `Test-NetConnection` (§4).

**Проверка:** первая команда печатает `{"db":true,...}`, вторая ответ с `csrf` (403), третья код **не** `403` (обычно `204`). Значит, `PUBLIC_ORIGIN` совпадает с адресом.

### Первый пользователь и админ

1. Откройте в браузере `http://<IP>:8080` (ровно этот адрес, как в `PUBLIC_ORIGIN`) и зарегистрируйтесь.
2. Письмо с подтверждением лежит в Mailpit. В режиме по умолчанию Mailpit наружу не открыт, поэтому на ПК откройте SSH-туннель и оставьте окно открытым:

   ```powershell
   ssh -N -L 8025:127.0.0.1:8025 deploy@<IP>
   ```

   Затем откройте `http://127.0.0.1:8025`. Это адрес на ПК, туннель ведёт на Mailpit сервера. Если Mailpit открыт наружу (ниже, так на текущем стенде), туннель не нужен: `http://<IP>:8025` с логином и паролем.

3. Выдайте себе права админа:

   ```bash
   rc exec api node dist/cli.js admin:grant you@example.com
   ```

**Проверка:** печатается `granted admin to you@example.com (<uuid>)`. Для несуществующего email печатается `no user with email …` с кодом выхода 1. Админка появится в M5, пока флаг только записывается в БД.

### Mailpit в браузере (без туннеля, с паролем)

Можно открыть Mailpit как `http://<IP>:8025` (так сделано на текущем стенде). **Внимание:** в письмах лежат ссылки подтверждения и сброса пароля; кто прочитал Mailpit, тот может войти в любой аккаунт стенда. Поэтому наружу Mailpit открывается только с basic auth: compose откажется стартовать, если задан `MAILPIT_BIND`, но не задан `MAILPIT_UI_AUTH_FILE`. Пароль лежит в отдельном файле и монтируется в контейнер, поэтому в `docker inspect` его не видно.

В шаблоне `vps.env.example` строки `MAILPIT_BIND=` и `MAILPIT_UI_AUTH_FILE=` уже есть (пустые), поэтому значения задаются через `sed`, а не дописываются в конец файла: иначе появятся дубли.

```bash
cd ~/rootcamp
printf 'rootcamp:%s\n' "$(openssl rand -base64 18 | tr -d '/+=')" > infra/mailpit-ui.auth
chmod 600 infra/mailpit-ui.auth            # файл git-ignored
sed -i -e 's|^MAILPIT_BIND=.*|MAILPIT_BIND=8025|' \
       -e 's|^MAILPIT_UI_AUTH_FILE=.*|MAILPIT_UI_AUTH_FILE=./mailpit-ui.auth|' infra/vps.env
sudo ufw allow 8025/tcp                    # если не добавлено в §4
rc up -d mailpit
```

Логин и пароль (строка `логин:пароль`) посмотреть с ПК: `ssh deploy@<IP> 'cat ~/rootcamp/infra/mailpit-ui.auth'`. Сменить пароль: перезаписать файл той же командой `printf` и выполнить `rc up -d --force-recreate mailpit`.

Вернуть «только через туннель»: очистить значения теми же `sed` и пересоздать Mailpit, затем убрать правило ufw:

```bash
sed -i -e 's|^MAILPIT_BIND=.*|MAILPIT_BIND=|' -e 's|^MAILPIT_UI_AUTH_FILE=.*|MAILPIT_UI_AUTH_FILE=|' infra/vps.env
rc up -d mailpit
sudo ufw delete allow 8025/tcp
```

**Проверка:** `grep -c '^MAILPIT_BIND=' infra/vps.env` печатает `1` (дублей нет). С ПК `curl.exe -s -o NUL -w "%{http_code}" http://<IP>:8025/` печатает `401`, с `-u rootcamp:<пароль>` — `200`, с неверным паролем — снова `401`. На сервере `sudo ss -tlnp | grep 8025` показывает `0.0.0.0:8025` и `[::]:8025`. После отката — `127.0.0.1:8025`, а с ПК `Test-NetConnection <IP> -Port 8025` даёт `False`.

## 9. Повседневные операции

```bash
rc ps                          # состояние
rc logs -f api                 # логи api (Ctrl+C — выход); также caddy, postgres, mailpit
rc logs --tail 200 caddy
rc restart api                 # перезапуск одного сервиса
```

**Обновление до свежего `main`:**

```bash
cd ~/rootcamp && git pull --ff-only && rc up -d --build && docker image prune -f
curl -s http://127.0.0.1:8080/api/health; echo
```

**Проверка:** `git log --oneline -1` показывает новый коммит, health печатает `{"db":true,...}`. После изменения только `vps.env` пересборка не нужна, хватит `rc up -d`: изменённые контейнеры пересоздадутся.

**Перезагрузка сервера** (например, ради нового ядра — когда есть `/var/run/reboot-required`, §1): `sudo reboot`. Docker включён в автозапуск, у всех сервисов `restart: unless-stopped`, так что стенд поднимается сам. Исключение: сервисы, остановленные вручную через `rc stop`, после перезагрузки остаются остановленными.

**Проверка:** через 1–2 минуты после перезагрузки `rc ps` показывает те же статусы, что в §8, health печатает `{"db":true,...}`, `sudo ufw status` — `Status: active`, а `/var/run/reboot-required` отсутствует.

**Остановка без потери данных:** `rc stop` (потом `rc start`) или `rc down` (потом `rc up -d`). Тома `pg-data` и `caddy-data` сохраняются.

**Проверка:** после `rc down` команда `docker volume ls` всё ещё показывает `rootcamp_pg-data`.

**Полный сброс данных.** Команда необратима: удаляются все пользователи, прогресс и, при HTTPS, сертификаты. У Let's Encrypt есть лимиты на повторный выпуск сертификатов. Сначала сделайте бэкап (§10).

```bash
rc down -v
rc up -d
```

**Проверка:** `docker volume ls` после `down -v` не показывает `rootcamp_pg-data`. После `up` health снова `{"db":true,...}`, база пустая.

## 10. Бэкап вручную (до M6)

Автоматических бэкапов нет. Перед рискованными действиями и периодически выполняйте:

```bash
mkdir -p ~/backups
rc exec -T postgres pg_dump -U rootcamp -d rootcamp -Fc > ~/backups/rootcamp-$(date +%Y%m%d-%H%M).dump
ls -lh ~/backups
rc exec -T postgres pg_restore --list < "$(ls -t ~/backups/*.dump | head -1)" | head -5
```

**Проверка:** файл ненулевого размера, `pg_restore --list` печатает заголовок `; Archive created at …` без ошибок.

Скопировать бэкап на ПК (PowerShell): `scp deploy@<IP>:~/backups/*.dump .`

Восстановление в работающий стенд (перезаписывает текущие данные):

```bash
rc stop api
rc exec -T postgres pg_restore -U rootcamp -d rootcamp --clean --if-exists < ~/backups/rootcamp-YYYYMMDD-HHMM.dump
rc start api
```

**Проверка:** после `rc start api` health печатает `{"db":true,...}`, а данные соответствуют моменту бэкапа.

Если нужен ежедневный дамп, добавьте задание через `crontab -e` (в Ubuntu cron — это служба `cron`, она включена по умолчанию). Используйте полный путь вместо алиаса и экранируйте `%`:

```
30 3 * * * cd $HOME/rootcamp && docker compose -p rootcamp --env-file infra/versions.env --env-file infra/vps.env -f infra/compose.yaml -f infra/compose.vps-test.yaml exec -T postgres pg_dump -U rootcamp -d rootcamp -Fc > $HOME/backups/rootcamp-$(date +\%Y\%m\%d).dump && find $HOME/backups -name '*.dump' -mtime +7 -delete
```

**Проверка:** `crontab -l` показывает строку, а на следующий день в `~/backups` появляется файл с датой.

## 11. Реальный SMTP (когда выбран провайдер)

Нужен ящик и пароль приложения (не основной пароль от почты):

- Яндекс: `SMTP_HOST=smtp.yandex.ru`, `SMTP_PORT=465`;
- Mail.ru: `SMTP_HOST=smtp.mail.ru`, `SMTP_PORT=465`.

На порту 465 api включает TLS сразу, на 587 используется STARTTLS. `SMTP_FROM` должен совпадать с ящиком, например `rootcamp <box@yandex.ru>`. Заполните `SMTP_*` в `infra/vps.env` через `nano infra/vps.env`, затем:

```bash
rc up -d
```

**Проверка:** запросите письмо (регистрация или «забыли пароль») на реальный адрес. Письмо приходит, а `curl -s http://127.0.0.1:8080/api/health` показывает в `smtpLastOkAt` текущее время. Если письмо не уходит, смотрите `rc logs api | grep -i smtp`. Некоторые VPS-провайдеры блокируют исходящие 465 и 587, проверить можно командой `curl -v --max-time 5 telnet://smtp.yandex.ru:465` (соединение `Connected` — порт открыт).

Mailpit после этого продолжает работать, но письма в него больше не попадают.

## 12. HTTPS по домену (необязательно, когда домен есть)

Caddy сам получит сертификат Let's Encrypt, если A-запись домена указывает на VPS, а порты 80 и 443 открыты.

1. В DNS создайте A-запись `rootcamp.example.ru → <IP>`.
   **Проверка:** `getent hosts rootcamp.example.ru` печатает `<IP>`.
2. Откройте порты 80 и 443 (443/udp — для HTTP/3), а 8080 закройте:

   ```bash
   sudo ufw allow 80/tcp
   sudo ufw allow 443/tcp
   sudo ufw allow 443/udp
   sudo ufw delete allow 8080/tcp
   ```

   **Проверка:** `sudo ufw status` показывает `80/tcp`, `443/tcp` и `443/udp` с `ALLOW`, а строки `8080/tcp` нет.

3. В `infra/vps.env` задайте:

   ```
   DOMAIN=rootcamp.example.ru
   PUBLIC_ORIGIN=https://rootcamp.example.ru
   COOKIE_SECURE=true
   SITE_BIND=127.0.0.1:8080
   ```

   `compose.vps-tls.yaml` в любом случае выставляет `PUBLIC_ORIGIN=https://$DOMAIN` и `COOKIE_SECURE=true`. Значения в `vps.env` только держат файл в согласованном виде. `SITE_BIND=127.0.0.1:8080` обязателен: удаление правила 8080 из ufw старый http-порт **не** закрывает, потому что опубликованные Docker порты идут мимо ufw (§4).

4. Подключите TLS-слой в алиас и перезапустите:

   ```bash
   sed -i 's|compose.vps-test.yaml'"'"'$|compose.vps-test.yaml -f $HOME/rootcamp/infra/compose.vps-tls.yaml'"'"'|' ~/.bashrc
   source ~/.bashrc && rc config --quiet && rc up -d
   ```

**Проверка:** `alias rc` заканчивается на `compose.vps-tls.yaml'`. `rc logs caddy | grep -i "certificate obtained"` находит строку о выданном сертификате. С ПК `curl.exe -s https://rootcamp.example.ru/api/health` печатает `{"db":true,...}`, а `curl.exe -sI http://rootcamp.example.ru` отвечает `308` с переходом на https. `Test-NetConnection <IP> -Port 8080` даёт `False`. Сайт открывается по `https://rootcamp.example.ru`, вход сохраняет сессию.

Это всё ещё тестовая конфигурация: в ней нет HSTS, CSP и остальных заголовков из продакшен-`Caddyfile` (M6).

## 13. Позже: Sysbox (с вехи M4b)

Сейчас Sysbox не нужен: песочниц ещё нет. В M4b появится `infra/scripts/bootstrap-vps.sh`. Он поставит Sysbox CE (версия будет в `infra/versions.env`) официальным `.deb` (https://github.com/nestybox/sysbox/blob/master/docs/user-guide/install-package.md), swap 2 ГБ, сеть `rc-sbx`, юнит `rc-sbx-firewall` и зеркала.

Что уже известно о текущем сервере (проверено только чтением, ничего не ставилось):

- Ubuntu 24.04 со штатным ядром `6.8.0-…-generic` — поддерживаемая Sysbox конфигурация. Ядро ≥ 5.19 умеет idmapped mounts на overlayfs, поэтому модуль `shiftfs` не нужен (его и нет). cgroup v2, драйвер cgroup Docker — `systemd`; виртуализация KVM (Sysbox требует KVM или bare metal — подходит).
- `kernel.apparmor_restrict_unprivileged_userns = 1`: в Ubuntu 24.04 AppArmor ограничивает непривилегированные user namespaces (`unprivileged_userns_clone = 1`, `user.max_user_namespaces = 31437`). sysbox-runc работает от root, но влияет ли это ограничение на него и на контейнеры внутри, **не проверено**. В M4b после установки обязательно проверить `docker run --runtime=sysbox-runc …`; если не работает — разбираться (профиль AppArmor для Sysbox или sysctl), а не отключать ограничение вслепую.
- Docker 29 по умолчанию использует containerd image store (`docker info` показывает storage driver `overlayfs`, а не классический `overlay2`). Совместима ли с ним Sysbox CE, **проверить в M4b** до установки; возможный выход — вернуть классический store через `"features": {"containerd-snapshotter": false}` в `/etc/docker/daemon.json` (смена store скрывает уже скачанные образы — после неё нужна пересборка стенда).
- Swap: в образе уже есть `/swapfile` на 512 МБ, а план M4b — 2 ГБ. `bootstrap-vps.sh` должен учитывать существующий файл (увеличить его, а не создавать второй).
- Установщик перезапускает Docker. Перед установкой выполните `rc down` (данные сохранятся) и бэкап по §10.

**Проверка (после установки):** `docker info | grep -i runtimes` показывает `sysbox-runc`, а `docker run --rm --runtime=sysbox-runc alpine true` завершается без ошибок.

## 14. Что нужно от пользователя, чтобы Claude развернул стенд сам

Claude Code работает на ПК пользователя, поэтому ходит на сервер по SSH с этого же ПК.

1. **SSH-доступ.** Положите ключ ПК (`%USERPROFILE%\.ssh\id_ed25519.pub`) на сервер по §1 (root) или сразу в `~deploy/.ssh/authorized_keys` (§2) и сообщите адрес. Для удобства можно добавить запись в `%USERPROFILE%\.ssh\config`:

   ```
   Host rootcamp-vps
       HostName <IP>
       User deploy
       IdentityFile ~/.ssh/id_ed25519
   ```

   **Приватный ключ, пароль root и пароль sudo в чат не присылайте.** Для неинтерактивной работы Claude нужен `sudo` без пароля (`/etc/sudoers.d/deploy` из §2). Если держать его постоянно не хочется, создайте файл на время установки и удалите после. Или выполните шаги 1–5 самостоятельно и поручите Claude только шаги 6–10.

   **Проверка:** `ssh -o BatchMode=yes rootcamp-vps "sudo -n true && echo ok"` с ПК печатает `ok`.

2. **Домен** (для §12): имя и подтверждение, что A-запись указывает на VPS.
3. **SMTP** (для §11): провайдер и ящик. Пароль приложения впишите в `infra/vps.env` на сервере сами (`nano`). Claude генерирует секреты прямо на сервере (`openssl rand`) и в чат их не выводит.
4. **S3** (для бэкапов M6): пока не нужен.

Все секреты хранятся только в `infra/vps.env` и `infra/mailpit-ui.auth` на сервере (права `600`, файлы в `.gitignore`), никогда в git и никогда в чате. Перед необратимыми командами (`down -v`, восстановление из бэкапа, изменение ufw и sshd, перезагрузка) Claude спрашивает подтверждение.

## Приложение: если CentOS Stream 9

Шаги 1–5 для CentOS Stream 9 (проверены на этом же VPS до переустановки на Ubuntu). Шаги 6–11 и 14 те же; в §8 и §12 вместо ufw используется firewalld (команды ниже); cron в §10 — служба `crond`; `nano` при необходимости: `sudo dnf -y install nano`. SELinux в образе провайдера был выключен.

**1. Обновления и dnf-automatic.** Ключ на сервер — как в §1 (PowerShell). Под root:

```bash
dnf -y upgrade --refresh
dnf -y install git dnf-plugins-core curl tar openssl dnf-automatic
sed -i -E 's/^upgrade_type\s*=.*/upgrade_type = default/; s/^apply_updates\s*=.*/apply_updates = yes/' /etc/dnf/automatic.conf
systemctl enable --now dnf-automatic.timer
```

`upgrade_type = default`, а не `security`: репозитории CentOS Stream не публикуют метаданные об исправлениях безопасности (`dnf updateinfo summary` пуст), и с `security` dnf-automatic фактически ничего не ставит. `default` ставит все обновления; Stream — rolling-ветка, изредка возможна регрессия, её покрывает бэкап (§10). `reboot = never` (по умолчанию): нужна ли перезагрузка, показывает `dnf needs-restarting -r`.

**Проверка:** `grep -E '^(upgrade_type|apply_updates)' /etc/dnf/automatic.conf` печатает `upgrade_type = default` и `apply_updates = yes`; `systemctl is-enabled dnf-automatic.timer` печатает `enabled`.

**2. Пользователь.** Команды §2, но группа администраторов — `wheel`: `useradd -m -s /bin/bash -G wheel deploy`. `rsync` в минимальном образе нет, ключи копируются через `install`, как в §2.

**Проверка:** `ssh -o BatchMode=yes deploy@<IP> "sudo -n true && echo ok"` печатает `ok`; `id` показывает группу `10(wheel)`.

**3. sshd.** Тот же `00-rootcamp.conf`, что в §3. Вместо `50-cloud-init.conf` в образе CentOS был `01-permitrootlogin.conf` с `PermitRootLogin yes` — его убрать в сторону, `50-redhat.conf` (пароли не включает) не трогать. Служба называется `sshd`:

```bash
sudo mv /etc/ssh/sshd_config.d/01-permitrootlogin.conf /root/01-permitrootlogin.conf.disabled
sudo sshd -t && sudo systemctl reload sshd
```

**Проверка:** как в §3 (`sshd -T`, вход по ключу для `deploy` и `root`, `Permission denied (publickey,…)` без ключа).

**4. firewalld.**

```bash
sudo systemctl enable --now firewalld
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --permanent --add-port=8080/tcp
sudo firewall-cmd --reload
```

- В зоне `public` образа заранее разрешены `cockpit` (9090, никто не слушает) и `dhcpv6-client`; убрать cockpit: `sudo firewall-cmd --permanent --remove-service=cockpit && sudo firewall-cmd --reload`.
- firewalld, как и ufw, **не защищает** порты Docker: Docker создаёт свою зону `docker` (target `ACCEPT`) и пропускает опубликованные порты собственными правилами nftables мимо зоны `public`. Выводы те же, что в §4.
- Mailpit в браузере (§8): `sudo firewall-cmd --permanent --add-port=8025/tcp && sudo firewall-cmd --reload`, откат — `--remove-port=8025/tcp`.
- HTTPS (§12): `sudo firewall-cmd --permanent --add-service=http --add-service=https --add-port=443/udp`, `sudo firewall-cmd --permanent --remove-port=8080/tcp`, `sudo firewall-cmd --reload`.

**Проверка:** `sudo firewall-cmd --list-all` показывает `services: … ssh` и `ports: 8080/tcp`.

**5. Docker** из репозитория Docker для CentOS:

```bash
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker       # dnf, в отличие от apt, сам Docker не запускает
sudo usermod -aG docker deploy
```

**Проверка:** как в §5 (`hello-world`, `docker compose version`, `systemctl is-enabled docker` → `enabled`).

**Sysbox на CentOS — открытый риск.** Для CentOS Stream 9 официального пакета Sysbox CE нет: Nestybox выпускает пакеты только для Ubuntu и Debian (`.deb`). Остаётся собирать Sysbox из исходников под ядро el9 (https://github.com/nestybox/sysbox/blob/master/docs/developers-guide/build.md), проверять его с этим ядром и cgroup v2 и поддерживать сборку при каждом обновлении самим — либо переустановить VPS на Ubuntu 24.04, перенеся данные бэкапом из §10 (так и сделано с текущим сервером).
