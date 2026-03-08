FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src/ ./src/
RUN npx tsc && chmod 755 build/index.js
ENTRYPOINT ["node", "build/index.js"]
