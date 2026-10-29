# 部署

支持三种方式，任选其一：

| 方式 | 适合 |
|---|---|
| [Docker Compose](#docker-compose推荐) | 推荐。一条命令拉起应用，可选带上 PostgreSQL / MySQL / 自动 HTTPS |
| [直接运行](#直接运行nodejs) | 服务器上已经有 Node.js 24、反向代理 |
| [单独的 Docker 镜像](#单独使用镜像) | 已经有自己的编排（K8s、宝塔、1Panel 等） |

无论哪种方式，**只能跑一个实例**：接口限流、兑换锁、事务互斥都在进程内存里，开多个副本会出现重复扣款这类问题。用 PostgreSQL / MySQL 时，应用启动会先拿一把数据库锁，同一个库上第二个实例会等最多 2 分钟（等旧实例退出），还拿不到就报错退出；SQLite 的数据在本机文件里，不会被别的机器共用。

---

## 准备工作（所有方式都要做）

1. 一台有**固定出口 IP** 的服务器，把这个 IP 加进卡台 API Key 的白名单（卡台写接口要求）
2. 一个域名，解析到这台服务器（支付平台回调、邮件链接、Webhook 都需要外网能访问的 https 地址）
3. 生成主密钥并**单独保管**（丢了已加密的兑换码、卡台密钥都解不开）：
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   # 没装 Node 的机器：openssl rand -hex 32
   ```
4. `cp .env.example .env`，至少填好：

   | 配置 | 值 |
   |---|---|
   | `MASTER_KEY` | 上一步生成的 64 位十六进制 |
   | `PUBLIC_URL` | `https://你的域名` |
   | `TRUST_PROXY` | 在 Nginx / Caddy 后面填 `1`；在 Cloudflare 后面填 `cf` |
   | `COOKIE_SECURE` | `1` |
   | `DATABASE_URL` | 留空用 SQLite；用 PostgreSQL / MySQL 见下面 |

---

## 选哪个数据库

| | SQLite（默认） | PostgreSQL | MySQL |
|---|---|---|---|
| 额外服务 | 不需要，一个文件 | 需要 | 需要 |
| 适合 | 单机，日均几千单以内 | 已有 PG 运维习惯、想用托管数据库（RDS 等） | 已有 MySQL 运维习惯 |
| 备份 | `npm run backup`（在线快照） | `pg_dump` | `mysqldump` |
| 版本要求 | Node 自带 | 13+（实测 18.4） | MySQL 8.0+（实测 8.4）；MariaDB 10.6+ 理论可用、未实测 |

三种数据库功能完全一样，同一套测试在三种数据库上都跑通。之后想换，可以用 `scripts/db-copy.ts` 搬数据（见[换数据库](#换数据库)）。

`DATABASE_URL` 写法：

```bash
# 留空 = SQLite，文件在 DATA_DIR/cdk.db
DATABASE_URL=postgres://用户:密码@主机:5432/库名
DATABASE_URL=mysql://用户:密码@主机:3306/库名
```

- 密码里有 `@ : / # ?` 等字符要做 URL 编码（`@` 写成 `%40`），或者干脆只用字母数字
- PostgreSQL 需要 SSL 时在后面加 `?sslmode=require`
- MySQL 的库要用 `utf8mb4` 字符集：`CREATE DATABASE cdk CHARACTER SET utf8mb4;`
- 表结构在第一次启动时自动创建，之后升级版本时自动迁移，不需要手动建表
- 数据库账号需要建表权限（第一次启动和升级时用）

---

## Docker Compose（推荐）

需要 Docker 24+ 和 Docker Compose v2.20+。

### 最简单：SQLite + 宿主机反向代理

```bash
git clone <仓库地址> cdk && cd cdk
cp .env.example .env     # 按「准备工作」填好
docker compose up -d
docker compose logs -f app    # 看到「已启动」就好了
```

应用只监听本机的 `127.0.0.1:8080`，宿主机上的 Nginx / Caddy 把域名反代到它即可（Nginx 示例见下文）。

### 带上 PostgreSQL 或 MySQL

在 `.env` 里加：

```bash
DB_PASSWORD=换成一个长的随机密码（只用字母数字）
# PostgreSQL：
DATABASE_URL=postgres://cdk:同上的DB_PASSWORD@postgres:5432/cdk
# 或 MySQL（还要 DB_ROOT_PASSWORD）：
# DATABASE_URL=mysql://cdk:同上的DB_PASSWORD@mysql:3306/cdk
# DB_ROOT_PASSWORD=另一个随机密码
```

```bash
docker compose --profile postgres up -d     # 或 --profile mysql
```

数据库容器不对外暴露端口，只有应用能连。应用启动时如果数据库还没就绪，会每 2 秒重试，最多约 1 分钟。

### 自动 HTTPS（不想自己配 Nginx）

```bash
# .env
DOMAIN=cdk.example.com
PUBLIC_URL=https://cdk.example.com
TRUST_PROXY=1
COOKIE_SECURE=1
```

```bash
docker compose --profile caddy up -d                     # SQLite
docker compose --profile postgres --profile caddy up -d  # PostgreSQL
```

Caddy 会自动申请并续期证书，需要 80 / 443 端口没被占用、域名已经解析过来。

### 第一次登录

打开 `https://你的域名/admin/`，按提示创建第一个管理员。也可以用命令行（忘记密码时同样用它重置）：

```bash
docker compose exec app npm run admin:create -- admin@example.com 一个强密码
```

然后按 README 的「部署」一节配置卡台 API、Webhook 等。

### 升级

```bash
git pull
docker compose build app
docker compose up -d        # 加上原来用的 --profile
```

启动时自动迁移数据库结构。**升级前先备份。**

从带「GPT 直充」的旧版本升级：新版本去掉了直充，升级时会删除直充账本（`direct_spend` 表）和资金护栏设置。如果还有没出结果的直充，程序会拒绝升级并提示，数据库不变；先用旧版本在「兑换记录」里等它们结束或人工核对，再升级。用直充策略生成、还没兑换的码，升级后会改走卡台 CDK 兑换。

### 常用命令

```bash
docker compose ps                    # 状态（app 显示 healthy 才算正常）
docker compose logs -f app           # 日志
docker compose restart app           # 重启（会等进行中的事务结束）
docker compose exec app sh           # 进容器
```

---

## 直接运行（Node.js）

需要 Node.js **24+**（直接运行 TypeScript，不用编译）。

```bash
npm install --omit=dev
cp .env.example .env        # 按「准备工作」填好
npm start
```

用 systemd 守护（**不要用 pm2 cluster 模式**，pm2 的 fork 模式可以）：

```ini
# /etc/systemd/system/cdk.service
[Unit]
Description=CDK 兑换系统
After=network-online.target

[Service]
WorkingDirectory=/srv/cdk
ExecStart=/usr/bin/node --no-warnings server/main.ts
Restart=always
User=cdk
Environment=NODE_ENV=production
KillSignal=SIGTERM
TimeoutStopSec=15

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now cdk
```

### Nginx 反向代理示例

```nginx
server {
    listen 443 ssl http2;
    server_name cdk.example.com;
    # ssl_certificate / ssl_certificate_key ...

    client_max_body_size 2m;   # 主题里的 Logo 图片
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # 想用「拦截地区」：用 GeoIP 模块把国家代码填进 X-Country-Code
    }
}
```

`.env` 里 `TRUST_PROXY=1`。

---

## 单独使用镜像

```bash
docker build -t avanfinity-cdk .
docker run -d --name cdk --restart unless-stopped \
  --env-file .env -e NODE_ENV=production \
  -v cdk-data:/data -v cdk-backups:/backups \
  -p 127.0.0.1:8080:8080 \
  avanfinity-cdk
```

- 容器以非 root 用户（node，uid 1000）运行，数据在 `/data`，备份在 `/backups`
- 健康检查：`GET /healthz`，返回 `{"ok":true}`。数据库连不上，或者有事务卡住超过 60 秒（这时所有写入都在排队），返回 503。事务卡住超过 5 分钟，进程会自己退出，交给重启策略拉起（Docker Compose 不会因为健康检查失败自动重启容器）
- 停止时发 `SIGTERM`，应用会停止接新请求、等进行中的事务结束再退出（最多 10 秒）
- K8s 等编排里 `replicas` 必须是 1，更新策略用 `Recreate`。用滚动更新的话，新实例会等旧实例退出、拿到数据库锁才启动，不会两个同时跑，但更新会慢
- 容器内固定监听 `0.0.0.0:8080`，`.env` 里的 `HOST` / `PORT` 在 Docker 里不生效；宿主机端口用 `-p` 或 Compose 的 `APP_PORT` 改

---

## 备份与恢复

**`MASTER_KEY` 要和数据备份分开保存。** 备份里的兑换码、密钥是用它加密的：只有备份没有密钥等于没备份；两样放在一起，备份泄露就等于全部泄露。

### SQLite

```bash
npm run backup                                  # 直接运行
docker compose exec app npm run backup          # Docker：备份在 cdk-backups 卷里
```

在线生成一致的快照并做完整性检查，默认保留最近 14 份（`BACKUP_KEEP` 调整）。**不要直接复制运行中的 `cdk.db`**（WAL 模式下可能拿到损坏的文件）。

每天定时备份（宿主机 crontab）：
```cron
0 4 * * * cd /srv/cdk && docker compose exec -T app npm run backup >> /var/log/cdk-backup.log 2>&1
```

恢复：停掉服务，把备份文件换成数据目录里的 `cdk.db`（同时删掉旁边的 `cdk.db-wal`、`cdk.db-shm`），再启动。

把备份拷到别的机器：
```bash
docker compose cp app:/backups ./backups-$(date +%F)
```

### PostgreSQL

```bash
# 备份（Docker Compose 自带的 PostgreSQL）
docker compose exec -T postgres pg_dump -U cdk -Fc cdk > cdk-$(date +%F).dump
# 恢复到空库
docker compose stop app
docker compose exec -T postgres pg_restore -U cdk -d cdk --clean --if-exists < cdk-2026-10-29.dump
docker compose start app
```

自己的 / 托管的 PostgreSQL：用 `pg_dump "$DATABASE_URL" -Fc`，或者用云厂商的自动备份。

### MySQL

```bash
# 备份
docker compose exec -T mysql sh -c 'mysqldump -u cdk -p"$MYSQL_PASSWORD" --single-transaction --routines cdk' > cdk-$(date +%F).sql
# 恢复
docker compose stop app
docker compose exec -T mysql sh -c 'mysql -u cdk -p"$MYSQL_PASSWORD" cdk' < cdk-2026-10-29.sql
docker compose start app
```

---

## 换数据库

把现有数据（例如 SQLite）完整复制到新的 PostgreSQL / MySQL：

```bash
# 1. 停服务，备份
# 2. 准备一个空的目标库
# 3. 复制（两边用同一个 MASTER_KEY，所以在原来的目录、原来的 .env 下运行）
FROM_DATABASE_URL=sqlite:data/cdk.db \
TO_DATABASE_URL=postgres://cdk:密码@localhost:5432/cdk \
node --no-warnings scripts/db-copy.ts
# 4. 把 .env 的 DATABASE_URL 改成目标库，启动
```

- 目标库必须是空的（脚本会先建表，发现有数据就拒绝执行）
- 源库或目标库是 PostgreSQL / MySQL 时，有应用实例连着它就拒绝执行（检查实例锁）。源库是 SQLite 时检查不了，务必先停服务
- 整个复制在一个事务里，失败会全部回滚；完成后逐表核对行数
- Docker 里运行：`docker compose run --rm -e FROM_DATABASE_URL=sqlite:/data/cdk.db -e TO_DATABASE_URL=postgres://cdk:密码@postgres:5432/cdk app node --no-warnings scripts/db-copy.ts`

---

## 上线检查清单

- [ ] `MASTER_KEY` 已设置，并且已经单独备份
- [ ] `PUBLIC_URL` 是外网能访问的 https 地址；`TRUST_PROXY`、`COOKIE_SECURE=1` 已设置
- [ ] 只有一个应用实例在跑
- [ ] `https://你的域名/healthz` 返回 `{"ok":true}`
- [ ] 卡台：API Key 权限、出口 IP 白名单、Webhook 地址和签名密钥（后台「Webhook」页可以发自检事件）
- [ ] 每日备份已经加进定时任务，并且试过一次恢复
- [ ] 用一张最便宜的码（Go 或 250 点数）真实兑换一次，核对卡台扣款和到账
