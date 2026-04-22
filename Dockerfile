FROM ghcr.io/puppeteer/puppeteer:23.10.0

WORKDIR /home/pptruser/app

COPY --chown=pptruser:pptruser package*.json ./
RUN npm install --omit=dev

COPY --chown=pptruser:pptruser . .

EXPOSE 10000
CMD ["node", "index.js"]
