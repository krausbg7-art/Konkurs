FROM node:22-bookworm-slim
# ffmpeg converts uploaded videos (iPhone HEVC/HDR → H.264 MP4); Debian's build includes
# zscale/tonemap for HDR. ffprobe checks the length.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
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
