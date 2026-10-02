ARG NODE_VERSION=24.21.0
ARG DOCKER_CLI_VERSION=27.5.1

# json-c-dev 已包含静态库；构建阶段不进入宿主命名空间。
FROM alpine:3.22 AS host-bridge
RUN apk add --no-cache build-base json-c-dev
WORKDIR /build
COPY tools/host-bridge/bridge.c tools/host-bridge/bridge.h tools/host-bridge/control.c ./
RUN cc -std=c11 -O2 -Wall -Wextra -Werror -static bridge.c control.c -ljson-c -o m7a-host-bridge \
    && ./m7a-host-bridge --version

# 仅复制静态 CLI，不带 daemon；保留与 Docker Engine 20.10 的 API 协商。
# Docker 27 已停止维护，固定此版本是兼容性取舍，不应设置 DOCKER_API_VERSION。
FROM docker:${DOCKER_CLI_VERSION}-cli AS docker-cli

FROM node:${NODE_VERSION}-alpine3.23 AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:${NODE_VERSION}-alpine3.23 AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="March7thAssistant Web" \
      org.opencontainers.image.description="Linux 上的三月七助手非官方配置面板" \
      org.opencontainers.image.source="https://github.com/cchanlan/march7thassistant-web" \
      org.opencontainers.image.url="https://github.com/cchanlan/march7thassistant-web" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.licenses="GPL-3.0-only"
ENV NODE_ENV=production \
    HOST=127.0.0.1 \
    PORT=18077 \
    M7A_CONTAINER=1 \
    M7A_HOST_BRIDGE=/usr/local/bin/m7a-host-bridge \
    M7A_STATE_DIR=/var/lib/march7th-web \
    M7A_SEARCH_ROOTS=/root \
    PM2_HOME=/root/.pm2 \
    M7A_HOST_UID=0
WORKDIR /app
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=host-bridge /build/m7a-host-bridge /usr/local/bin/m7a-host-bridge
COPY tools/host-bridge/NOTICE tools/host-bridge/LICENSE /usr/share/licenses/march7th-host-bridge/
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json package-lock.json server.mjs LICENSE ./
COPY metadata/ ./metadata/
COPY public/ ./public/
COPY src/ ./src/
COPY tools/reset-password.mjs ./tools/reset-password.mjs
RUN mkdir -p /var/lib/march7th-web \
    && chmod 700 /var/lib/march7th-web \
    && node --check server.mjs \
    && docker --version \
    && m7a-host-bridge --version
USER 0:0
STOPSIGNAL SIGTERM
# 只查登录会话状态，不登录、不发现目标；通配监听地址转换为回环访问。
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "const http=require('node:http');const host=process.env.HOST||'127.0.0.1';const hostname=host==='0.0.0.0'?'127.0.0.1':host==='::'?'::1':host;const req=http.get({hostname,port:Number(process.env.PORT||18077),path:'/api/session',timeout:4000},res=>{res.resume();if(res.statusCode!==200)process.exitCode=1;});req.on('timeout',()=>req.destroy(new Error('timeout')));req.on('error',()=>{process.exitCode=1;});"]
# exec 形式确保 Docker State.Pid 就是 Node；host PID 模式不使用 tini/init。
ENTRYPOINT ["node", "server.mjs"]
