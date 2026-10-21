# Тестовый стенд rootcamp на VPS

Как поднять на VPS **тестовый** стенд rootcamp и дальше тестировать на нём. Образы собираются из исходников прямо на сервере. Письма до подключения SMTP перехватывает Mailpit. Сайт открывается по `http://<IP>:8080`, HTTPS подключается позже, когда появится домен (§12).

VPS: 4 vCPU, 8 ГБ RAM, 80 ГБ NVMe, KVM, Ubuntu 24.04. Команды ниже выполняются в bash на сервере, если не сказано другое. Команды для Windows-ПК даны для PowerShell 5.1. Каждый шаг заканчивается строкой **Проверка** с ожидаемым результатом.

## 0. Чем этот стенд отличается от продакшена

Продакшен-деплой входит в веху M6 и пока не сделан. На тестовом стенде нет следующего:

| Нет сейчас | Где появится |
|---|---|
| Продакшен-`Caddyfile` с HSTS, CSP и маршрутами sandboxd и контента | M6, Task 1 |
| Образы в GHCR, `deploy.sh <sha>` с откатом, деплой из GitHub Actions | M6 |
| Ежедневные бэкапы (`pg_dump` + restic в S3), `restore-test.sh` | M6. До тех пор бэкап делается вручную (§10) |
| Алерты админам (RAM, диск, бэкап, 5xx) | M6 |
| `bootstrap-vps.sh`, Sysbox, сеть `rc-sbx`, зеркала apt/registry/dnsmasq, песочницы | M4b (§13) |
| Реальный SMTP | Как только выбран провайдер (§11). До этого письма лежат в Mailpit |
| HTTPS | Как только есть домен (§12). До этого `COOKIE_SECURE=false` |

Файлы стенда в репозитории:

- `infra/compose.vps-test.yaml` — overlay поверх `infra/compose.yaml`. Включает сборку из исходников, Mailpit на `127.0.0.1:8025` и Caddy с `Caddyfile.dev` на порту 8080. Postgres наружу не публикуется.
- `infra/vps.env.example` — шаблон. На сервере из него создаётся `infra/vps.env` с секретами. Этот файл есть в `.gitignore` и в git не попадает.
- `infra/compose.vps-tls.yaml` и `infra/Caddyfile.vps-tls` — необязательный HTTPS-слой для домена (§12).

Почему не годится обычный `docker compose up --build` из корня репозитория. Корневой `compose.yaml` подключает dev-overlay. Тот публикует Postgres (`5432`, пароль `rootcamp`) и Mailpit (`8025`) на всех интерфейсах, а опубликованные порты Docker **обходят ufw**. На VPS такая база с известным паролем оказалась бы открыта в интернет. Голый `infra/compose.yaml` тоже не запустится: у Postgres пустой пароль, у Caddy нет конфига сайта и опубликованных портов, а у api нет секретов и сборки.

## 1. Первый вход и пользователь `deploy`

На ПК (PowerShell) создайте SSH-ключ, если его ещё нет, и положите публичную часть на сервер. `<IP>` — адрес VPS из панели провайдера.

```powershell
# только если файла $env:USERPROFILE\.ssh\id_ed25519 ещё нет
ssh-keygen -t ed25519 -C "rootcamp-vps"
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@<IP> "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

На сервере, под root:

```bash
adduser --gecos "" deploy            # спросит пароль: он нужен для sudo, не для SSH
usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

**Проверка** (в новом окне PowerShell): `ssh deploy@<IP> "sudo -v && echo ok"` входит без пароля SSH, запрашивает пароль sudo и печатает `ok`.

Дальше все команды выполняются под `deploy`.

## 2. Только ключи, без входа root по паролю

Не закрывайте текущую сессию, пока не убедитесь, что вход по ключу работает.

```bash
sudo tee /etc/ssh/sshd_config.d/00-rootcamp.conf >/dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sudo sshd -t && sudo systemctl reload ssh
```

Файл называется `00-…`, потому что в sshd побеждает первое найденное значение. Если бы он шёл позже, его перебил бы `50-cloud-init.conf`, где бывает `PasswordAuthentication yes`.

**Проверка:** `sudo sshd -T | grep -E '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication)'` печатает `passwordauthentication no`, `kbdinteractiveauthentication no` и `permitrootlogin no`. Новое подключение `ssh deploy@<IP>` с ПК проходит.

## 3. Файрвол ufw

```bash
sudo ufw allow OpenSSH
sudo ufw allow 8080/tcp      # сайт тестового стенда по http
# позже, для HTTPS (§12): sudo ufw allow 80/tcp && sudo ufw allow 443
sudo ufw enable
```

ufw **не защищает** порты, опубликованные Docker: правила Docker стоят в iptables раньше правил ufw. Поэтому в `compose.vps-test.yaml` Postgres не опубликован вовсе, а Mailpit привязан к `127.0.0.1`. Не добавляйте `ports:` без `127.0.0.1:` в начале.

**Проверка:** `sudo ufw status` показывает `Status: active` и строки `OpenSSH ALLOW Anywhere`, `8080/tcp ALLOW Anywhere`.

## 4. Автоматические обновления безопасности

```bash
sudo apt-get update && sudo apt-get -y upgrade
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades     # ответить Yes
```

**Проверка:** `systemctl is-enabled unattended-upgrades` печатает `enabled`, а `cat /etc/apt/apt.conf.d/20auto-upgrades` показывает две строки со значением `"1"`.

## 5. Docker Engine и compose plugin (официальный apt-репозиторий Docker)

```bash
sudo apt-get install -y ca-certificates curl git openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker deploy
```

Выйдите из SSH и зайдите снова, чтобы группа `docker` применилась. Членство в `docker` равносильно root, поэтому так настраивается только `deploy`.

**Проверка:** `docker run --rm hello-world` печатает `Hello from Docker!`, а `docker compose version` печатает `Docker Compose version v2.x` или новее.

Если не скачиваются образы с Docker Hub (на части российских VPS бывает), сначала проверьте `docker pull postgres:16`. Без доступа к Docker Hub стенд не соберётся.

## 6. Код

Node.js и pnpm на сервер ставить не нужно. Оба Dockerfile (`apps/api/Dockerfile`, `apps/web/Dockerfile`) сами берут `node:22-alpine`, включают pnpm через corepack и собирают всё внутри Docker.

```bash
git clone https://github.com/BirraSolitaria/rootcamp.git ~/rootcamp
cd ~/rootcamp
```

**Проверка:** `git -C ~/rootcamp log --oneline -1` показывает последний коммит `main`, а `ls ~/rootcamp/infra` содержит `compose.vps-test.yaml` и `vps.env.example`.

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

Чтобы не набирать длинную команду каждый раз, заведите алиас `rc`:

```bash
cat >> ~/.bashrc <<'EOF'
alias rc='docker compose -p rootcamp --env-file $HOME/rootcamp/infra/versions.env --env-file $HOME/rootcamp/infra/vps.env -f $HOME/rootcamp/infra/compose.yaml -f $HOME/rootcamp/infra/compose.vps-test.yaml'
EOF
source ~/.bashrc
rc config --quiet && echo config-ok
```

**Проверка:** выводится `config-ok`. Если какой-то секрет пуст, compose остановится с сообщением `required variable … is missing a value: set … in infra/vps.env`.

Первая сборка занимает несколько минут:

```bash
rc up -d --build
rc ps
curl -s http://127.0.0.1:8080/api/health; echo
sudo ss -tlnp | grep -E ':(5432|8025|8080)\b'
```

**Проверка:**

- `rc ps`: `postgres`, `api` и `caddy` в статусе `Up … (healthy)`, `mailpit` в статусе `Up`.
- `curl` печатает `{"db":true,"smtpLastOkAt":null}`. Миграции api применяет сам при старте.
- `ss`: порт 8080 слушается на `0.0.0.0`, 8025 только на `127.0.0.1`, порта 5432 в списке нет.

С ПК (PowerShell):

```powershell
curl.exe -s http://<IP>:8080/api/health
curl.exe -s -X POST -H "X-RC: 1" -H "Origin: http://wrong.example" http://<IP>:8080/api/auth/logout
curl.exe -s -o NUL -w "%{http_code}`n" -X POST -H "X-RC: 1" -H "Origin: http://<IP>:8080" http://<IP>:8080/api/auth/logout
```

**Проверка:** первая команда печатает `{"db":true,...}`, вторая ответ с `csrf` (403), третья код **не** `403` (обычно `204`). Значит, `PUBLIC_ORIGIN` совпадает с адресом.

### Первый пользователь и админ

1. Откройте в браузере `http://<IP>:8080` (ровно этот адрес, как в `PUBLIC_ORIGIN`) и зарегистрируйтесь.
2. Письмо с подтверждением лежит в Mailpit. Mailpit наружу не открыт, поэтому на ПК откройте SSH-туннель и оставьте окно открытым:

   ```powershell
   ssh -N -L 8025:127.0.0.1:8025 deploy@<IP>
   ```

   Затем откройте `http://127.0.0.1:8025`. Это адрес на ПК, туннель ведёт на Mailpit сервера.
3. Выдайте себе права админа:

   ```bash
   rc exec api node dist/cli.js admin:grant you@example.com
   ```

**Проверка:** печатается `granted admin to you@example.com (<uuid>)`. Для несуществующего email печатается `no user with email …` с кодом выхода 1. Админка появится в M5, пока флаг только записывается в БД.

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

Если нужен ежедневный дамп, добавьте задание через `crontab -e`. Используйте полный путь вместо алиаса и экранируйте `%`:

```
30 3 * * * cd $HOME/rootcamp && docker compose -p rootcamp --env-file infra/versions.env --env-file infra/vps.env -f infra/compose.yaml -f infra/compose.vps-test.yaml exec -T postgres pg_dump -U rootcamp -d rootcamp -Fc > $HOME/backups/rootcamp-$(date +\%Y\%m\%d).dump && find $HOME/backups -name '*.dump' -mtime +7 -delete
```

## 11. Реальный SMTP (когда выбран провайдер)

Нужен ящик и пароль приложения (не основной пароль от почты):

- Яндекс: `SMTP_HOST=smtp.yandex.ru`, `SMTP_PORT=465`;
- Mail.ru: `SMTP_HOST=smtp.mail.ru`, `SMTP_PORT=465`.

На порту 465 api включает TLS сразу, на 587 используется STARTTLS. `SMTP_FROM` должен совпадать с ящиком, например `rootcamp <box@yandex.ru>`. Заполните `SMTP_*` в `infra/vps.env` через `nano infra/vps.env`, затем:

```bash
rc up -d
```

**Проверка:** запросите письмо (регистрация или «забыли пароль») на реальный адрес. Письмо приходит, а `curl -s http://127.0.0.1:8080/api/health` показывает `smtpLastOkAt` с текущим временем вместо `null`. Если письмо не уходит, смотрите `rc logs api | grep -i smtp`. Некоторые VPS-провайдеры блокируют исходящие 465 и 587, проверить можно командой `nc -vz smtp.yandex.ru 465`.

Mailpit после этого продолжает работать, но письма в него больше не попадают.

## 12. HTTPS по домену (необязательно, когда домен есть)

Caddy сам получит сертификат Let's Encrypt, если A-запись домена указывает на VPS, а порты 80 и 443 открыты.

1. В DNS создайте A-запись `rootcamp.example.ru → <IP>`.
   **Проверка:** `getent hosts rootcamp.example.ru` печатает `<IP>`.
2. Откройте порты 80 и 443, а 8080 закройте:

   ```bash
   sudo ufw allow 80/tcp && sudo ufw allow 443 && sudo ufw delete allow 8080/tcp
   ```

3. В `infra/vps.env` задайте:

   ```
   DOMAIN=rootcamp.example.ru
   PUBLIC_ORIGIN=https://rootcamp.example.ru
   COOKIE_SECURE=true
   SITE_BIND=127.0.0.1:8080
   ```

   `compose.vps-tls.yaml` в любом случае выставляет `PUBLIC_ORIGIN=https://$DOMAIN` и `COOKIE_SECURE=true`. Значения в `vps.env` только держат файл в согласованном виде. `SITE_BIND=127.0.0.1:8080` убирает старый http-порт с публичного интерфейса, потому что ufw его не закрывает (см. §3).
4. Подключите TLS-слой в алиас и перезапустите:

   ```bash
   sed -i 's|compose.vps-test.yaml'"'"'$|compose.vps-test.yaml -f $HOME/rootcamp/infra/compose.vps-tls.yaml'"'"'|' ~/.bashrc
   source ~/.bashrc && rc config --quiet && rc up -d
   ```

**Проверка:** `alias rc` заканчивается на `compose.vps-tls.yaml'`. `rc logs caddy | grep -i "certificate obtained"` находит строку о выданном сертификате. С ПК `curl.exe -s https://rootcamp.example.ru/api/health` печатает `{"db":true,...}`, а `curl.exe -sI http://rootcamp.example.ru` отвечает `308` с переходом на https. Сайт открывается по `https://rootcamp.example.ru`, вход сохраняет сессию.

Это всё ещё тестовая конфигурация: в ней нет HSTS, CSP и остальных заголовков из продакшен-`Caddyfile` (M6).

## 13. Позже: Sysbox (с вехи M4b)

Сейчас Sysbox не нужен: песочниц ещё нет. В M4b появится `infra/scripts/bootstrap-vps.sh`. Он поставит Sysbox CE из `.deb` (версия будет в `infra/versions.env`), swap 2 ГБ, сеть `rc-sbx`, юнит `rc-sbx-firewall` и зеркала. Ручная установка описана в https://github.com/nestybox/sysbox/blob/master/docs/user-guide/install-package.md. Учтите:

- Sysbox требует KVM или bare metal и штатного ядра Ubuntu. Этот VPS подходит.
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

   **Приватный ключ, пароль root и пароль sudo в чат не присылайте.** Для `sudo` без пароля на время установки можно временно создать `/etc/sudoers.d/deploy` с `deploy ALL=(ALL) NOPASSWD:ALL` и удалить его после. Или выполнить шаги 2–5 самостоятельно и поручить Claude только шаги 6–10.
2. **Домен** (для §12): имя и подтверждение, что A-запись указывает на VPS.
3. **SMTP** (для §11): провайдер и ящик. Пароль приложения впишите в `infra/vps.env` на сервере сами (`nano`). Claude генерирует секреты прямо на сервере (`openssl rand`) и в чат их не выводит.
4. **S3** (для бэкапов M6): пока не нужен.

Все секреты хранятся только в `infra/vps.env` на сервере (права `600`, файл в `.gitignore`), никогда в git и никогда в чате. Перед необратимыми командами (`down -v`, восстановление из бэкапа, изменение ufw и sshd) Claude спрашивает подтверждение.
