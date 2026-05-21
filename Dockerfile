FROM node:20-alpine

# Cài đặt các công cụ cần thiết để build các thư viện Node.js (như lamejs, v.v.)
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./

# Cài đặt production dependencies
RUN npm ci --only=production

# Xóa các công cụ build để giảm dung lượng image
RUN apk del python3 make g++

COPY . .

RUN mkdir -p temp_audio && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "start"]
