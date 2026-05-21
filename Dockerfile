FROM node:20-alpine

# Cài đặt công cụ build cần thiết
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY package*.json ./

# Cài đặt production dependencies
RUN npm ci --only=production

# Xóa công cụ build sau khi cài xong để image nhẹ
RUN apk del python3 make g++

COPY . .

RUN mkdir -p temp_audio && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["npm", "start"]
