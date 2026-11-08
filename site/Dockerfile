# The PhoneDesk website, served by nginx on port 8080 (deployed with Dokploy).
# Build from the repository root:  docker build -f site/Dockerfile -t phonedesk-site .
# The site is generated from CHANGELOG.md and docs/changelog, so it needs those from the root.

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json CHANGELOG.md ./
COPY server/changelog.js server/
COPY public/favicon.svg public/
COPY public/dashboard/fonts public/dashboard/fonts
COPY docs/changelog docs/changelog
COPY site site
RUN node site/build.js

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY site/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/site/dist /usr/share/nginx/html
EXPOSE 8080
