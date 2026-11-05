FROM node:22-alpine
# ffprobe checks the length of uploaded videos
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY assets ./assets
COPY index.html konkurs.css konkurs.js ./
ENV NODE_ENV=production PORT=3000 VIDEO_DIR=/data/videos
RUN mkdir -p /data/videos && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
