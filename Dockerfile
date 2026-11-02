# Stage 1: Build the React frontend using Vite
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Stage 2: Serve the backend API and built static assets
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --only=production
COPY server/ ./server/
COPY --from=builder /app/dist ./dist

# Create database folder structure for persistent volumes
RUN mkdir -p server/data

ENV NODE_ENV=production
ENV API_PORT=5174

EXPOSE 5174

CMD ["node", "server/index.js"]
