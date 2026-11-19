# Build the static site, then serve it with the node server
# (static files + /ws multiplayer socket). No secrets are baked in:
# UNLOCK_TOKEN / ALLOW_IPS come from your host's secret store at runtime.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build
# private/ is optional and git-ignored; make sure the folder exists so the
# COPY below works either way
RUN mkdir -p private

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
COPY server.js ./
# GOTCHA: this runtime stage copies things EXPLICITLY. Any new top-level
# folder the server reads at runtime must be added here, or the server
# starts fine and silently behaves as if the folder were empty.
COPY --from=build /app/private ./private
EXPOSE 8080
CMD ["node", "server.js"]
