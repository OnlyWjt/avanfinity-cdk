# CDK 兑换系统

对接 Avanfinity 卡台的 CDK 兑换系统：生成兑换码 → 买家在兑换页兑换 → 系统按「兑换策略」检查后调用卡台开通 ChatGPT / X Premium / Telegram Premium。自带商城（卡网）：在线支付、自动发货、优惠券、买家账户、代理分销。

- **管理后台** `/admin/`：总览、CDK 管理、生成、兑换记录（审核 / 重试 / 释放）、兑换策略、售价与利润、成功率分析、支付流水、Webhook、设置、主题与品牌
- **兑换页** `/`（或 `/redeem`）、**凭证查询** `/receipt.html`、**商城** `/shop/`
- 不展示虚拟卡、不提供充值；卡台钱包只读显示可用余额（后台侧栏和生成页）；支付流水不含卡号

## 运行要求

- Docker（推荐），或者 Node.js **24+**（直接运行 TypeScript，无需编译）
- 数据库三选一：**SQLite**（默认，不需要额外服务）、**PostgreSQL** 13+、**MySQL** 8.0+
- 一台有固定出口 IP 的服务器（卡台写接口要求 IP 白名单）

## 部署

完整说明（Docker Compose、直接运行、反向代理、备份恢复、换数据库、上线检查清单）见 **[docs/deploy.md](docs/deploy.md)**。

**Docker Compose（推荐）**

```bash
cp .env.example .env              # 至少填 MASTER_KEY、PUBLIC_URL
docker compose up -d              # SQLite
docker compose --profile postgres up -d                    # 带 PostgreSQL
docker compose --profile mysql up -d                       # 带 MySQL
docker compose --profile postgres --profile caddy up -d    # 再加自动 HTTPS
```

**直接运行**

```bash
npm install --omit=dev
cp .env.example .env              # 填写 PUBLIC_URL、MASTER_KEY；用 PG / MySQL 再填 DATABASE_URL
npm start
```

首次打开 `https://你的域名/admin/` 会提示创建第一个管理员，然后：

1. **设置 → 卡台 API**：填卡台地址、App-Id、App-Secret，点「测试连接」
2. 卡台控制台里给 API Key 开权限（少一个对应的功能就用不了，「测试连接」会逐个检查读权限），并把服务器出口 IP 加入白名单：
   - 读：`cdk:read`、`gpt:read`、`x-direct:read`、`tg-direct:read`、`products:read`、`cards:read`、`account:read`（显示卡台余额）
   - 写：`cdk:purchase`、`gpt:write`、`x-direct:write`、`tg-direct:write`
3. **Webhook**：把页面上的接收地址填到卡台控制台，把卡台给的 `whsec_…` 签名密钥填回来，点「发送自检事件」
4. **设置 → X / Telegram 付款通道**：选一个卡产品（X/TG 兑换时卡台自动开卡付款）
5. **兑换策略**：默认策略是自有码；按需新建，比如「淘宝渠道 · 严格」
6. **生成 CDK**，把码发给买家

运维要点：
- **MASTER_KEY 必须在 `.env` 里设置**：`PUBLIC_URL` 是 https 或 `NODE_ENV=production` 时，没设置会拒绝启动。它要和数据库备份**分开**保存
- **只能跑一个实例**：限流、兑换锁、事务互斥、用户 Session 都在进程内存里，不要开多个容器副本、不要用 pm2 cluster
- **HTTPS**：放在 Nginx / Caddy 后面（或用 compose 的 caddy profile），`.env` 里设置 `TRUST_PROXY=1`（套了 Cloudflare 则设为 `cf`）、`COOKIE_SECURE=1`，`PUBLIC_URL` 填外网 https 地址（支付回调要用）
- **健康检查**：`GET /healthz`，正常返回 `{"ok":true}`
- **备份**：SQLite 用 `npm run backup`（在线快照，不要直接复制运行中的数据库文件）；PostgreSQL / MySQL 用 `pg_dump` / `mysqldump`。命令见 docs/deploy.md
- **命令行建管理员 / 重置密码**：`npm run admin:create -- 邮箱 密码`（Docker：`docker compose exec app npm run admin:create -- 邮箱 密码`）

## 通知

设置 → Telegram 通知：填 Bot Token（找 @BotFather 创建）和 Chat ID，可推送：
- 兑换需要关注（失败 / 待审核 / 需处理），每分钟合并一条
- GPT 平台库存低于阈值，同一套餐 6 小时内只提醒一次
- 商城动态：新成交、发货失败、代理申请、提现申请，每分钟合并一条
- 每日 9 点报告（兑换成功、拦截、利润，商城成交和毛利）

## 商城（卡网）

买家在商城付款 → 系统按商品绑定的策略自动生成兑换码发货 → 订单页显示兑换码，同时发邮件，点「去兑换」直接打开兑换页并填好码。

- **前台**：商城 `/shop/`、订单页、查询订单（邮箱 / 订单号 + 查询密码）、买家中心 `/account/`、代理中心 `/agent/`、代理分站 `/s/店铺地址`
- **后台 → 商城**：商品、商城订单（重新发货 / 补发邮件 / 手动确认收款 / 退款）、优惠券、代理分销（审核 / 等级 / 提现）、客户（余额调整 / 停用）
- **首页**：设置 → 商城里可以把网站首页切换成商城，兑换页移到 `/redeem`

上线步骤：
1. 设置 → 商城：开启商城、填名称和公告
2. 设置 → 支付：至少配一个渠道，保存后显示「✓ 可用」才会出现在前台
3. 设置 → 邮件：填 SMTP，点「发送测试邮件」确认能收到（不配置也能卖，只是不发邮件、不能邮件找回密码）
4. 商城 → 商品：新建商品，选套餐、发货策略、零售价、代理基础价、库存

| 支付渠道 | 需要的资料 | 说明 |
|---|---|---|
| 易支付 | 接口地址、商户 ID、商户密钥 | 彩虹易支付等通用协议，跳转收银台；可开支付宝 / 微信 / QQ 等子方式 |
| 支付宝官方 | APPID、应用私钥、支付宝公钥 | 公钥模式 RSA2；当面付出二维码，或网站支付跳转收银台 |
| 微信支付官方 | 商户号、AppID、证书序列号、API 私钥、APIv3 密钥、微信支付公钥 ID 和公钥 | APIv3 Native 扫码，微信支付公钥验签模式 |
| USDT（TRC20） | 收款地址、汇率 | 固定地址 + 随机尾数识别订单，每 15 秒查 TronGrid 到账，不需要第三方 |

资金安全：价格、优惠、库存都在服务端计算；回调必须验签且金额一致才入账（不一致会拒绝并记录）；平台流水号唯一，重复回调只入账一次；回调丢失时后台会主动查单；超时关单后才到账的订单照常发货。异步通知地址是 `{PUBLIC_URL}/api/pay/notify/{epay|alipay|wechat}`，所以 `PUBLIC_URL` 必须是外网能访问的 https 地址。

代理分销（三种可同时用）：
- **分站自定价**：代理在 `/s/店铺地址` 按自己的售价卖，利润 = 售价 − 进货价
- **推广返佣**：主站链接带 `?ref=店铺地址`，按主站价成交，佣金 = 实付 × 等级佣金比例（默认 30 天内归因）
- **批发进货**：代理按进货价买一批码自己卖；进货价 = 商品代理基础价 × 等级批发折扣

收益先冻结（默认 3 天）再转为可提现，退款会自动冲回；提现由管理员线下打款后在后台标记。

几个需要知道的规则：
- **退款**：后台退款会作废兑换码、冲回代理收益；余额支付的自动退回余额，其他渠道需要你在支付平台手动退钱。有码已经兑换、或是卡台 GPT 码（卡台没有撤销接口）时会先提示再确认
- **重复付款**：买家两个渠道都付了钱时，只发一次货，另一笔标记为「重复付款」，在商城订单和总览里提醒你退款
- **注册不认领旧订单**：注册不验证邮箱，所以免注册时买的订单不会自动归到同邮箱的账户里（防止别人用你的邮箱注册看到兑换码），这些订单仍用查询密码查
- **USDT 迟到**：订单超时后 15 分钟内到账的转账照样匹配发货；金额对不上任何订单的转账会记在日志里，需要人工核对

## 主题与品牌

后台 → 主题与品牌：17 套预设主题（默认「票根」：墨蓝 + 票面蓝 + 印泥红，标题用内置的得意黑），也可以自己组合背景（票面 / 极光 / 流光 / 网格 / 点阵 / 纯色）、卡片质感（纸面 / 玻璃 / 实色 / 描边 / 浮雕）、字体气质（票根 / 现代 / 圆润 / 宋体 / 科技）、主按钮和形状、配色、圆角、模糊和光晕；可以上传 Logo 图片（同时用作网站图标，并能「从 Logo 取色」）、改标语和商城副标题、写自定义 CSS。右侧直接嵌入真实的商城页和兑换页预览（电脑 / 手机），点「保存并发布」后才对买家生效。

## 自有码 vs 托管码

| | 自有码（推荐） | 托管码 |
|---|---|---|
| 买家拿到的码 | 本系统生成，如 `TB-7K2Q-F9WM-3TXA` | 卡台原始码 `AVF-…` / `XCDK-…` |
| 卡台码什么时候生成 | 买家兑换时临时生成，买家看不到 | 生成批次时 |
| 策略能否被绕过 | 不能 | 买家可以直接去卡台兑换，绕过策略 |
| 失败自动重试 | 支持 | 不支持（卡台释放码，用户自己重兑） |

## 兑换策略能做什么

- **我方控制**（随时可改）：IP / 设备频率、码有效期、兑换时段、拦截地区、同一账号限兑次数、只允许 Free 账号、邮箱域名黑白名单、价格保护（拦截 / 转人工 / 放行）、失败自动重试或转人工
- **生成时写入批次**：X/TG 单码成本上限、GPT 每码独立支付、GPT 结账地区
- **卡台强制**（改不了）：报价有效期、报价频率、一次性令牌、账号资格判定

说明：
- 「同一账号」对 ChatGPT 按 Session 里的账号 ID 计算（只存哈希）；对 X/TG 按用户名
- 用户粘贴的 ChatGPT Session 只放在内存里 30 分钟（用于自动重试 / 审核通过后继续），不写入数据库
- 拦截地区需要部署在 Cloudflare 后面（读取 `CF-IPCountry`）

## GPT 点数（Credits）

所有 GPT 兑换都走卡台 CDK（订阅套餐和点数一样）。点数是充值到买家 ChatGPT 账号的额度，不改变订阅：

- 固定面额 250 / 1000 / 2500 / 5000 点，也可以在生成页、商品编辑里填自定义点数（250–9999999）
- **只能用自有码策略**：卡台只能为自己账户生成点数 CDK（买家兑换时才生成），托管码策略生成或上架会被拒绝
- 生成免费，买家兑换时按所选结账地区当时的点数报价扣费；点数和地区在生成时固定。所以后台显示的成本是按套餐目录估算的（自定义点数按最接近的固定面额单价折算），价格保护也按这个估算比较
- 策略里的「只允许 Free 账号」对点数不生效（已订阅的账号也可以充点数）；兑换页显示「充值成功」，没有自动续费

## 本地开发与测试

```bash
npm install
npm run mock                    # 本地模拟卡台 http://localhost:8090（App-Id app_mock / Secret sk_mock）
DATA_DIR=data-dev npm run dev   # 系统 http://localhost:8080
node --no-warnings scripts/seed-shop.ts  # 本地体验：开商城、接模拟支付、建示例商品（需先有管理员）
npm test                        # 先类型检查，再在随机空闲端口 + 独立数据目录上跑接口、扩展、商城、GPT 点数与地区、浏览器五套测试（约 5 分钟）
                                # 通过后自动删除数据目录，失败时保留并打印路径；KEEP_TEST_DATA=1 总是保留（截图在里面的 shots/）
SKIP_UI=1 npm test              # 没有 Chrome 时跳过浏览器测试
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/cdk_test npm test   # 在 PostgreSQL 上跑（会清空这个库，库名必须含 test）
TEST_DATABASE_URL=mysql://user:pass@localhost:3306/cdk_test npm test      # 在 MySQL 上跑
npm run typecheck
```

模拟卡台的失败场景：GPT Session 邮箱含 `decline` → 拒付；含 `expired` → Session 无效；`"plan":"plus"` → 已是会员；X/TG 用户名含 `prem` → 已是会员。模拟卡台同时提供四种支付网关（易支付 / 支付宝 / 微信 / TronGrid），密钥见 `GET http://localhost:8090/mock/pay/keys`，收银台上点「模拟支付成功」即可走完付款回调。

## 接入真实卡台前需要核对

卡台文档对 **GPT 公开兑换接口**（`/api/public/cdk/*`）的返回字段没有给出固定结构，系统按文档描述做了兼容解析，集中在 `server/avan/normalize.ts`。接上真实卡台后，先用一张便宜套餐（如 Go）完整兑换一次，在「兑换记录」详情里确认账号、报价、进度显示正常；如果字段名不同，只需要改这一个文件。

## 目录

```
server/
  main.ts               入口、路由挂载、后台任务
  db.ts                 数据库接口（SQLite / PostgreSQL / MySQL），写 SQL 的规则见 docs/database.md
  db/                   三种数据库的驱动、表结构与迁移
  avan/client.ts        卡台 API 客户端
  avan/normalize.ts     GPT 公开兑换接口字段兼容
  services/redeem.ts    兑换引擎（状态机、重试、审核）
  services/strategy.ts  兑换策略与规则评估
  services/batches.ts   生成 / 导出 / 撤销
  services/webhook.ts   Webhook 验签与支付流水
  services/shop.ts      商城：下单、入账、发货、退款
  services/pay/         支付渠道（易支付、支付宝、微信 v3、USDT）
  services/agents.ts    代理分销与收益
  services/coupons.ts   优惠券
  services/customers.ts 买家账户与余额
  services/mail.ts      SMTP 邮件
  routes/shop.ts        商城 / 买家 / 代理接口、支付回调
  routes/admin-shop.ts  商城后台接口
  mock/avan-mock.ts     本地模拟卡台
  mock/pay-mock.ts      模拟支付网关
web/                    前端页面（兑换页、后台、shop/ 商城、account/ 买家中心、agent/ 代理中心）
cdk-design/             设计稿与原型
docs/                   部署（deploy.md）、数据库开发（database.md）、卡台 API 变更分析等文档
Dockerfile              生产镜像；docker-compose.yml 一键部署（可选 PostgreSQL / MySQL / Caddy）
```
