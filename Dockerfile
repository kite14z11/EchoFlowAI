# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# GEMINI_API_KEY をビルド時に .env へ書き込み、Vite が loadEnv で読み込めるようにする
ARG GEMINI_API_KEY
RUN echo "GEMINI_API_KEY=${GEMINI_API_KEY}" > .env
RUN npm run build

# Stage 2: Serve with nginx
FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
