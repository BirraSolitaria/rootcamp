# Тестовый стенд rootcamp на VPS

Как поднять на VPS **тестовый** стенд rootcamp и дальше тестировать на нём. Образы собираются из исходников прямо на сервере. Письма до подключения SMTP перехватывает Mailpit. Сайт открывается по `http://<IP>:8080`, HTTPS подключается позже, когда появится домен (§12).

Основной путь — **CentOS Stream 9** (так настроен реальный сервер). Если VPS на Ubuntu 24.04, шаги 1–5 замените приложением «Если Ubuntu 24.04» в конце, остальное одинаково.

VPS: 4 vCPU, 7,5 ГБ RAM, 119 ГБ диска, KVM, CentOS Stream 9 (ядро 5.14 el9), SELinux выключен, файрвол firewalld. Команды ниже выполняются в bash на сервере, если не сказано другое. Команды для Windows-ПК даны для PowerShell 5.1. Каждый шаг заканчивается строкой **Проверка** с ожидаемым результатом.

> **Текущий стенд**
>
> - Адрес: **http://87.251.86.80:8080**.
> - Вход: `ssh deploy@87.251.86.80` (только по ключу; у `deploy` sudo без пароля).
> - Код: `~/rootcamp` пользователя `deploy`, секреты в `~/rootcamp/infra/vps.env` (права `600`).
> - Mailpit (письма): **http://87.251.86.80:8025**, вход по логину и паролю (basic auth). Посмотреть их с ПК: `ssh deploy@87.251.86.80 'cat ~/rootcamp/infra/mailpit-ui.auth'` (строка `логин:пароль`). Подробности и как закрыть обратно — §8, «Mailpit в браузере».
> - Обновление до свежего `main` (на сервере):
>
>   ```bash
>   cd ~/rootcamp && git pull --ff-only && docker compose -p rootcamp --env-file infra/versions.env --env-file infra/vps.env -f infra/compose.yaml -f infra/compose.vps-test.yaml up -d --build
>   ```
>
> - Установлено новое ядро (5.14.0-758.el9), сервер работает на старом (701). Оно применится при следующей перезагрузке: `sudo reboot`. Стенд поднимется сам: Docker включён в автозапуск (`systemctl enable docker`), у всех сервисов (`postgres`, `api`, `caddy`, `mailpit`) стоит `restart: unless-stopped`.
>
> **Проверка:** `curl -s http://87.251.86.80:8080/api/health` с ПК печатает `{"db":true,"smtpLastOkAt":null}`; после перезагрузки `uname -r` показывает `5.14.0-758.el9…`.

## 0. Чем этот стенд отличается от продакшена

Продакшен-деплой входит в веху M6 и пока не сделан. На тестовом стенде нет следующего:

| Нет сейчас                                                                 | Где появится                                                     |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Продакшен-`Caddyfile` с HSTS, CSP и маршрутами sandboxd и контента         | M6, Task 1                                                       |
| Образы в GHCR, `deploy.sh <sha>` с откатом, деплой из GitHub Actions       | M6                                                               |
| Ежедневные бэкапы (`pg_dump` + restic в S3), `restore-test.sh`             | M6. До тех пор бэкап делается вручную (§10)                      |
| Алерты админам (RAM, диск, бэкап, 5xx)                                     | M6                                                               |
| `bootstrap-vps.sh`, Sysbox, сеть `rc-sbx`, зеркала пакетов/registry/dnsmasq, песочницы | M4b (§13, **открытый риск для CentOS**)              |
| Реальный SMTP                                                              | Как только выбран провайдер (§11). До этого письма лежат в Mailpit |
| HTTPS                                                                      | Как только есть домен (§12). До этого `COOKIE_SECURE=false`      |

Файлы стенда в репозитории:

- `infra/compose.vps-test.yaml` — overlay поверх `infra/compose.yaml`. Включает сборку из исходников, Mailpit на `127.0.0.1:8025` (наружу — только с паролем, §8) и Caddy с `Caddyfile.dev` на порту 8080. Postgres наружу не публикуется.
- `infra/vps.env.example` — шаблон. На сервере из него создаётся `infra/vps.env` с секретами. Этот файл есть в `.gitignore` и в git не попадает.
- `infra/compose.vps-tls.yaml` и `infra/Caddyfile.vps-tls` — необязательный HTTPS-слой для домена (§12).

Почему не годится обычный `docker compose up --build` из корня репозитория. Корневой `compose.yaml` подключает dev-overlay. Тот публикует Postgres (`5432`, пароль `rootcamp`) и Mailpit (`8025`) на всех интерфейсах, а опубликованные порты Docker **обходят файрвол** (firewalld, как и ufw, §3). На VPS такая база с известным паролем оказалась бы открыта в интернет. Голый `infra/compose.yaml` тоже не запустится: у Postgres пустой пароль, у Caddy нет конфига сайта и опубликованных портов, а у api нет секретов и сборки.

## 1. Первый вход и пользователь `deploy`

На ПК (PowerShell) создайте SSH-ключ, если его ещё нет, и положите публичную часть на сервер. `<IP>` — адрес VPS из панели провайдера.

```powershell
# только если файла $env:USERPROFILE\.ssh\id_ed25519 ещё нет
ssh-keygen -t ed25519 -C "rootcamp-vps"
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@<IP> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

На сервере, под root. В CentOS группа администраторов называется `wheel`, а `rsync` в минимальном образе нет, поэтому ключи копируются через `install`:

```bash
useradd -m -s /bin/bash -G wheel deploy
passwd -l deploy                      # пароля нет: вход только по ключу
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/deploy
chmod 440 /etc/sudoers.d/deploy
visudo -cf /etc/sudoers.d/deploy      # parsed OK
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
install -m 600 -o deploy -g deploy /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
```

Заблокированный пароль не мешает входу по ключу (`UsePAM yes`). Если sudo без пароля не нужен, вместо `passwd -l` и файла в `sudoers.d` задайте пароль командой `passwd deploy`: `wheel` уже даёт sudo с паролем.

**Проверка** (в новом окне PowerShell): `ssh deploy@<IP> "sudo -n true && echo ok"` входит без пароля и печатает `ok`; `ssh deploy@<IP> id` показывает группу `10(wheel)`.

Дальше все команды выполняются под `deploy`.

## 2. Только ключи, без входа root по паролю

Не закрывайте текущую сессию, пока не убедитесь, что вход по ключу работает.

```bash
sudo tee /etc/ssh/sshd_config.d/00-rootcamp.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
sudo chmod 600 /etc/ssh/sshd_config.d/00-rootcamp.conf
ls /etc/ssh/sshd_config.d/
# если там есть 01-permitrootlogin.conf (PermitRootLogin yes из образа провайдера) — убрать в сторону:
sudo mv /etc/ssh/sshd_config.d/01-permitrootlogin.conf /root/01-permitrootlogin.conf.disabled
sudo sshd -t && sudo systemctl reload sshd
```

Пояснения:

- В sshd побеждает первое найденное значение, а drop-in'ы читаются по алфавиту, поэтому файл называется `00-…`. Он уже перебивает `01-permitrootlogin.conf`, но этот файл всё равно убирается: иначе при удалении или переименовании нашего файла вход root по паролю молча вернётся. `50-redhat.conf` пароли не включает, его не трогайте.
- `PermitRootLogin prohibit-password`, а не `no`: пароль для root всё равно не принимается, но вход root по ключу остаётся запасным путём, если сломается `deploy` или его sudo. В выводе `sshd -T` это значение показывается как `without-password`.
- Служба в CentOS называется `sshd` (в Ubuntu — `ssh`).

**Проверка:** `sudo sshd -T | grep -E '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication)'` печатает `passwordauthentication no`, `kbdinteractiveauthentication no` и `permitrootlogin without-password`. Новые подключения `ssh deploy@<IP>` и `ssh root@<IP>` с ПК проходят по ключу, а `ssh -o PubkeyAuthentication=no deploy@<IP>` получает `Permission denied (publickey,…)`.

## 3. Файрвол firewalld

```bash
sudo systemctl enable --now firewalld
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --permanent --add-port=8080/tcp    # сайт тестового стенда по http
# позже, для HTTPS (§12):
#   sudo firewall-cmd --permanent --add-service=http --add-service=https --add-port=443/udp
#   sudo firewall-cmd --permanent --remove-port=8080/tcp
sudo firewall-cmd --reload
```

В зоне `public` образа CentOS заранее разрешены `cockpit` (порт 9090, на сервере его никто не слушает) и `dhcpv6-client`. Их можно оставить; убрать cockpit: `sudo firewall-cmd --permanent --remove-service=cockpit && sudo firewall-cmd --reload`.

firewalld **не защищает** порты, опубликованные Docker. Docker создаёт свою зону `docker` (target `ACCEPT`) для своих мостов и пропускает опубликованные порты собственными правилами nftables мимо зоны `public` — так же, как на Ubuntu мимо ufw. Поэтому в `compose.vps-test.yaml` Postgres не опубликован вовсе, а Mailpit по умолчанию привязан к `127.0.0.1`; это не перестраховка, а единственная защита. Не добавляйте `ports:` без `127.0.0.1:` в начале. Единственное исключение — Mailpit с паролем (§8, «Mailpit в браузере»); для наглядности его порт тоже добавляют в зону: `sudo firewall-cmd --permanent --add-port=8025/tcp && sudo firewall-cmd --reload`.

**Проверка:** `sudo firewall-cmd --list-all` (зона `public`) показывает `services: … ssh` и `ports: 8080/tcp`. После запуска стенда (§8) с ПК `Test-NetConnection <IP> -Port 8025` и `-Port 5432` дают `TcpTestSucceeded : False` (8025 — пока Mailpit не открыт по §8), а `-Port 8080` — `True`.

## 4. Обновления системы и dnf-automatic

```bash
sudo dnf -y upgrade --refresh
sudo dnf -y install git dnf-plugins-core curl tar openssl dnf-automatic
sudo sed -i -E 's/^upgrade_type\s*=.*/upgrade_type = default/; s/^apply_updates\s*=.*/apply_updates = yes/' /etc/dnf/automatic.conf
sudo systemctl enable --now dnf-automatic.timer
```

Почему `upgrade_type = default`, а не `security`: репозитории CentOS Stream не публикуют метаданные об исправлениях безопасности (updateinfo, `dnf updateinfo summary` пуст). С `security` dnf-automatic не находит «security»-обновлений и фактически ничего не ставит. `default` ставит все доступные обновления. Stream — rolling-ветка, так что изредка возможна регрессия; бэкап (§10) это покрывает.

На текущем сервере сейчас стоит `upgrade_type = security`. Переключить:

```bash
sudo sed -i -E 's/^upgrade_type\s*=.*/upgrade_type = default/' /etc/dnf/automatic.conf
```

Таймер перечитывает конфиг при каждом запуске, перезапускать ничего не нужно.

`reboot = never` (по умолчанию): новое ядро ставится, но применяется только после ручного `sudo reboot`. Нужна ли перезагрузка, показывает `sudo dnf needs-restarting -r`. Если обновится `docker-ce`, Docker перезапустится, а контейнеры поднимутся сами (`restart: unless-stopped`).

**Проверка:** `grep -E '^(upgrade_type|apply_updates)' /etc/dnf/automatic.conf` печатает `upgrade_type = default` и `apply_updates = yes`; `systemctl is-enabled dnf-automatic.timer` печатает `enabled`, а `systemctl list-timers dnf-automatic.timer` показывает время следующего запуска.

## 5. Docker Engine и compose plugin (официальный репозиторий Docker для CentOS)

```bash
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker       # dnf, в отличие от apt, сам Docker не запускает
sudo usermod -aG docker deploy
```

Выйдите из SSH и зайдите снова, чтобы группа `docker` применилась. Членство в `docker` равносильно root, поэтому так настраивается только `deploy`.

**Проверка:** `docker run --rm hello-world` печатает `Hello from Docker!`, `docker compose version` печатает `Docker Compose version v2.x` или новее (на сервере v5.6.1), `systemctl is-enabled docker` печатает `enabled`.

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

Первая сборка занимает 5–7 минут на 4 vCPU:

```bash
rc up -d --build
rc ps
curl -s http://127.0.0.1:8080/api/health; echo
sudo ss -tlnp | grep -E ':(5432|8025|8080)\b'
```

В логе сборки бывают строки `cpu-features: Unable to detect compiler type` и `gyp ERR! Could not find any Python installation`. Это необязательные нативные зависимости `ssh2`, которые не собираются в `node:22-alpine`. Ошибки не фатальные: сборка завершается, api работает. Обращать внимание стоит, только если сама команда `up --build` завершилась с ошибкой.

**Проверка:**

- `rc ps`: `postgres`, `api` и `mailpit` в статусе `Up … (healthy)`, `caddy` в статусе `Up` (у caddy в этом overlay нет healthcheck, поэтому `(healthy)` не бывает).
- `curl` печатает `{"db":true,"smtpLastOkAt":null}`. Миграции api применяет сам при старте.
- `ss`: порт 8080 слушается на `0.0.0.0` и `[::]`, 8025 только на `127.0.0.1`, порта 5432 в списке нет.

С ПК (PowerShell):

```powershell
curl.exe -s http://<IP>:8080/api/health
curl.exe -s -X POST -H "X-RC: 1" -H "Origin: http://wrong.example" http://<IP>:8080/api/auth/logout
curl.exe -s -o NUL -w "%{http_code}`n" -X POST -H "X-RC: 1" -H "Origin: http://<IP>:8080" http://<IP>:8080/api/auth/logout
```

Если на ПК задан `HTTP_PROXY`/`HTTPS_PROXY`, добавляйте к `curl.exe` ключ `--noproxy "*"`. Иначе ответы (например, `503` на порт 8025) придут от локального прокси, а не от VPS. Для проверки открытых портов надёжнее `Test-NetConnection` (§3).

**Проверка:** первая команда печатает `{"db":true,...}`, вторая ответ с `csrf` (403), третья код **не** `403` (обычно `204`). Значит, `PUBLIC_ORIGIN` совпадает с адресом.

### Первый пользователь и админ

1. Откройте в браузере `http://<IP>:8080` (ровно этот адрес, как в `PUBLIC_ORIGIN`) и зарегистрируйтесь.
2. Письмо с подтверждением лежит в Mailpit. Mailpit наружу не открыт, поэтому на ПК откройте SSH-туннель и оставьте окно открытым:

   ```powershell
   ssh -N -L 8025:127.0.0.1:8025 deploy@<IP>
   ```

   Затем откройте `http://127.0.0.1:8025`. Это адрес на ПК, туннель ведёт на Mailpit сервера. Если Mailpit открыт наружу (ниже), туннель не нужен: `http://<IP>:8025` с логином и паролем.

3. Выдайте себе права админа:

   ```bash
   rc exec api node dist/cli.js admin:grant you@example.com
   ```

**Проверка:** печатается `granted admin to you@example.com (<uuid>)`. Для несуществующего email печатается `no user with email …` с кодом выхода 1. Админка появится в M5, пока флаг только записывается в БД.

### Mailpit в браузере (без туннеля, с паролем)

Можно открыть Mailpit как `http://<IP>:8025`. **Внимание:** в письмах лежат ссылки подтверждения и сброса пароля; кто прочитал Mailpit, тот может войти в любой аккаунт стенда. Поэтому наружу Mailpit открывается только с basic auth: compose откажется стартовать, если задан `MAILPIT_BIND`, но не задан `MAILPIT_UI_AUTH_FILE`. Пароль лежит в отдельном файле и монтируется в контейнер, поэтому в `docker inspect` его не видно.

```bash
cd ~/rootcamp
printf 'rootcamp:%s\n' "$(openssl rand -base64 18 | tr -d '/+=')" > infra/mailpit-ui.auth
chmod 600 infra/mailpit-ui.auth            # файл git-ignored
printf 'MAILPIT_BIND=8025\nMAILPIT_UI_AUTH_FILE=./mailpit-ui.auth\n' >> infra/vps.env
sudo firewall-cmd --permanent --add-port=8025/tcp && sudo firewall-cmd --reload
rc up -d mailpit
```

Логин и пароль (строка `логин:пароль`) посмотреть с ПК: `ssh deploy@<IP> 'cat ~/rootcamp/infra/mailpit-ui.auth'`. Сменить пароль: перезаписать файл той же командой `printf` и выполнить `rc up -d --force-recreate mailpit`.

Вернуть «только через туннель»: удалить строки `MAILPIT_BIND` и `MAILPIT_UI_AUTH_FILE` из `infra/vps.env`, выполнить `rc up -d mailpit` и `sudo firewall-cmd --permanent --remove-port=8025/tcp && sudo firewall-cmd --reload`.

**Проверка:** с ПК `curl.exe -s -o NUL -w "%{http_code}" http://<IP>:8025/` печатает `401`, а с `-u rootcamp:<пароль>` — `200`. На сервере `ss -tlnp | grep 8025` показывает `0.0.0.0:8025`.

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

**Перезагрузка сервера** (например, ради нового ядра): `sudo reboot`. Docker включён в автозапуск, у всех сервисов `restart: unless-stopped`, так что стенд поднимается сам. Исключение: сервисы, остановленные вручную через `rc stop`, после перезагрузки остаются остановленными.

**Проверка:** через 1–2 минуты после перезагрузки `rc ps` показывает те же статусы, что в §8, а health печатает `{"db":true,...}`.

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

Если нужен ежедневный дамп, добавьте задание через `crontab -e` (в CentOS cron — это служба `crond`, она включена по умолчанию). Используйте полный путь вместо алиаса и экранируйте `%`:

```
30 3 * * * cd $HOME/rootcamp && docker compose -p rootcamp --env-file infra/versions.env --env-file infra/vps.env -f infra/compose.yaml -f infra/compose.vps-test.yaml exec -T postgres pg_dump -U rootcamp -d rootcamp -Fc > $HOME/backups/rootcamp-$(date +\%Y\%m\%d).dump && find $HOME/backups -name '*.dump' -mtime +7 -delete
```

**Проверка:** `crontab -l` показывает строку, а на следующий день в `~/backups` появляется файл с датой.

## 11. Реальный SMTP (когда выбран провайдер)

Нужен ящик и пароль приложения (не основной пароль от почты):

- Яндекс: `SMTP_HOST=smtp.yandex.ru`, `SMTP_PORT=465`;
- Mail.ru: `SMTP_HOST=smtp.mail.ru`, `SMTP_PORT=465`.

На порту 465 api включает TLS сразу, на 587 используется STARTTLS. `SMTP_FROM` должен совпадать с ящиком, например `rootcamp <box@yandex.ru>`. Заполните `SMTP_*` в `infra/vps.env` через `nano infra/vps.env` (или `vi`, если nano нет: `sudo dnf -y install nano`), затем:

```bash
rc up -d
```

**Проверка:** запросите письмо (регистрация или «забыли пароль») на реальный адрес. Письмо приходит, а `curl -s http://127.0.0.1:8080/api/health` показывает `smtpLastOkAt` с текущим временем вместо `null`. Если письмо не уходит, смотрите `rc logs api | grep -i smtp`. Некоторые VPS-провайдеры блокируют исходящие 465 и 587, проверить можно командой `curl -v --max-time 5 telnet://smtp.yandex.ru:465` (соединение `Connected` — порт открыт).

Mailpit после этого продолжает работать, но письма в него больше не попадают.

## 12. HTTPS по домену (необязательно, когда домен есть)

Caddy сам получит сертификат Let's Encrypt, если A-запись домена указывает на VPS, а порты 80 и 443 открыты.

1. В DNS создайте A-запись `rootcamp.example.ru → <IP>`.
   **Проверка:** `getent hosts rootcamp.example.ru` печатает `<IP>`.
2. Откройте порты 80 и 443 (443/udp — для HTTP/3), а 8080 закройте:

   ```bash
   sudo firewall-cmd --permanent --add-service=http --add-service=https --add-port=443/udp
   sudo firewall-cmd --permanent --remove-port=8080/tcp
   sudo firewall-cmd --reload
   ```

   **Проверка:** `sudo firewall-cmd --list-all` показывает `services: … http https ssh` и `ports: 443/udp` без `8080/tcp`.

3. В `infra/vps.env` задайте:

   ```
   DOMAIN=rootcamp.example.ru
   PUBLIC_ORIGIN=https://rootcamp.example.ru
   COOKIE_SECURE=true
   SITE_BIND=127.0.0.1:8080
   ```

   `compose.vps-tls.yaml` в любом случае выставляет `PUBLIC_ORIGIN=https://$DOMAIN` и `COOKIE_SECURE=true`. Значения в `vps.env` только держат файл в согласованном виде. `SITE_BIND=127.0.0.1:8080` обязателен: удаление 8080 из firewalld старый http-порт **не** закрывает, потому что опубликованные Docker порты идут мимо зоны `public` (§3).

4. Подключите TLS-слой в алиас и перезапустите:

   ```bash
   sed -i 's|compose.vps-test.yaml'"'"'$|compose.vps-test.yaml -f $HOME/rootcamp/infra/compose.vps-tls.yaml'"'"'|' ~/.bashrc
   source ~/.bashrc && rc config --quiet && rc up -d
   ```

**Проверка:** `alias rc` заканчивается на `compose.vps-tls.yaml'`. `rc logs caddy | grep -i "certificate obtained"` находит строку о выданном сертификате. С ПК `curl.exe -s https://rootcamp.example.ru/api/health` печатает `{"db":true,...}`, а `curl.exe -sI http://rootcamp.example.ru` отвечает `308` с переходом на https. `Test-NetConnection <IP> -Port 8080` даёт `False`. Сайт открывается по `https://rootcamp.example.ru`, вход сохраняет сессию.

Это всё ещё тестовая конфигурация: в ней нет HSTS, CSP и остальных заголовков из продакшен-`Caddyfile` (M6).

## 13. Позже: Sysbox (с вехи M4b) — открытый риск

Сейчас Sysbox не нужен: песочниц ещё нет. В M4b появится `infra/scripts/bootstrap-vps.sh`. Он поставит Sysbox CE (версия будет в `infra/versions.env`), swap 2 ГБ, сеть `rc-sbx`, юнит `rc-sbx-firewall` и зеркала.

**Для CentOS Stream 9 официального пакета Sysbox CE нет.** Nestybox выпускает пакеты только для Ubuntu и Debian (`.deb`), а `bootstrap-vps.sh` планировался под них. Перед M4b нужно выбрать один из путей:

- собрать Sysbox из исходников под ядро el9 (https://github.com/nestybox/sysbox/blob/master/docs/developers-guide/build.md) и проверить, что он работает с этим ядром и cgroup v2; поддерживать сборку при каждом обновлении придётся самим;
- переустановить VPS на Ubuntu 24.04 (приложение ниже), перенеся данные бэкапом из §10.

Пока выбор не сделан, это **открытый риск M4b**. Что верно в обоих случаях:

- Sysbox требует KVM или bare metal. Этот VPS (KVM) подходит.
- Установщик перезапускает Docker. Перед установкой выполните `rc down` (данные сохранятся) и бэкап по §10.

**Проверка (после установки):** `docker info | grep -i runtimes` показывает `sysbox-runc`.

## 14. Что нужно от пользователя, чтобы Claude развернул стенд сам

Claude Code работает на ПК пользователя, поэтому ходит на сервер по SSH с этого же ПК.

1. **SSH-доступ.** Выполните шаги 1–2 этого руководства, чтобы ключ ПК (`%USERPROFILE%\.ssh\id_ed25519.pub`) оказался в `~deploy/.ssh/authorized_keys`, и сообщите `deploy@<IP>`. Для удобства можно добавить запись в `%USERPROFILE%\.ssh\config`:

   ```
   Host rootcamp-vps
       HostName <IP>
       User deploy
       IdentityFile ~/.ssh/id_ed25519
   ```

   **Приватный ключ, пароль root и пароль sudo в чат не присылайте.** Для неинтерактивной работы Claude нужен `sudo` без пароля (`/etc/sudoers.d/deploy` из §1). Если держать его постоянно не хочется, создайте файл на время установки и удалите после. Или выполните шаги 2–5 самостоятельно и поручите Claude только шаги 6–10.

   **Проверка:** `ssh -o BatchMode=yes rootcamp-vps "sudo -n true && echo ok"` с ПК печатает `ok`.

2. **Домен** (для §12): имя и подтверждение, что A-запись указывает на VPS.
3. **SMTP** (для §11): провайдер и ящик. Пароль приложения впишите в `infra/vps.env` на сервере сами (`nano`). Claude генерирует секреты прямо на сервере (`openssl rand`) и в чат их не выводит.
4. **S3** (для бэкапов M6): пока не нужен.

Все секреты хранятся только в `infra/vps.env` на сервере (права `600`, файл в `.gitignore`), никогда в git и никогда в чате. Перед необратимыми командами (`down -v`, восстановление из бэкапа, изменение firewalld и sshd, перезагрузка) Claude спрашивает подтверждение.

## Приложение: если Ubuntu 24.04

Шаги 1–5 для Ubuntu 24.04. Шаги 6–11 и 14 те же; в §12 вместо firewalld используется ufw; Sysbox (§13) ставится официальным `.deb` без сборки.

**1. Пользователь.** Ключ на сервер — как в §1 (PowerShell). Под root:

```bash
adduser --gecos "" deploy            # спросит пароль: он нужен для sudo, не для SSH
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

**Проверка:** `ssh deploy@<IP> "sudo -v && echo ok"` входит без пароля SSH, запрашивает пароль sudo и печатает `ok`.

**2. sshd.** Тот же файл `00-rootcamp.conf`, что в §2 (`PermitRootLogin no` или `prohibit-password`). Номер `00` важен: иначе его перебьёт `50-cloud-init.conf`, где бывает `PasswordAuthentication yes`. Служба называется `ssh`:

```bash
sudo sshd -t && sudo systemctl reload ssh
```

**Проверка:** `sudo sshd -T | grep -E '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication)'` печатает `no` для паролей и выбранное значение `permitrootlogin`; новое `ssh deploy@<IP>` проходит.

**3. ufw.**

```bash
sudo ufw allow OpenSSH
sudo ufw allow 8080/tcp
# позже, для HTTPS (§12): sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw delete allow 8080/tcp
sudo ufw enable
```

ufw, как и firewalld, порты Docker не закрывает: правила Docker стоят в iptables раньше правил ufw (см. §3).

**Проверка:** `sudo ufw status` показывает `Status: active`, `OpenSSH ALLOW Anywhere`, `8080/tcp ALLOW Anywhere`.

**4. Автообновления.**

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y unattended-upgrades ca-certificates curl git openssl
sudo dpkg-reconfigure -plow unattended-upgrades     # ответить Yes
```

**Проверка:** `systemctl is-enabled unattended-upgrades` печатает `enabled`, а `/etc/apt/apt.conf.d/20auto-upgrades` содержит две строки со значением `"1"`.

**5. Docker** из официального apt-репозитория:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy
```

apt запускает и включает Docker сам. Перелогиньтесь, чтобы применилась группа `docker`.

**Проверка:** `docker run --rm hello-world` печатает `Hello from Docker!`, `docker compose version` — v2.x или новее.

**Sysbox (§13) на Ubuntu:** официальный пакет Sysbox CE (`.deb`, https://github.com/nestybox/sysbox/blob/master/docs/user-guide/install-package.md); нужно штатное ядро Ubuntu.
