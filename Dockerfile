# CDK 兑换系统 · 生产镜像
#   docker build -t avanfinity-cdk .
#   配置见 .env.example，部署说明见 docs/deploy.md
# Node 24 直接运行 TypeScript、内置 SQLite，不需要编译步骤

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data \
    BACKUP_DIR=/backups
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY web ./web
COPY scripts/backup.ts scripts/create-admin.ts scripts/db-copy.ts ./scripts/
# 数据（SQLite 数据库）和备份放在卷里；容器以非 root 用户运行
RUN mkdir -p /data /backups && chown -R node:node /data /backups
USER node
VOLUME ["/data", "/backups"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
# 直接用 node 启动（不经过 npm），docker stop 的 SIGTERM 才能送到进程，进行中的事务会先结束再退出
CMD ["node", "--no-warnings", "server/main.ts"]
