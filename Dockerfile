FROM apify/actor-node-playwright-chrome:18

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --omit=dev

COPY . .

CMD ["npm", "start"]
