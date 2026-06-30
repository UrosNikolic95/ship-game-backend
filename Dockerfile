# --- Build stage: install all deps and compile TypeScript to dist/ ---
FROM node:24-alpine AS build
WORKDIR /app

# Install dependencies based on the lockfile for reproducible builds.
COPY package.json package-lock.json ./
RUN npm ci

# Compile the NestJS app.
COPY . .
RUN npm run build

# --- Production stage: ship only prod deps and compiled output ---
FROM node:24-alpine AS production
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Run as the unprivileged user that the node image ships with.
USER node

EXPOSE 3001
CMD ["node", "dist/main"]
