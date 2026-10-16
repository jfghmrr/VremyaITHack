#!/usr/bin/env bash
# Однократная установка сайта Перепева в nginx хоста: https://perepev.lumnex.ru → 127.0.0.1:8097.
#
#   sudo bash deploy/nginx/install-site.sh
#
# Повторный запуск безопасен. Скрипт:
#   1. получает сертификат Let's Encrypt (certbot --cert-name perepev), если его ещё нет;
#   2. ставит /etc/nginx/sites-available/perepev.lumnex.ru.conf (копия
#      deploy/nginx/perepev.lumnex.ru.conf) и ссылку на него в sites-enabled;
#   3. перезагружает nginx только после успешного nginx -t; при любой ошибке возвращает
#      файлы сайта в прежнее состояние.
# Файлы других сайтов не меняются.
#
# Проверка домена (ACME_METHOD):
#   auto            по умолчанию: DNS-01 через Cloudflare, если установлен плагин
#                   certbot dns-cloudflare и есть ключ, которым уже выпущен сертификат зоны
#                   lumnex.ru; иначе webroot;
#   dns-cloudflare  DNS-01; ключ — CF_CREDENTIALS=/путь/к/ini или найденный автоматически;
#   webroot         HTTP-01 через /var/www/perepev-acme; нужен внешний порт 80 на этот nginx.
# Другие переменные:
#   CERTBOT_EMAIL=почта  только если на сервере ещё нет аккаунта Let's Encrypt;
#   SKIP_HTTP_PROBE=1    webroot: не проверять заранее, что порт 80 ведёт на этот nginx;
#   SKIP_DRY_RUN=1       не проверять продление (certbot renew --dry-run).
set -Eeuo pipefail

DOMAIN=perepev.lumnex.ru
ZONE=lumnex.ru
CERT_NAME=perepev
UPSTREAM=127.0.0.1:8097
SITE_FILE=/etc/nginx/sites-available/$DOMAIN.conf
SITE_LINK=/etc/nginx/sites-enabled/$DOMAIN.conf
WEBROOT=/var/www/perepev-acme
LIVE=/etc/letsencrypt/live/$CERT_NAME
ACCOUNTS=/etc/letsencrypt/accounts/acme-v02.api.letsencrypt.org/directory
RENEWAL=/etc/letsencrypt/renewal
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEMPLATE=$SCRIPT_DIR/$DOMAIN.conf

say() { printf '==> %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }
die() {
	printf 'ОШИБКА: %s\n' "$*" >&2
	exit 1
}

[[ $(id -u) -eq 0 ]] || die "нужны права root: sudo bash $0"
[[ -r $TEMPLATE ]] || die "не найден шаблон $TEMPLATE"
for cmd in nginx certbot openssl curl install cmp; do
	command -v "$cmd" >/dev/null || die "не найдена команда $cmd"
done

reload_nginx() {
	if [[ -d /run/systemd/system ]] && systemctl is-active --quiet nginx; then
		systemctl reload nginx
	else
		nginx -s reload
	fi
}

TMP=$(mktemp -d)
NGINX_LOG=$TMP/nginx-t.log
BACKUP=$TMP/site.conf
HAD_FILE=0
HAD_LINK=0
TOUCHED=0

# Откат: файл сайта и ссылка возвращаются к состоянию до запуска скрипта.
restore() {
	if ((HAD_FILE)); then
		cp -p "$BACKUP" "$SITE_FILE"
	else
		rm -f "$SITE_FILE"
	fi
	((HAD_LINK)) || rm -f "$SITE_LINK"
	if nginx -t >/dev/null 2>&1; then
		reload_nginx && warn "файлы сайта возвращены в прежнее состояние, nginx перезагружен"
	else
		warn "после отката nginx -t всё ещё не проходит — проверь конфигурацию вручную: nginx -t"
	fi
}

on_exit() {
	local rc=$?
	if ((rc != 0 && TOUCHED)); then
		restore || true
	fi
	rm -rf "$TMP"
	exit "$rc"
}
trap on_exit EXIT

# Ставит файл сайта, проверяет nginx -t и перезагружает nginx. При ошибке — откат (on_exit).
apply_conf() {
	local src=$1 what=$2
	TOUCHED=1
	install -m 0644 -o root -g root "$src" "$SITE_FILE.new"
	mv -f "$SITE_FILE.new" "$SITE_FILE"
	ln -sfn "$SITE_FILE" "$SITE_LINK"
	if ! nginx -t >"$NGINX_LOG" 2>&1; then
		cat "$NGINX_LOG" >&2
		die "nginx -t не прошёл ($what), изменения отменены"
	fi
	reload_nginx
	say "nginx перезагружен: $what"
}

say "Перепев: сайт $DOMAIN → $UPSTREAM"

# Исходная конфигурация должна быть рабочей, иначе ошибку нельзя будет отличить от нашей.
if ! nginx -t >"$NGINX_LOG" 2>&1; then
	cat "$NGINX_LOG" >&2
	die "текущая конфигурация nginx не проходит nginx -t; исправь её до установки"
fi

# Ссылка в sites-enabled должна быть нашей (или отсутствовать).
if [[ -e $SITE_LINK || -L $SITE_LINK ]]; then
	[[ -L $SITE_LINK && $(readlink -f "$SITE_LINK") == "$SITE_FILE" ]] ||
		die "$SITE_LINK уже существует и указывает не на $SITE_FILE — разберись вручную"
	HAD_LINK=1
fi
if [[ -e $SITE_FILE ]]; then
	cp -p "$SITE_FILE" "$BACKUP"
	HAD_FILE=1
fi

# Домен не должен обслуживаться другим включённым сайтом.
domain_re=${DOMAIN//./\\.}
while IFS= read -r f; do
	[[ $(readlink -f "$f") == "$SITE_FILE" ]] && continue
	die "домен $DOMAIN уже указан в $f — два сайта с одним именем nginx не разделит"
done < <(grep -lsE "server_name[^;]*[[:space:]]$domain_re([[:space:];]|$)" /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf || true)

if curl -fsS --max-time 5 -o /dev/null "http://$UPSTREAM/api/health"; then
	say "контейнеры отвечают на $UPSTREAM"
else
	warn "на http://$UPSTREAM/api/health нет ответа — запусти контейнеры: docker compose -p perepev up -d --build --wait"
	warn "сайт всё равно будет установлен; до запуска контейнеров nginx будет отвечать 502"
fi

install -d -m 0755 "$WEBROOT/.well-known/acme-challenge"

# ---- Сертификат ----
cert_ok() { [[ -s $LIVE/fullchain.pem && -s $LIVE/privkey.pem ]]; }

has_cf_plugin() { certbot plugins 2>/dev/null | grep '^\* dns-cloudflare$' >/dev/null; }

# Ключ Cloudflare, которым уже продлевается сертификат зоны $ZONE (самый свежий).
find_cf_credentials() {
	local conf name creds
	while IFS= read -r conf; do
		name=$(basename "$conf" .conf)
		[[ $name == "$CERT_NAME" ]] && continue
		creds=$(awk -F' *= *' '$1 == "dns_cloudflare_credentials" { print $2 }' "$conf")
		[[ -n $creds && -r $creds ]] || continue
		openssl x509 -in "/etc/letsencrypt/live/$name/cert.pem" -noout -ext subjectAltName 2>/dev/null |
			grep -E "DNS:([^, ]*\.)?${ZONE//./\\.}(,|[[:space:]]*$)" >/dev/null || continue
		CF_CREDENTIALS=$creds
		CF_PROPAGATION=$(awk -F' *= *' '$1 == "dns_cloudflare_propagation_seconds" { print $2 }' "$conf")
		say "ключ Cloudflare взят у сертификата $name: $creds"
		return 0
	done < <(ls -1t "$RENEWAL"/*.conf 2>/dev/null)
	return 1
}

# Аккаунт Let's Encrypt: существующий, а если его нет — регистрация нового.
ACCOUNT_ARGS=()
choose_account() {
	local ids=() used
	[[ -d $ACCOUNTS ]] && mapfile -t ids < <(find "$ACCOUNTS" -mindepth 1 -maxdepth 1 -type d -printf '%f\n')
	if ((${#ids[@]} == 0)); then
		if [[ -n ${CERTBOT_EMAIL:-} ]]; then
			ACCOUNT_ARGS=(--email "$CERTBOT_EMAIL")
		else
			ACCOUNT_ARGS=(--register-unsafely-without-email)
		fi
		say "аккаунта Let's Encrypt нет — certbot зарегистрирует новый"
	elif ((${#ids[@]} > 1)); then
		# Несколько аккаунтов: тот, которым продлеваются остальные сертификаты.
		used=$(awk -F' *= *' '$1 == "account" { print $2 }' "$RENEWAL"/*.conf 2>/dev/null | sort | uniq -c | sort -rn | awk 'NR == 1 { print $2 }' || true)
		[[ -n $used && -d $ACCOUNTS/$used ]] || used=${ids[0]}
		ACCOUNT_ARGS=(--account "$used")
		say "аккаунт Let's Encrypt: $used"
	fi
}

# Webroot: отдаётся ли по адресу $1 проверочный файл из $WEBROOT. $2 — число попыток
# с паузой в секунду: reload nginx асинхронный, новые процессы стартуют не сразу.
challenge_served() {
	local base=$1 tries=$2 name value got="" i
	name=perepev-probe-$RANDOM$RANDOM
	value=$(openssl rand -hex 16)
	printf '%s' "$value" >"$WEBROOT/.well-known/acme-challenge/$name"
	for ((i = 0; i < tries; i++)); do
		got=$(curl -sS --max-time 10 -H "Host: $DOMAIN" "$base/.well-known/acme-challenge/$name" 2>/dev/null || true)
		[[ $got == "$value" ]] && break
		sleep 1
	done
	rm -f "$WEBROOT/.well-known/acme-challenge/$name"
	[[ $got == "$value" ]]
}

if cert_ok; then
	openssl x509 -in "$LIVE/cert.pem" -noout -ext subjectAltName | grep -E "DNS:${DOMAIN//./\\.}(,|[[:space:]]*$)" >/dev/null ||
		die "сертификат $CERT_NAME есть, но не содержит $DOMAIN"
	say "сертификат $CERT_NAME уже есть, действует до $(openssl x509 -in "$LIVE/cert.pem" -noout -enddate | cut -d= -f2)"
else
	method=${ACME_METHOD:-auto}
	case $method in
	auto)
		if has_cf_plugin && { [[ -n ${CF_CREDENTIALS:-} ]] || find_cf_credentials; }; then
			method=dns-cloudflare
		else
			method=webroot
		fi
		;;
	dns-cloudflare)
		has_cf_plugin || die "не установлен плагин certbot dns-cloudflare (apt install python3-certbot-dns-cloudflare)"
		[[ -n ${CF_CREDENTIALS:-} ]] || find_cf_credentials ||
			die "не найден ключ Cloudflare для зоны $ZONE — укажи CF_CREDENTIALS=/путь/к/cloudflare.ini"
		;;
	webroot) ;;
	*) die "ACME_METHOD: auto, dns-cloudflare или webroot (получено «$method»)" ;;
	esac
	choose_account
	common=(--cert-name "$CERT_NAME" -d "$DOMAIN" --non-interactive --agree-tos --keep-until-expiring
		--deploy-hook "systemctl reload nginx" "${ACCOUNT_ARGS[@]}")

	if [[ $method == dns-cloudflare ]]; then
		[[ -r ${CF_CREDENTIALS:-} ]] || die "файл ключа Cloudflare не читается: ${CF_CREDENTIALS:-}"
		say "получаю сертификат через DNS-01 (Cloudflare), это около минуты"
		certbot certonly --dns-cloudflare --dns-cloudflare-credentials "$CF_CREDENTIALS" \
			--dns-cloudflare-propagation-seconds "${CF_PROPAGATION:-60}" "${common[@]}" ||
			die "certbot не выдал сертификат (DNS-01); подробности: /var/log/letsencrypt/letsencrypt.log"
	else
		say "сертификата нет: ставлю временный блок порта 80 для проверки домена"
		cat >"$TMP/http-only.conf" <<-EOF
			# Временный блок install-site.sh: только проверка домена certbot (HTTP-01).
			server {
			    listen 80;
			    listen [::]:80;
			    server_name $DOMAIN;
			    access_log off;
			    location ^~ /.well-known/acme-challenge/ {
			        root $WEBROOT;
			        default_type text/plain;
			        try_files \$uri =404;
			    }
			    location / {
			        return 404;
			    }
			}
		EOF
		apply_conf "$TMP/http-only.conf" "временный блок HTTP-01"
		challenge_served http://127.0.0.1 15 || die "nginx не отдаёт файлы из $WEBROOT на порту 80"
		if [[ ${SKIP_HTTP_PROBE:-0} != 1 ]] && ! challenge_served "http://$DOMAIN" 1; then
			die "http://$DOMAIN/.well-known/acme-challenge/ приходит не в этот nginx (внешний порт 80 ведёт на другое устройство?). Используй ACME_METHOD=dns-cloudflare или, если уверен, SKIP_HTTP_PROBE=1"
		fi
		say "получаю сертификат через HTTP-01 (webroot $WEBROOT)"
		certbot certonly --webroot -w "$WEBROOT" "${common[@]}" ||
			die "certbot не выдал сертификат (HTTP-01); подробности: /var/log/letsencrypt/letsencrypt.log"
	fi
	cert_ok || die "certbot завершился, но $LIVE/fullchain.pem не появился"
	say "сертификат $CERT_NAME получен"
fi

# ---- Сайт ----
if ((HAD_LINK)) && [[ ${TOUCHED} -eq 0 ]] && cmp -s "$TEMPLATE" "$SITE_FILE"; then
	say "сайт уже установлен, файл не изменился — nginx не перезагружаю"
else
	apply_conf "$TEMPLATE" "сайт $DOMAIN"
fi
TOUCHED=0 # дальше только проверки, откатывать нечего

# ---- Проверки ----
# Запрос через этот nginx с проверкой сертификата; несколько попыток — reload асинхронный.
for _ in 1 2 3 4 5; do
	rc=0
	code=$(curl -sS --max-time 10 -o "$TMP/health" -w '%{http_code}' --resolve "$DOMAIN:443:127.0.0.1" \
		"https://$DOMAIN/api/health" 2>"$TMP/curl.err") || rc=$?
	[[ $code == 200 ]] && break
	sleep 1
done
if [[ $code == 200 ]]; then
	say "https://$DOMAIN/api/health: 200 $(head -c 200 "$TMP/health")"
elif ((rc == 60)); then
	warn "сертификат не прошёл проверку curl: $(cat "$TMP/curl.err")"
else
	warn "https://$DOMAIN/api/health через этот nginx: код $code. Проверь контейнеры: docker compose -p perepev ps"
fi

if [[ -d /run/systemd/system ]]; then
	if systemctl is-active --quiet certbot.timer; then
		say "certbot.timer активен — продление автоматическое"
	else
		warn "certbot.timer не активен: systemctl enable --now certbot.timer"
	fi
fi

if [[ ${SKIP_DRY_RUN:-0} != 1 ]]; then
	say "проверяю продление сертификата (certbot renew --dry-run, тестовый сервер Let's Encrypt)"
	if certbot renew --cert-name "$CERT_NAME" --dry-run --no-random-sleep-on-renew >"$TMP/dry-run.log" 2>&1; then
		say "продление работает"
	else
		tail -n 20 "$TMP/dry-run.log" >&2
		warn "пробное продление не прошло; сайт установлен, но разберись до истечения сертификата"
	fi
fi

say "готово: https://$DOMAIN/"
